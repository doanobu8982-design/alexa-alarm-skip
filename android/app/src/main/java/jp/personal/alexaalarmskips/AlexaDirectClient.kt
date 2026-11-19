package jp.personal.alexaalarmskips

import okhttp3.FormBody
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

data class FetchResult(
    val ok: Boolean,
    val refreshedCookie: Boolean,
    val alarmsPayloadJson: JSONObject,
    val widgetSummaryJson: JSONObject
)

class AlexaAuthException(
    message: String,
    val statusCode: Int = 401
) : Exception(message)

class AlexaDirectClient(
    private val cookieFile: File,
    private val client: OkHttpClient = defaultOkHttpClient(),
    private val nowProvider: () -> Long = { System.currentTimeMillis() },
    private val alexaApiUrlOverride: String? = null
) {
    private data class RecurrenceRule(
        val freq: String,
        val days: Set<Int>
    )

    private data class TimeOfDay(
        val hours: Int,
        val minutes: Int,
        val seconds: Int
    )

    private data class TimeParts(
        val timeText: String,
        val dayBadge: String,
        val dateLabel: String,
        val dateKey: String,
        val whenText: String
    )

    private data class AlarmCandidate(
        val notification: JSONObject,
        val whenMs: Long,
        val scheduledMs: Long
    )

    private data class HttpResponseData(
        val statusCode: Int,
        val body: String,
        val allHeaders: List<Headers>,
        val redirectedToSignIn: Boolean
    )

    fun hasValidCookieFile(): Boolean {
        if (!cookieFile.exists() || !cookieFile.isFile) return false
        return try {
            val json = JSONObject(cookieFile.readText(Charsets.UTF_8))
            val hasLocal = json.optString("localCookie", "").isNotBlank() ||
                json.optString("cookie", "").isNotBlank()
            val hasRefresh = json.optString("refreshToken", "").isNotBlank()
            hasLocal || hasRefresh
        } catch (_: Exception) {
            false
        }
    }

    fun needsTokenRefresh(cookieJson: JSONObject, nowMs: Long = nowProvider()): Boolean {
        val localCookie = cookieJson.optString("localCookie", "")
        val csrf = cookieJson.optString("csrf", "")
        if (localCookie.isBlank() || csrf.isBlank()) {
            return true
        }
        val tokenDate = cookieJson.optLong("tokenDate", 0L)
        if (tokenDate <= 0L) {
            return true
        }
        return (nowMs - tokenDate) >= COOKIE_REFRESH_INTERVAL_MS
    }

    fun fetchAccessToken(cookieJson: JSONObject): String {
        val loginCookieInitial = cookieJson.optString("loginCookie", "")
        val refreshToken = cookieJson.optString("refreshToken", "")
        if (loginCookieInitial.isBlank() || refreshToken.isBlank()) {
            throw AlexaAuthException("No former registration data provided for Cookie Refresh", 401)
        }

        val baseAmazonPage = DEFAULT_BASE_AMAZON_PAGE
        val acceptLanguage = DEFAULT_ACCEPT_LANGUAGE
        val deviceAppName = cookieJson.optString("deviceAppName", "").ifBlank { DEFAULT_APP_NAME }

        // Step 1: POST https://api.${baseAmazonPage}/auth/token
        val step1Body = FormBody.Builder(Charsets.UTF_8)
            .add("app_name", deviceAppName)
            .add("app_version", API_CALL_VERSION)
            .add("di.sdk.version", "6.12.4")
            .add("source_token", refreshToken)
            .add("package_name", "com.amazon.echo")
            .add("di.hw.version", "iPhone")
            .add("platform", "iOS")
            .add("requested_token_type", "access_token")
            .add("source_token_type", "refresh_token")
            .add("di.os.name", "iOS")
            .add("di.os.version", "16.6")
            .add("current_version", "6.12.4")
            .build()

        val step1Req = Request.Builder()
            .url("https://api.$baseAmazonPage/auth/token")
            .post(step1Body)
            .header("User-Agent", API_CALL_USER_AGENT)
            .header("Accept-Language", acceptLanguage)
            .header("Accept-Charset", "utf-8")
            .header("Connection", "keep-alive")
            .header("Cookie", loginCookieInitial)
            .header("Accept", "application/json")
            .header("x-amzn-identity-auth-domain", "api.$baseAmazonPage")
            .build()

        val loginCookieMap = parseCookieMap(loginCookieInitial)
        val step1Res = executeWithRedirects(step1Req, loginCookieMap)
        if (step1Res.redirectedToSignIn || step1Res.statusCode == 401 || step1Res.statusCode == 403) {
            throw AlexaAuthException("Token refresh rejected with HTTP ${step1Res.statusCode}", step1Res.statusCode)
        }

        val step1Json = try {
            JSONObject(step1Res.body)
        } catch (e: Exception) {
            throw AlexaAuthException("Failed to parse token refresh response: ${e.message}", step1Res.statusCode)
        }
        val accessToken = step1Json.optString("access_token", "")
        if (accessToken.isBlank()) {
            throw AlexaAuthException("No new access token in Refresh Token response", step1Res.statusCode)
        }
        return accessToken
    }

    fun refreshCookieData(cookieJson: JSONObject): JSONObject {
        val loginCookieInitial = cookieJson.optString("loginCookie", "")
        val refreshToken = cookieJson.optString("refreshToken", "")
        if (loginCookieInitial.isBlank() || refreshToken.isBlank()) {
            throw AlexaAuthException("No former registration data provided for Cookie Refresh", 401)
        }

        val amazonPage = cookieJson.optString("amazonPage", "").ifBlank { DEFAULT_AMAZON_PAGE }
        val baseAmazonPage = DEFAULT_BASE_AMAZON_PAGE
        val acceptLanguage = DEFAULT_ACCEPT_LANGUAGE
        val deviceAppName = cookieJson.optString("deviceAppName", "").ifBlank { DEFAULT_APP_NAME }
        val browserUserAgent = cookieJson.optString("userAgent", "").ifBlank { BROWSER_USER_AGENT }

        val accessToken = fetchAccessToken(cookieJson)
        val loginCookieMap = parseCookieMap(loginCookieInitial)

        // Step 2: POST https://www.${baseAmazonPage}/ap/exchangetoken/cookies
        val comCookies = exchangeLocalCookies(
            targetDomain = baseAmazonPage,
            refreshToken = refreshToken,
            deviceAppName = deviceAppName,
            acceptLanguage = acceptLanguage
        )

        val mergedLoginCookies = LinkedHashMap<String, String>()
        loginCookieMap["frc"]?.let { mergedLoginCookies["frc"] = it }
        loginCookieMap["map-md"]?.let { mergedLoginCookies["map-md"] = it }
        mergedLoginCookies.putAll(comCookies)
        val updatedLoginCookie = sanitizeAmazonCookie(mergedLoginCookies)

        // Step 3: PUT https://api.amazonalexa.com/v1/devices/@self/capabilities
        registerTokenCapabilities(accessToken, acceptLanguage)

        // Step 4: POST https://www.${amazonPage}/ap/exchangetoken/cookies
        val localCookiesMap = exchangeLocalCookies(
            targetDomain = amazonPage,
            refreshToken = refreshToken,
            deviceAppName = deviceAppName,
            acceptLanguage = acceptLanguage
        )
        val sanitizedLocalMap = sanitizeAmazonCookieMap(localCookiesMap)

        // Step 5: GET https://alexa.${amazonPage}${path} for CSRF
        var csrfToken = sanitizedLocalMap["csrf"].orEmpty()
        if (csrfToken.isBlank()) {
            for (path in CSRF_PATHS) {
                val cookieHeader = formatCookieMap(sanitizedLocalMap)
                val csrfReq = Request.Builder()
                    .url("https://alexa.$amazonPage$path")
                    .get()
                    .header("DNT", "1")
                    .header("User-Agent", browserUserAgent)
                    .header("Connection", "keep-alive")
                    .header("Referer", "https://alexa.$amazonPage/spa/index.html")
                    .header("Origin", "https://alexa.$amazonPage")
                    .header("Accept", "*/*")
                    .header("Cookie", cookieHeader)
                    .build()

                val csrfRes = executeWithRedirects(csrfReq, sanitizedLocalMap)
                if (csrfRes.redirectedToSignIn) {
                    throw AlexaAuthException("Redirected to sign-in while obtaining CSRF", 401)
                }
                val candidateCsrf = sanitizedLocalMap["csrf"].orEmpty()
                if (candidateCsrf.isNotBlank()) {
                    csrfToken = candidateCsrf
                    break
                }
            }
        }

        if (csrfToken.isBlank()) {
            throw AlexaAuthException("CSRF token not found", 401)
        }

        val finalLocalCookie = sanitizeAmazonCookie(sanitizedLocalMap)
        val updated = JSONObject(cookieJson.toString())
        updated.put("localCookie", finalLocalCookie)
        updated.put("cookie", finalLocalCookie)
        updated.put("csrf", csrfToken)
        updated.put("loginCookie", updatedLoginCookie)
        updated.put("accessToken", accessToken)
        updated.put("amazonPage", amazonPage)
        updated.put("tokenDate", nowProvider())
        updated.put("dataVersion", 2)
        updated.remove("authorization_code")
        updated.remove("verifier")
        return updated
    }

    fun fetchAndBuildSummary(forceRefresh: Boolean = false, persistCookie: Boolean = true): FetchResult {
        if (!cookieFile.exists() || !cookieFile.isFile) {
            throw AlexaAuthException("Cookie file not found", 401)
        }

        var cookieJson = try {
            JSONObject(cookieFile.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            throw AlexaAuthException("Failed to read cookie file: ${e.message}", 401)
        }

        var refreshed = false
        if (forceRefresh || needsTokenRefresh(cookieJson)) {
            cookieJson = refreshCookieData(cookieJson)
            refreshed = true
            if (persistCookie) {
                atomicWriteJson(cookieFile, cookieJson)
            }
        }

        val (notifications, devices) = try {
            fetchNotificationsAndDevices(cookieJson)
        } catch (authEx: AlexaAuthException) {
            if (refreshed) {
                throw authEx
            }
            cookieJson = refreshCookieData(cookieJson)
            refreshed = true
            if (persistCookie) {
                atomicWriteJson(cookieFile, cookieJson)
            }
            fetchNotificationsAndDevices(cookieJson)
        }

        val nowMs = nowProvider()
        val (alarmsPayload, widgetSummary) = classifyAndBuildPayload(notifications, devices, nowMs)
        return FetchResult(
            ok = true,
            refreshedCookie = refreshed,
            alarmsPayloadJson = alarmsPayload,
            widgetSummaryJson = widgetSummary
        )
    }

    fun skipAlarm(
        job: JSONObject,
        mockUrl: String? = null,
        persistCookie: Boolean = true
    ): Boolean {
        val alarmId = job.optString("alarmId", "").ifBlank { job.optString("id", "") }
        if (alarmId.isBlank()) {
            throw IllegalArgumentException("alarmId is required for skipAlarm")
        }
        if (!mockUrl.isNullOrBlank()) {
            val body = JSONObject().apply {
                put("id", alarmId)
                put("notificationIndex", alarmId)
            }
            executeMockPost("${mockUrl.trimEnd('/')}/api/alarms/skip", body)
            return true
        }

        val type = job.optString("type", "Alarm")
        return executeWithAuthApi(persistCookie) { amazonPage, localCookie, csrf, userAgent, alexaApiUrl, accessToken ->
            if (isAlarmType(type)) {
                executeAuthApiPut(
                    baseUrl = alexaApiUrl,
                    path = "/v1/alerts/alarms/$alarmId/nextOccurrence/cancel",
                    accessToken = accessToken,
                    jsonBody = null
                )
            } else {
                val reminderBody = JSONObject().apply {
                    put("id", alarmId)
                    put("status", "INSTANCE_CANCELED")
                }
                executeAlexaApiPut(
                    url = "https://alexa.$amazonPage/api/notifications/$alarmId",
                    amazonPage = amazonPage,
                    localCookie = localCookie,
                    csrf = csrf,
                    userAgent = userAgent,
                    jsonBody = reminderBody.toString()
                )
            }
        }
    }

    fun restoreAlarm(
        job: JSONObject,
        mockUrl: String? = null,
        persistCookie: Boolean = true,
        restoreWaitMs: Long = 500L
    ): Boolean {
        val alarmId = job.optString("alarmId", "").ifBlank { job.optString("id", "") }
        if (alarmId.isBlank()) {
            throw IllegalArgumentException("alarmId is required for restoreAlarm")
        }
        if (!mockUrl.isNullOrBlank()) {
            val body = JSONObject().apply {
                put("id", alarmId)
                put("notificationIndex", alarmId)
                put("originalDate", job.optString("originalDate", ""))
                put("originalTime", job.optString("originalTime", ""))
            }
            executeMockPost("${mockUrl.trimEnd('/')}/api/alarms/restore", body)
            return true
        }

        val type = job.optString("type", "Alarm")
        val (targetDate, targetTime) = resolveRestoreDateTime(job, nowProvider())
        val musicAlarmId = job.optString("musicAlarmId", "")
        val soundId = job.optString("soundId", "")
        val assetId = if (musicAlarmId.isNotBlank()) "MUSIC-$musicAlarmId" else soundId

        return executeWithAuthApi(persistCookie) { _, _, _, _, alexaApiUrl, accessToken ->
            executeAuthApiPut(
                baseUrl = alexaApiUrl,
                path = "/v1/alerts/alarms/$alarmId/cancel",
                accessToken = accessToken,
                jsonBody = ""
            )
            if (restoreWaitMs > 0L) {
                Thread.sleep(restoreWaitMs)
            }
            if (isAlarmType(type) && assetId.isNotBlank() && targetDate.isNotBlank() && targetTime.isNotBlank()) {
                val timePart = if (targetTime.length >= 8) targetTime.substring(0, 8) else targetTime
                val trigger = JSONObject().apply {
                    put("scheduledTime", "${targetDate}T${timePart}")
                }
                val recurrence = buildV2Recurrence(job.optString("recurringPattern", ""))
                if (recurrence != null) {
                    trigger.put("recurrence", recurrence)
                }
                val payload = JSONObject().apply {
                    put("trigger", trigger)
                    put("extensions", JSONArray())
                    put("assets", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "TONE")
                            put("assetId", assetId)
                        })
                    })
                }
                executeAuthApiPut(
                    baseUrl = alexaApiUrl,
                    path = "/v1/alerts/alarms/$alarmId",
                    accessToken = accessToken,
                    jsonBody = payload.toString()
                )
            } else {
                executeAuthApiPut(
                    baseUrl = alexaApiUrl,
                    path = "/v1/alerts/alarms/$alarmId/activate",
                    accessToken = accessToken,
                    jsonBody = ""
                )
            }
        }
    }

    private fun executeWithAuthApi(
        persistCookie: Boolean,
        block: (
            amazonPage: String,
            localCookie: String,
            csrf: String,
            userAgent: String,
            alexaApiUrl: String,
            accessToken: String
        ) -> Unit
    ): Boolean {
        if (!cookieFile.exists() || !cookieFile.isFile) {
            throw AlexaAuthException("Cookie file not found", 401)
        }
        var cookieJson = try {
            JSONObject(cookieFile.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            throw AlexaAuthException("Failed to read cookie file: ${e.message}", 401)
        }

        var refreshed = false
        if (needsTokenRefresh(cookieJson)) {
            cookieJson = refreshCookieData(cookieJson)
            refreshed = true
            if (persistCookie) {
                atomicWriteJson(cookieFile, cookieJson)
            }
        } else if (cookieJson.optString("accessToken", "").isBlank()) {
            val fetchedToken = fetchAccessToken(cookieJson)
            cookieJson = JSONObject(cookieJson.toString()).apply {
                put("accessToken", fetchedToken)
            }
            if (persistCookie) {
                atomicWriteJson(cookieFile, cookieJson)
            }
        }

        fun runOnce(cj: JSONObject) {
            val amazonPage = cj.optString("amazonPage", "").ifBlank { DEFAULT_AMAZON_PAGE }
            val localCookie = cj.optString("localCookie", "").ifBlank { cj.optString("cookie", "") }
            val csrf = cj.optString("csrf", "")
            val userAgent = cj.optString("userAgent", "").ifBlank { BROWSER_USER_AGENT }
            val accessToken = cj.optString("accessToken", "")
            if (localCookie.isBlank() || csrf.isBlank() || accessToken.isBlank()) {
                throw AlexaAuthException("Missing localCookie, csrf, or accessToken", 401)
            }
            val alexaApiUrl = alexaApiUrlOverride?.takeIf { it.isNotBlank() }
                ?: fetchEndpointsAlexaApiUrl(amazonPage, localCookie, csrf, userAgent)
            block(amazonPage, localCookie, csrf, userAgent, alexaApiUrl, accessToken)
        }

        try {
            runOnce(cookieJson)
        } catch (authEx: AlexaAuthException) {
            if (refreshed) throw authEx
            cookieJson = refreshCookieData(cookieJson)
            if (persistCookie) {
                atomicWriteJson(cookieFile, cookieJson)
            }
            runOnce(cookieJson)
        }
        return true
    }

    private fun fetchEndpointsAlexaApiUrl(
        amazonPage: String,
        localCookie: String,
        csrf: String,
        userAgent: String
    ): String {
        val body = executeAlexaApiGet(
            url = "https://alexa.$amazonPage/api/endpoints",
            amazonPage = amazonPage,
            localCookie = localCookie,
            csrf = csrf,
            userAgent = userAgent
        )
        val json = try {
            JSONObject(body)
        } catch (e: Exception) {
            throw AlexaAuthException("Invalid endpoints response", 401)
        }
        val apiUrl = json.optString("alexaApiUrl", "")
        if (apiUrl.isBlank()) {
            throw IllegalStateException("alexaApiUrl missing in /api/endpoints response")
        }
        return apiUrl.trimEnd('/')
    }

    private fun executeAuthApiPut(
        baseUrl: String,
        path: String,
        accessToken: String,
        jsonBody: String?
    ) {
        val fullUrl = "${baseUrl.trimEnd('/')}$path"
        val host = URI(fullUrl).host ?: ""
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = (jsonBody ?: "").toRequestBody(mediaType)
        val req = Request.Builder()
            .url(fullUrl)
            .put(body)
            .header("authorization", accessToken)
            .header("authority", host)
            .header("user-agent", API_CALL_USER_AGENT)
            .header("Content-Type", "application/json; charset=utf-8")
            .build()

        client.newCall(req).execute().use { res ->
            if (res.code == 401 || res.code == 403) {
                throw AlexaAuthException("Alexa Auth API failed (HTTP ${res.code})", res.code)
            }
            if (res.code < 200 || res.code >= 300) {
                throw IllegalStateException("Alexa Auth API request failed with HTTP ${res.code}")
            }
        }
    }

    private fun executeAlexaApiPut(
        url: String,
        amazonPage: String,
        localCookie: String,
        csrf: String,
        userAgent: String,
        jsonBody: String
    ) {
        val cookieMap = parseCookieMap(localCookie)
        val body = jsonBody.toRequestBody("application/json; charset=utf-8".toMediaType())
        val req = Request.Builder()
            .url(url)
            .put(body)
            .header("Cookie", localCookie)
            .header("csrf", csrf)
            .header("User-Agent", userAgent)
            .header("Accept", "application/json; charset=utf-8")
            .header("Referer", "https://alexa.$amazonPage/spa/index.html")
            .header("Origin", "https://alexa.$amazonPage")
            .build()
        val res = executeWithRedirects(req, cookieMap)
        if (res.redirectedToSignIn || res.statusCode == 401 || res.statusCode == 403) {
            throw AlexaAuthException("Alexa API authentication failed (HTTP ${res.statusCode})", res.statusCode)
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw IllegalStateException("Alexa API request failed with HTTP ${res.statusCode}")
        }
    }

    private fun executeMockPost(url: String, payload: JSONObject) {
        val body = payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        val req = Request.Builder()
            .url(url)
            .post(body)
            .header("Content-Type", "application/json; charset=utf-8")
            .build()
        client.newCall(req).execute().use { res ->
            if (res.code == 401 || res.code == 403) {
                throw AlexaAuthException("Mock API auth failed (HTTP ${res.code})", res.code)
            }
            if (res.code < 200 || res.code >= 300) {
                throw IllegalStateException("Mock API request failed with HTTP ${res.code}")
            }
        }
    }

    private fun buildV2Recurrence(pattern: String?): JSONObject? {
        if (pattern.isNullOrBlank()) return null
        if (pattern == "P1D") {
            return JSONObject().apply {
                put("freq", "DAILY")
                put("interval", 1)
            }
        }
        if (pattern == "XXXX-WD") {
            return JSONObject().apply {
                put("freq", "WEEKLY")
                put("interval", 1)
                put("byDay", JSONArray(listOf("MO", "TU", "WE", "TH", "FR")))
            }
        }
        if (pattern == "XXXX-WE") {
            return JSONObject().apply {
                put("freq", "WEEKLY")
                put("interval", 1)
                put("byDay", JSONArray(listOf("SA", "SU")))
            }
        }
        val m = WXX_PATTERN_REGEX.matchEntire(pattern)
        if (m != null) {
            val codes = listOf("MO", "TU", "WE", "TH", "FR", "SA", "SU")
            val dayIdx = m.groupValues[1].toInt() - 1
            return JSONObject().apply {
                put("freq", "WEEKLY")
                put("interval", 1)
                put("byDay", JSONArray(listOf(codes[dayIdx])))
            }
        }
        return null
    }

    private fun resolveRestoreDateTime(job: JSONObject, nowMs: Long): Pair<String, String> {
        val desiredDate = job.optString("originalDate", "")
        val desiredTime = job.optString("originalTime", "")
        if (desiredDate.isNotBlank() && desiredTime.isNotBlank()) {
            val desiredMs = parseTimestampMs("${desiredDate}T${desiredTime}")
            if (desiredMs != null && desiredMs > nowMs - PAST_GRACE_MS) {
                return Pair(desiredDate, desiredTime)
            }
        }
        val expMs = computeExpectedNextMs(job, nowMs)
        if (expMs != null) {
            val timeStr = desiredTime.ifBlank { formatJstTimeWithMs(expMs) }
            return Pair(jstDateKey(expMs), timeStr)
        }
        var dateStr = desiredDate
        val timeStr = desiredTime.ifBlank { "07:00:00.000" }
        if (dateStr.isNotBlank()) {
            val curMs = parseTimestampMs("${dateStr}T${timeStr}")
            if (curMs != null && curMs < nowMs) {
                dateStr = jstDateKey(curMs + WINDOW_MS)
            }
        }
        return Pair(dateStr, timeStr)
    }

    fun classifyAndBuildPayload(
        notifications: JSONArray,
        devices: JSONArray,
        nowMs: Long
    ): Pair<JSONObject, JSONObject> {
        val deviceMap = buildDeviceMap(devices)
        val minMs = nowMs - PAST_GRACE_MS
        val maxMs = nowMs + WINDOW_MS

        val activeCandidates = mutableListOf<AlarmCandidate>()
        val skippedCandidates = mutableListOf<AlarmCandidate>()

        for (i in 0 until notifications.length()) {
            val n = notifications.optJSONObject(i) ?: continue
            val type = n.optString("type", "")
            if (!isAlarmType(type)) continue
            if (n.optString("status", "") != "ON") continue
            val scheduledMs = nextTriggerMs(n) ?: continue

            val expectedNextMs = computeExpectedNextMs(n, nowMs)
            val isSkipped = expectedNextMs != null && scheduledMs > (expectedNextMs + PAST_GRACE_MS)
            if (isSkipped) {
                skippedCandidates.add(AlarmCandidate(n, expectedNextMs!!, scheduledMs))
                continue
            }

            if (scheduledMs > minMs && scheduledMs <= maxMs) {
                activeCandidates.add(AlarmCandidate(n, scheduledMs, scheduledMs))
            }
        }

        activeCandidates.sortBy { it.whenMs }
        skippedCandidates.sortBy { it.whenMs }

        val activeArray = JSONArray()
        for (c in activeCandidates) {
            activeArray.put(serializeAlarm(c.notification, deviceMap, c.whenMs, nowMs, isSkipped = false, scheduledMs = c.scheduledMs))
        }

        val skippedArray = JSONArray()
        for (c in skippedCandidates) {
            skippedArray.put(serializeAlarm(c.notification, deviceMap, c.whenMs, nowMs, isSkipped = true, scheduledMs = c.scheduledMs))
        }

        val checkedAt = formatJstClock(nowMs)
        val widgetSummary = buildWidgetSummary(activeArray, checkedAt)

        val alarmsPayload = JSONObject().apply {
            put("active", activeArray)
            put("skipped", skippedArray)
            put("deviceCount", deviceMap.size)
            put("checkedAt", checkedAt)
            put("widgetSummary", widgetSummary)
        }

        return Pair(alarmsPayload, widgetSummary)
    }

    private fun fetchNotificationsAndDevices(cookieJson: JSONObject): Pair<JSONArray, JSONArray> {
        val amazonPage = cookieJson.optString("amazonPage", "").ifBlank { DEFAULT_AMAZON_PAGE }
        val localCookie = cookieJson.optString("localCookie", "")
            .ifBlank { cookieJson.optString("cookie", "") }
        val csrf = cookieJson.optString("csrf", "")
        if (localCookie.isBlank() || csrf.isBlank()) {
            throw AlexaAuthException("Missing localCookie or csrf", 401)
        }
        val browserUserAgent = cookieJson.optString("userAgent", "").ifBlank { BROWSER_USER_AGENT }

        val notifBody = executeAlexaApiGet(
            url = "https://alexa.$amazonPage/api/notifications",
            amazonPage = amazonPage,
            localCookie = localCookie,
            csrf = csrf,
            userAgent = browserUserAgent
        )
        val notifJson = try {
            JSONObject(notifBody)
        } catch (e: Exception) {
            throw AlexaAuthException("Invalid notifications response (possibly login HTML)", 401)
        }
        val notifications = notifJson.optJSONArray("notifications") ?: JSONArray()

        val devBody = executeAlexaApiGet(
            url = "https://alexa.$amazonPage/api/devices-v2/device?cached=false",
            amazonPage = amazonPage,
            localCookie = localCookie,
            csrf = csrf,
            userAgent = browserUserAgent
        )
        val devices = try {
            val trimmed = devBody.trim()
            if (trimmed.startsWith("[")) {
                JSONArray(trimmed)
            } else {
                JSONObject(trimmed).optJSONArray("devices") ?: JSONArray()
            }
        } catch (e: Exception) {
            throw AlexaAuthException("Invalid devices response (possibly login HTML)", 401)
        }

        return Pair(notifications, devices)
    }

    private fun executeAlexaApiGet(
        url: String,
        amazonPage: String,
        localCookie: String,
        csrf: String,
        userAgent: String
    ): String {
        val cookieMap = parseCookieMap(localCookie)
        val req = Request.Builder()
            .url(url)
            .get()
            .header("Cookie", localCookie)
            .header("csrf", csrf)
            .header("User-Agent", userAgent)
            .header("Accept", "application/json; charset=utf-8")
            .header("Accept-Language", DEFAULT_ACCEPT_LANGUAGE)
            .header("Referer", "https://alexa.$amazonPage/spa/index.html")
            .header("Origin", "https://alexa.$amazonPage")
            .build()

        val res = executeWithRedirects(req, cookieMap)
        if (res.redirectedToSignIn || res.statusCode == 401 || res.statusCode == 403) {
            throw AlexaAuthException("Alexa API authentication failed (HTTP ${res.statusCode})", res.statusCode)
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw IllegalStateException("Alexa API request failed with HTTP ${res.statusCode}")
        }
        if (isHtmlLoginPage(res.body)) {
            throw AlexaAuthException("Alexa API returned login page HTML", 401)
        }
        return res.body
    }

    private fun exchangeLocalCookies(
        targetDomain: String,
        refreshToken: String,
        deviceAppName: String,
        acceptLanguage: String
    ): LinkedHashMap<String, String> {
        val formBody = FormBody.Builder(Charsets.UTF_8)
            .add("di.os.name", "iOS")
            .add("app_version", API_CALL_VERSION)
            .add("domain", ".$targetDomain")
            .add("source_token", refreshToken)
            .add("requested_token_type", "auth_cookies")
            .add("source_token_type", "refresh_token")
            .add("di.hw.version", "iPhone")
            .add("di.sdk.version", "6.12.4")
            .add("app_name", deviceAppName)
            .add("di.os.version", "16.6")
            .build()

        val req = Request.Builder()
            .url("https://www.$targetDomain/ap/exchangetoken/cookies")
            .post(formBody)
            .header("User-Agent", API_CALL_USER_AGENT)
            .header("Accept-Language", acceptLanguage)
            .header("Accept-Charset", "utf-8")
            .header("Connection", "keep-alive")
            .header("Accept", "*/*")
            .header("x-amzn-identity-auth-domain", "api.$targetDomain")
            .build()

        val cookieMap = LinkedHashMap<String, String>()
        val res = executeWithRedirects(req, cookieMap)
        if (res.redirectedToSignIn || res.statusCode == 401 || res.statusCode == 403) {
            throw AlexaAuthException("Cookie exchange rejected with HTTP ${res.statusCode}", res.statusCode)
        }

        val json = try {
            JSONObject(res.body)
        } catch (e: Exception) {
            throw AlexaAuthException("Failed to parse exchange response: ${e.message}", res.statusCode)
        }

        val tokensObj = json.optJSONObject("response")?.optJSONObject("tokens")
        val cookiesObj = tokensObj?.optJSONObject("cookies")
        val domainCookies = cookiesObj?.optJSONArray(".$targetDomain")
            ?: throw AlexaAuthException("No cookies for $targetDomain in Exchange response", res.statusCode)

        for (i in 0 until domainCookies.length()) {
            val c = domainCookies.optJSONObject(i) ?: continue
            val name = c.optString("Name", "")
            val value = c.optString("Value", "")
            if (name.isNotBlank()) {
                cookieMap[name] = value
            }
        }
        return cookieMap
    }

    private fun registerTokenCapabilities(accessToken: String, acceptLanguage: String) {
        if (accessToken.isBlank()) return
        try {
            val body = CAPABILITIES_JSON.toRequestBody("application/json; charset=UTF-8".toMediaType())
            val req = Request.Builder()
                .url("https://api.amazonalexa.com/v1/devices/@self/capabilities")
                .put(body)
                .header("User-Agent", API_CALL_USER_AGENT)
                .header("Accept-Language", acceptLanguage)
                .header("Accept-Charset", "utf-8")
                .header("Connection", "keep-alive")
                .header("Authorization", "Bearer $accessToken")
                .build()

            client.newCall(req).execute().use { /* Ignore non-fatal capability registration status */ }
        } catch (_: Exception) {
            // Non-fatal in alexa-cookie2
        }
    }

    private fun executeWithRedirects(
        initialRequest: Request,
        cookieMap: LinkedHashMap<String, String>
    ): HttpResponseData {
        var currentReq = initialRequest
        val collectedHeaders = mutableListOf<Headers>()
        var redirectedToSignIn = false

        for (hop in 0..MAX_REDIRECTS) {
            client.newCall(currentReq).execute().use { res ->
                collectedHeaders.add(res.headers)
                mergeSetCookies(cookieMap, res.headers.values("Set-Cookie"))

                if (res.code in 300..399) {
                    val location = res.header("Location")
                    if (location.isNullOrBlank()) {
                        val body = res.body?.string().orEmpty()
                        return HttpResponseData(res.code, body, collectedHeaders, redirectedToSignIn)
                    }
                    if (location.contains("/ap/signin", ignoreCase = true)) {
                        redirectedToSignIn = true
                    }
                    val resolvedUri = try {
                        URI(currentReq.url.toString()).resolve(location).toString()
                    } catch (_: Exception) {
                        location
                    }
                    val nextBuilder = Request.Builder()
                        .url(resolvedUri)
                        .get()
                    for (name in currentReq.headers.names()) {
                        if (!name.equals("Cookie", ignoreCase = true) &&
                            !name.equals("Content-Length", ignoreCase = true) &&
                            !name.equals("Content-Type", ignoreCase = true)
                        ) {
                            nextBuilder.header(name, currentReq.header(name).orEmpty())
                        }
                    }
                    if (cookieMap.isNotEmpty()) {
                        nextBuilder.header("Cookie", formatCookieMap(cookieMap))
                    }
                    currentReq = nextBuilder.build()
                } else {
                    val body = res.body?.string().orEmpty()
                    return HttpResponseData(res.code, body, collectedHeaders, redirectedToSignIn)
                }
            }
        }
        throw IllegalStateException("Too many redirects")
    }

    private fun atomicWriteJson(target: File, json: JSONObject) {
        val parent = target.parentFile
        if (parent != null && !parent.exists()) {
            parent.mkdirs()
        }
        val tmpFile = File(parent ?: File("."), "${target.name}.tmp")
        tmpFile.writeText(json.toString(2), Charsets.UTF_8)
        if (!tmpFile.renameTo(target)) {
            target.writeText(json.toString(2), Charsets.UTF_8)
            tmpFile.delete()
        }
    }

    private fun buildDeviceMap(devices: JSONArray): Map<String, String> {
        val map = LinkedHashMap<String, String>()
        for (i in 0 until devices.length()) {
            val d = devices.optJSONObject(i) ?: continue
            val serial = d.optString("serialNumber", "")
            if (serial.isBlank()) continue
            val name = d.optString("accountName", "")
                .ifBlank { d.optString("deviceName", "") }
                .ifBlank { serial }
            map[serial] = name
        }
        return map
    }

    private fun serializeAlarm(
        n: JSONObject,
        deviceMap: Map<String, String>,
        whenMs: Long,
        nowMs: Long,
        isSkipped: Boolean,
        scheduledMs: Long?
    ): JSONObject {
        val parts = formatTimeParts(whenMs, nowMs)
        val serial = n.optString("deviceSerialNumber", "")
        val rawOriginalDate = n.optString("originalDate", "")
        val rawOriginalTime = n.optString("originalTime", "")
        val effectiveDate = if (isSkipped) parts.dateKey else rawOriginalDate.ifBlank { parts.dateKey }
        val effectiveTime = rawOriginalTime.ifBlank { formatJstTimeWithMs(whenMs) }
        val recurringPattern = if (n.isNull("recurringPattern")) null else n.optString("recurringPattern", "").ifBlank { null }
        val notifIndex = n.optString("notificationIndex", "").ifBlank { n.optString("id", "") }
        val label = n.optString("alarmLabel", "")
            .ifBlank { n.optString("reminderLabel", "") }
            .ifBlank { n.optString("label", "") }
        val scheduledDate = rawOriginalDate.ifBlank {
            if (scheduledMs != null) jstDateKey(scheduledMs) else ""
        }

        return JSONObject().apply {
            put("id", notifIndex)
            put("notificationIndex", notifIndex)
            put("deviceSerialNumber", serial)
            put("deviceName", deviceMap[serial] ?: serial.ifBlank { "不明な端末" })
            put("type", n.optString("type", "Alarm").ifBlank { "Alarm" })
            put("status", n.optString("status", "ON").ifBlank { "ON" })
            put("label", label)
            put("recurringPattern", recurringPattern ?: JSONObject.NULL)
            put("recurringText", formatRecurring(recurringPattern))
            put("originalDate", effectiveDate)
            put("originalTime", effectiveTime)
            put("scheduledDate", scheduledDate)
            put("whenMs", whenMs)
            put("timeText", parts.timeText)
            put("dayBadge", parts.dayBadge)
            put("dateLabel", parts.dateLabel)
            put("dateKey", parts.dateKey)
            put("whenText", parts.whenText)
            put("isSkipped", isSkipped)
        }
    }

    private fun buildWidgetSummary(active: JSONArray, checkedAt: String): JSONObject {
        val hasAlarm = active.length() > 0
        val next = if (hasAlarm) active.optJSONObject(0) else null
        val nextAlarmObj = if (next != null) {
            JSONObject().apply {
                put("id", next.optString("id", ""))
                put("timeText", next.optString("timeText", ""))
                put("dayBadge", next.optString("dayBadge", ""))
                put("dateLabel", next.optString("dateLabel", ""))
                put("deviceName", next.optString("deviceName", ""))
                put("label", next.optString("label", ""))
                put("whenMs", next.optLong("whenMs", 0L))
            }
        } else {
            JSONObject.NULL
        }
        return JSONObject().apply {
            put("hasAlarm", hasAlarm)
            put("nextAlarm", nextAlarmObj)
            put("remainingCount", maxOf(0, active.length() - 1))
            put("totalCount", active.length())
            put("checkedAt", checkedAt)
        }
    }

    private fun isAlarmType(type: String): Boolean = type == "Alarm" || type == "MusicAlarm"

    private fun parseTimestampMs(raw: String?): Long? {
        if (raw.isNullOrBlank()) return null
        val s = raw.trim()
        val hasTz = TZ_SUFFIX_REGEX.containsMatchIn(s)
        val normalized = if (hasTz) {
            NO_COLON_TZ_REGEX.replace(s) { m -> "${m.groupValues[1]}:${m.groupValues[2]}" }
        } else {
            "${s}+09:00"
        }
        return try {
            OffsetDateTime.parse(normalized, DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                .toInstant()
                .toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    private fun nextTriggerMs(n: JSONObject): Long? {
        val triggerScheduled = n.optJSONObject("trigger")?.optString("scheduledTime", "")
        if (!triggerScheduled.isNullOrBlank()) {
            parseTimestampMs(triggerScheduled)?.let { return it }
        }
        val alarmTimeVal = n.opt("alarmTime")
        if (alarmTimeVal is String && alarmTimeVal.isNotBlank()) {
            parseTimestampMs(alarmTimeVal)?.let { return it }
        } else if (alarmTimeVal is Number && alarmTimeVal.toLong() > 0L) {
            return alarmTimeVal.toLong()
        }
        val origDate = n.optString("originalDate", "")
        val origTime = n.optString("originalTime", "")
        if (origDate.isNotBlank() && origTime.isNotBlank()) {
            parseTimestampMs("${origDate}T${origTime}")?.let { return it }
        }
        return null
    }

    private fun formatRecurring(pattern: String?): String {
        if (pattern.isNullOrBlank()) return "1回のみ"
        return RECURRING_LABELS[pattern] ?: pattern
    }

    private fun getRecurrenceRule(n: JSONObject): RecurrenceRule? {
        val pattern = if (n.isNull("recurringPattern")) "" else n.optString("recurringPattern", "")
        when (pattern) {
            "P1D" -> return RecurrenceRule("DAILY", setOf(0, 1, 2, 3, 4, 5, 6))
            "XXXX-WD" -> return RecurrenceRule("WEEKLY", setOf(1, 2, 3, 4, 5))
            "XXXX-WE" -> return RecurrenceRule("WEEKLY", setOf(0, 6))
        }
        val dayMatch = WXX_PATTERN_REGEX.matchEntire(pattern)
        if (dayMatch != null) {
            val isoDay = dayMatch.groupValues[1].toInt()
            return RecurrenceRule("WEEKLY", setOf(if (isoDay == 7) 0 else isoDay))
        }

        val trigRec = n.optJSONObject("trigger")?.optJSONObject("recurrence")
        if (trigRec != null) {
            val freq = trigRec.optString("freq", "")
            val interval = trigRec.optInt("interval", 1)
            if (freq.isNotBlank() && interval <= 1) {
                if (freq == "DAILY") {
                    return RecurrenceRule("DAILY", setOf(0, 1, 2, 3, 4, 5, 6))
                }
                if (freq == "WEEKLY") {
                    val byDay = trigRec.optJSONArray("byDay")
                    val days = extractJsDays(byDay)
                    if (days.isNotEmpty()) return RecurrenceRule("WEEKLY", days)
                }
            } else if (freq.isNotBlank() && interval > 1) {
                return null
            }
        }

        val rRule = n.optJSONObject("rRuleData")
        if (rRule != null) {
            val freq = rRule.optString("frequency", "")
            val intervals = rRule.optJSONArray("intervals")
            val interval = if (intervals != null && intervals.length() > 0) intervals.optInt(0, 1) else 1
            if (freq.isNotBlank() && interval <= 1) {
                if (freq == "DAILY") {
                    return RecurrenceRule("DAILY", setOf(0, 1, 2, 3, 4, 5, 6))
                }
                if (freq == "WEEKLY") {
                    val byWeekDays = rRule.optJSONArray("byWeekDays")
                    val days = extractJsDays(byWeekDays)
                    if (days.isNotEmpty()) return RecurrenceRule("WEEKLY", days)
                }
            } else if (freq.isNotBlank() && interval > 1) {
                return null
            }
        }

        return null
    }

    private fun extractJsDays(arr: JSONArray?): Set<Int> {
        if (arr == null || arr.length() == 0) return emptySet()
        val set = HashSet<Int>()
        for (i in 0 until arr.length()) {
            val code = arr.optString(i, "")
            WEEKDAY_TO_JS_DAY[code]?.let { set.add(it) }
        }
        return set
    }

    private fun extractAlarmTimeOfDay(n: JSONObject, fallbackMs: Long?): TimeOfDay? {
        val origTime = n.optString("originalTime", "")
        if (origTime.isNotBlank()) {
            val m = TIME_OF_DAY_REGEX.find(origTime)
            if (m != null) {
                return TimeOfDay(
                    hours = m.groupValues[1].toInt(),
                    minutes = m.groupValues[2].toInt(),
                    seconds = m.groupValues[3].ifBlank { "0" }.toInt()
                )
            }
        }
        if (fallbackMs != null) {
            val zdt = ZonedDateTime.ofInstant(Instant.ofEpochMilli(fallbackMs), JST_ZONE)
            return TimeOfDay(zdt.hour, zdt.minute, zdt.second)
        }
        return null
    }

    private fun computeExpectedNextMs(n: JSONObject, nowMs: Long): Long? {
        val rule = getRecurrenceRule(n) ?: return null
        val scheduledMs = nextTriggerMs(n)
        val tod = extractAlarmTimeOfDay(n, scheduledMs) ?: return null

        val jstNow = ZonedDateTime.ofInstant(Instant.ofEpochMilli(nowMs), JST_ZONE)
        val baseDate = jstNow.toLocalDate()

        for (offset in 0L..14L) {
            val candDate = baseDate.plusDays(offset)
            val jsDay = candDate.dayOfWeek.value % 7
            if (!rule.days.contains(jsDay)) continue
            val candZdt = ZonedDateTime.of(
                candDate.year,
                candDate.monthValue,
                candDate.dayOfMonth,
                tod.hours,
                tod.minutes,
                tod.seconds,
                0,
                JST_ZONE
            )
            val candMs = candZdt.toInstant().toEpochMilli()
            if (candMs > nowMs) {
                return candMs
            }
        }
        return null
    }

    private fun jstDateKey(epochMs: Long): String {
        val zdt = ZonedDateTime.ofInstant(Instant.ofEpochMilli(epochMs), JST_ZONE)
        return "%04d-%02d-%02d".format(zdt.year, zdt.monthValue, zdt.dayOfMonth)
    }

    private fun formatJstTimeWithMs(epochMs: Long): String {
        val zdt = ZonedDateTime.ofInstant(Instant.ofEpochMilli(epochMs), JST_ZONE)
        return "%02d:%02d:%02d.000".format(zdt.hour, zdt.minute, zdt.second)
    }

    private fun formatJstClock(epochMs: Long): String {
        val zdt = ZonedDateTime.ofInstant(Instant.ofEpochMilli(epochMs), JST_ZONE)
        return "%02d:%02d:%02d".format(zdt.hour, zdt.minute, zdt.second)
    }

    private fun formatTimeParts(whenMs: Long, nowMs: Long): TimeParts {
        val zdt = ZonedDateTime.ofInstant(Instant.ofEpochMilli(whenMs), JST_ZONE)
        val month = zdt.monthValue
        val day = zdt.dayOfMonth
        val weekday = WEEKDAYS_JA[zdt.dayOfWeek.value % 7]
        val timeText = "%02d:%02d".format(zdt.hour, zdt.minute)
        val whenText = "%d/%d/%d %s:%02d".format(zdt.year, month, day, timeText, zdt.second)

        val jstNow = ZonedDateTime.ofInstant(Instant.ofEpochMilli(nowMs), JST_ZONE)
        val todayKey = jstDateKey(nowMs)
        val tomorrowKey = "%04d-%02d-%02d".format(
            jstNow.toLocalDate().plusDays(1).year,
            jstNow.toLocalDate().plusDays(1).monthValue,
            jstNow.toLocalDate().plusDays(1).dayOfMonth
        )
        val targetKey = jstDateKey(whenMs)

        var dateLabel = "$month/$day ($weekday)"
        var dayBadge = "$month/$day ($weekday)"
        if (targetKey == todayKey) {
            dateLabel = "今日 $month/$day ($weekday)"
            dayBadge = "今日 ($weekday)"
        } else if (targetKey == tomorrowKey) {
            dateLabel = "明日 $month/$day ($weekday)"
            dayBadge = "明日 ($weekday)"
        }

        return TimeParts(timeText, dayBadge, dateLabel, targetKey, whenText)
    }

    private fun isHtmlLoginPage(body: String): Boolean {
        val trimmed = body.trimStart()
        return trimmed.startsWith("<!DOCTYPE", ignoreCase = true) ||
            trimmed.startsWith("<html", ignoreCase = true)
    }

    private fun parseCookieMap(cookieHeader: String): LinkedHashMap<String, String> {
        val map = LinkedHashMap<String, String>()
        if (cookieHeader.isBlank()) return map
        for (part in cookieHeader.split(";")) {
            val idx = part.indexOf('=')
            if (idx <= 0) continue
            val name = part.substring(0, idx).trim()
            val value = part.substring(idx + 1).trim()
            if (name.isNotEmpty()) {
                map[name] = value
            }
        }
        return map
    }

    private fun mergeSetCookies(cookieMap: LinkedHashMap<String, String>, setCookieHeaders: List<String>) {
        for (raw in setCookieHeaders) {
            val firstSegment = raw.substringBefore(';').trim()
            val idx = firstSegment.indexOf('=')
            if (idx <= 0) continue
            val name = firstSegment.substring(0, idx).trim()
            val value = firstSegment.substring(idx + 1).trim()
            if (name == "ap-fid" && value == "\"\"") continue
            if (name.isNotEmpty()) {
                cookieMap[name] = value
            }
        }
    }

    private fun sanitizeAmazonCookieMap(cookieMap: Map<String, String>): LinkedHashMap<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((name, value) in cookieMap) {
            if (AMAZON_COOKIE_NAME_REGEX.matches(name)) {
                out[name] = value
            }
        }
        return out
    }

    private fun sanitizeAmazonCookie(cookieMap: Map<String, String>): String {
        return formatCookieMap(sanitizeAmazonCookieMap(cookieMap))
    }

    private fun formatCookieMap(cookieMap: Map<String, String>): String {
        return cookieMap.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    companion object {
        const val COOKIE_REFRESH_INTERVAL_MS = 4L * 24L * 60L * 60L * 1000L
        private const val WINDOW_MS = 24L * 60L * 60L * 1000L
        private const val PAST_GRACE_MS = 60_000L
        private const val MAX_REDIRECTS = 10

        private const val DEFAULT_AMAZON_PAGE = "amazon.co.jp"
        private const val DEFAULT_BASE_AMAZON_PAGE = "amazon.co.jp"
        private const val DEFAULT_ACCEPT_LANGUAGE = "ja-JP"
        private const val DEFAULT_APP_NAME = "ioBroker Alexa2"
        private const val API_CALL_VERSION = "2.2.651540.0"
        private const val API_CALL_USER_AGENT = "AmazonWebView/Amazon Alexa/2.2.651540.0/iOS/18.3.1/iPhone"
        private const val BROWSER_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"

        private val JST_ZONE: ZoneOffset = ZoneOffset.ofHours(9)
        private val WEEKDAYS_JA = arrayOf("日", "月", "火", "水", "木", "金", "土")
        private val WEEKDAY_TO_JS_DAY = mapOf(
            "SU" to 0,
            "MO" to 1,
            "TU" to 2,
            "WE" to 3,
            "TH" to 4,
            "FR" to 5,
            "SA" to 6
        )
        private val RECURRING_LABELS = mapOf(
            "P1D" to "毎日",
            "XXXX-WD" to "平日（月〜金）",
            "XXXX-WE" to "週末（土日）",
            "XXXX-WXX-1" to "毎週月曜",
            "XXXX-WXX-2" to "毎週火曜",
            "XXXX-WXX-3" to "毎週水曜",
            "XXXX-WXX-4" to "毎週木曜",
            "XXXX-WXX-5" to "毎週金曜",
            "XXXX-WXX-6" to "毎週土曜",
            "XXXX-WXX-7" to "毎週日曜"
        )
        private val CSRF_PATHS = listOf(
            "/api/language",
            "/spa/index.html",
            "/api/devices-v2/device?cached=false",
            "/templates/oobe/d-device-pick.handlebars",
            "/api/strings"
        )

        private val AMAZON_COOKIE_NAME_REGEX = Regex(
            "^(session-id|session-id-time|session-token|ubid-.+|lc-.+|x-.+|at-.+|sess-at-.+|frc|map-md|csrf|sid|csm-hit|i18n-prefs|sp-cdn|skin)$"
        )
        private val TZ_SUFFIX_REGEX = Regex("(?:Z|[+-]\\d{2}:?\\d{2})$", RegexOption.IGNORE_CASE)
        private val NO_COLON_TZ_REGEX = Regex("([+-]\\d{2})(\\d{2})$")
        private val WXX_PATTERN_REGEX = Regex("^XXXX-WXX-([1-7])$")
        private val TIME_OF_DAY_REGEX = Regex("^(\\d{2}):(\\d{2})(?::(\\d{2}))?")

        private const val CAPABILITIES_JSON = """{"legacyFlags":{"SUPPORTS_COMMS":true,"SUPPORTS_ARBITRATION":true,"SCREEN_WIDTH":1170,"SUPPORTS_SCRUBBING":true,"SPEECH_SYNTH_SUPPORTS_TTS_URLS":false,"SUPPORTS_HOME_AUTOMATION":true,"SUPPORTS_DROPIN_OUTBOUND":true,"FRIENDLY_NAME_TEMPLATE":"VOX","SUPPORTS_SIP_OUTBOUND_CALLING":true,"VOICE_PROFILE_SWITCHING_DISABLED":true,"SUPPORTS_LYRICS_IN_CARD":false,"SUPPORTS_DATAMART_NAMESPACE":"Vox","SUPPORTS_VIDEO_CALLING":true,"SUPPORTS_PFM_CHANGED":true,"SUPPORTS_TARGET_PLATFORM":"TABLET","SUPPORTS_SECURE_LOCKSCREEN":false,"AUDIO_PLAYER_SUPPORTS_TTS_URLS":false,"SUPPORTS_KEYS_IN_HEADER":false,"SUPPORTS_MIXING_BEHAVIOR_FOR_AUDIO_PLAYER":false,"AXON_SUPPORT":true,"SUPPORTS_TTS_SPEECHMARKS":true},"envelopeVersion":"20160207","capabilities":[{"version":"0.1","interface":"CardRenderer","type":"AlexaInterface"},{"interface":"Navigation","type":"AlexaInterface","version":"1.1"},{"type":"AlexaInterface","version":"2.0","interface":"Alexa.Comms.PhoneCallController"},{"type":"AlexaInterface","version":"1.1","interface":"ExternalMediaPlayer"},{"type":"AlexaInterface","interface":"Alerts","configurations":{"maximumAlerts":{"timers":2,"overall":99,"alarms":2}},"version":"1.3"},{"version":"1.0","interface":"Alexa.Display.Window","type":"AlexaInterface","configurations":{"templates":[{"type":"STANDARD","id":"app_window_template","configuration":{"sizes":[{"id":"fullscreen","type":"DISCRETE","value":{"value":{"height":1440,"width":3200},"unit":"PIXEL"}}],"interactionModes":["mobile_mode","auto_mode"]}}]}},{"type":"AlexaInterface","interface":"AccessoryKit","version":"0.1"},{"type":"AlexaInterface","interface":"Alexa.AudioSignal.ActiveNoiseControl","version":"1.0","configurations":{"ambientSoundProcessingModes":[{"name":"ACTIVE_NOISE_CONTROL"},{"name":"PASSTHROUGH"}]}},{"interface":"PlaybackController","type":"AlexaInterface","version":"1.0"},{"version":"1.0","interface":"Speaker","type":"AlexaInterface"},{"version":"1.0","interface":"SpeechSynthesizer","type":"AlexaInterface"},{"version":"1.0","interface":"AudioActivityTracker","type":"AlexaInterface"},{"type":"AlexaInterface","interface":"Alexa.Camera.LiveViewController","version":"1.0"},{"type":"AlexaInterface","interface":"Alexa.Input.Text","version":"1.0"},{"type":"AlexaInterface","interface":"Alexa.PlaybackStateReporter","version":"1.0"},{"version":"1.1","interface":"Geolocation","type":"AlexaInterface"},{"interface":"Alexa.Health.Fitness","version":"1.0","type":"AlexaInterface"},{"interface":"Settings","type":"AlexaInterface","version":"1.0"},{"configurations":{"interactionModes":[{"dialog":"SUPPORTED","interactionDistance":{"value":18,"unit":"INCHES"},"video":"SUPPORTED","keyboard":"SUPPORTED","id":"mobile_mode","uiMode":"MOBILE","touch":"SUPPORTED"},{"video":"UNSUPPORTED","dialog":"SUPPORTED","interactionDistance":{"value":36,"unit":"INCHES"},"uiMode":"AUTO","touch":"SUPPORTED","id":"auto_mode","keyboard":"UNSUPPORTED"}]},"type":"AlexaInterface","interface":"Alexa.InteractionMode","version":"1.0"},{"type":"AlexaInterface","configurations":{"catalogs":[{"type":"IOS_APP_STORE","identifierTypes":["URI_HTTP_SCHEME","URI_CUSTOM_SCHEME"]}]},"version":"0.2","interface":"Alexa.Launcher"},{"interface":"System","version":"1.0","type":"AlexaInterface"},{"interface":"Alexa.IOComponents","type":"AlexaInterface","version":"1.4"},{"type":"AlexaInterface","interface":"Alexa.FavoritesController","version":"1.0"},{"version":"1.0","type":"AlexaInterface","interface":"Alexa.Mobile.Push"},{"type":"AlexaInterface","interface":"InteractionModel","version":"1.1"},{"interface":"Alexa.PlaylistController","type":"AlexaInterface","version":"1.0"},{"interface":"SpeechRecognizer","type":"AlexaInterface","version":"2.1"},{"interface":"AudioPlayer","type":"AlexaInterface","version":"1.3"},{"type":"AlexaInterface","version":"3.1","interface":"Alexa.RTCSessionController"},{"interface":"VisualActivityTracker","version":"1.1","type":"AlexaInterface"},{"interface":"Alexa.PlaybackController","type":"AlexaInterface","version":"1.0"},{"type":"AlexaInterface","interface":"Alexa.SeekController","version":"1.0"},{"interface":"Alexa.Comms.MessagingController","type":"AlexaInterface","version":"1.0"}]}"""

        fun defaultOkHttpClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
        }
    }
}
