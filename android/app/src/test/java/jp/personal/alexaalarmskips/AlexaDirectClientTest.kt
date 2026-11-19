package jp.personal.alexaalarmskips

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.CopyOnWriteArrayList

class AlexaDirectClientTest {

    private fun jstEpochMs(iso: String): Long {
        return OffsetDateTime.parse(iso).toInstant().toEpochMilli()
    }

    @Test
    fun classifyAndBuildPayload_matchesNodeAlarmLogic() {
        // 2026-11-16 06:00:00+09:00 (Monday)
        val nowMs = jstEpochMs("2026-11-16T06:00:00+09:00")
        val dummyCookie = File("nonexistent-cookie.json")
        val client = AlexaDirectClient(cookieFile = dummyCookie, nowProvider = { nowMs })

        val devices = JSONArray().apply {
            put(JSONObject().apply {
                put("serialNumber", "DEV_001")
                put("accountName", "寝室 Echo")
            })
            put(JSONObject().apply {
                put("serialNumber", "DEV_002")
                put("deviceName", "リビング Echo")
            })
        }

        val notifications = JSONArray().apply {
            // 1. Active today (07:30 JST)
            put(JSONObject().apply {
                put("notificationIndex", "alarm-today")
                put("deviceSerialNumber", "DEV_001")
                put("type", "Alarm")
                put("status", "ON")
                put("alarmLabel", "起床")
                put("recurringPattern", "P1D")
                put("originalDate", "2026-11-16")
                put("originalTime", "07:30:00.000")
                put("trigger", JSONObject().apply {
                    put("scheduledTime", "2026-11-16T07:30:00.000+09:00")
                })
            })
            // 2. Active tomorrow within 24h (2026-11-17 05:30 JST)
            put(JSONObject().apply {
                put("notificationIndex", "alarm-tomorrow")
                put("deviceSerialNumber", "DEV_002")
                put("type", "MusicAlarm")
                put("status", "ON")
                put("originalDate", "2026-11-17")
                put("originalTime", "05:30:00.000")
                put("trigger", JSONObject().apply {
                    put("scheduledTime", "2026-11-17T05:30:00.000+09:00")
                })
            })
            // 3. Cloud-skipped daily alarm (expected 2026-11-16 08:00, scheduled 2026-11-17 08:00)
            put(JSONObject().apply {
                put("notificationIndex", "alarm-skipped")
                put("deviceSerialNumber", "DEV_001")
                put("type", "Alarm")
                put("status", "ON")
                put("alarmLabel", "運動")
                put("recurringPattern", "P1D")
                put("originalDate", "2026-11-17")
                put("originalTime", "08:00:00.000")
                put("trigger", JSONObject().apply {
                    put("scheduledTime", "2026-11-17T08:00:00.000+09:00")
                })
            })
            // 4. Over 24h away (2026-11-17 07:00 JST) -> excluded
            put(JSONObject().apply {
                put("notificationIndex", "alarm-over24h")
                put("deviceSerialNumber", "DEV_001")
                put("type", "Alarm")
                put("status", "ON")
                put("originalDate", "2026-11-17")
                put("originalTime", "07:00:00.000")
                put("trigger", JSONObject().apply {
                    put("scheduledTime", "2026-11-17T07:00:00.000+09:00")
                })
            })
            // 5. OFF alarm -> excluded
            put(JSONObject().apply {
                put("notificationIndex", "alarm-off")
                put("deviceSerialNumber", "DEV_001")
                put("type", "Alarm")
                put("status", "OFF")
                put("trigger", JSONObject().apply {
                    put("scheduledTime", "2026-11-16T09:00:00.000+09:00")
                })
            })
        }

        val (payload, summary) = client.classifyAndBuildPayload(notifications, devices, nowMs)

        assertEquals(2, payload.getInt("deviceCount"))
        assertEquals("06:00:00", payload.getString("checkedAt"))

        val active = payload.getJSONArray("active")
        assertEquals(2, active.length())

        val first = active.getJSONObject(0)
        assertEquals("alarm-today", first.getString("id"))
        assertEquals("07:30", first.getString("timeText"))
        assertEquals("今日 (月)", first.getString("dayBadge"))
        assertEquals("今日 11/16 (月)", first.getString("dateLabel"))
        assertEquals("寝室 Echo", first.getString("deviceName"))
        assertEquals("起床", first.getString("label"))
        assertEquals("毎日", first.getString("recurringText"))
        assertFalse(first.getBoolean("isSkipped"))

        val second = active.getJSONObject(1)
        assertEquals("alarm-tomorrow", second.getString("id"))
        assertEquals("05:30", second.getString("timeText"))
        assertEquals("明日 (火)", second.getString("dayBadge"))
        assertEquals("リビング Echo", second.getString("deviceName"))
        assertEquals("1回のみ", second.getString("recurringText"))

        val skipped = payload.getJSONArray("skipped")
        assertEquals(1, skipped.length())
        val skippedItem = skipped.getJSONObject(0)
        assertEquals("alarm-skipped", skippedItem.getString("id"))
        assertEquals("08:00", skippedItem.getString("timeText"))
        assertEquals("今日 (月)", skippedItem.getString("dayBadge"))
        assertTrue(skippedItem.getBoolean("isSkipped"))

        assertTrue(summary.getBoolean("hasAlarm"))
        assertEquals(1, summary.getInt("remainingCount"))
        assertEquals(2, summary.getInt("totalCount"))
        assertEquals("06:00:00", summary.getString("checkedAt"))

        val nextAlarm = summary.getJSONObject("nextAlarm")
        assertEquals("alarm-today", nextAlarm.getString("id"))
        assertEquals("07:30", nextAlarm.getString("timeText"))
        assertEquals("今日 (月)", nextAlarm.getString("dayBadge"))
        assertEquals("寝室 Echo", nextAlarm.getString("deviceName"))
        assertEquals("起床", nextAlarm.getString("label"))
    }

    @Test
    fun needsTokenRefresh_checksAgeAndRequiredFields() {
        val nowMs = 1_700_000_000_000L
        val threeDaysMs = 3L * 24L * 60L * 60L * 1000L
        val fourDaysMs = 4L * 24L * 60L * 60L * 1000L
        val client = AlexaDirectClient(cookieFile = File("dummy.json"), nowProvider = { nowMs })

        val validRecent = JSONObject().apply {
            put("localCookie", "session-id=123; csrf=abc")
            put("csrf", "abc")
            put("tokenDate", nowMs - threeDaysMs)
        }
        assertFalse(client.needsTokenRefresh(validRecent, nowMs))

        val expiredFourDays = JSONObject().apply {
            put("localCookie", "session-id=123; csrf=abc")
            put("csrf", "abc")
            put("tokenDate", nowMs - fourDaysMs)
        }
        assertTrue(client.needsTokenRefresh(expiredFourDays, nowMs))

        val missingCsrf = JSONObject().apply {
            put("localCookie", "session-id=123")
            put("tokenDate", nowMs - threeDaysMs)
        }
        assertTrue(client.needsTokenRefresh(missingCsrf, nowMs))

        val missingLocalCookie = JSONObject().apply {
            put("csrf", "abc")
            put("tokenDate", nowMs - threeDaysMs)
        }
        assertTrue(client.needsTokenRefresh(missingLocalCookie, nowMs))

        val zeroTokenDate = JSONObject().apply {
            put("localCookie", "session-id=123; csrf=abc")
            put("csrf", "abc")
            put("tokenDate", 0L)
        }
        assertTrue(client.needsTokenRefresh(zeroTokenDate, nowMs))
    }

    @Test
    fun liveFetchAndRefresh_withPcCookieFile_succeedsWithoutModifyingOriginal() {
        val sourceCookieFile = listOf(
            File("alexa-cookie.json"),
            File("../alexa-cookie.json"),
            File("../../alexa-cookie.json")
        ).firstOrNull { it.exists() && it.isFile }

        Assume.assumeTrue("alexa-cookie.json not found on PC", sourceCookieFile != null)

        val tempDir = Files.createTempDirectory("alexa-direct-test-").toFile()
        val tempCookieFile = File(tempDir, "alexa-cookie.json")
        try {
            sourceCookieFile!!.copyTo(tempCookieFile, overwrite = true)
            val originalBefore = JSONObject(tempCookieFile.readText(Charsets.UTF_8))
            val oldTokenDate = originalBefore.optLong("tokenDate", 0L)

            val client = AlexaDirectClient(cookieFile = tempCookieFile)
            assertTrue(client.hasValidCookieFile())

            // 1. Live fetch without forceRefresh and without persisting
            val fetchRes = client.fetchAndBuildSummary(forceRefresh = false, persistCookie = false)
            assertTrue(fetchRes.ok)
            assertTrue(fetchRes.widgetSummaryJson.optString("checkedAt", "").isNotBlank())
            println(
                "[AlexaDirectClientTest] Live fetch OK: totalCount=${fetchRes.widgetSummaryJson.optInt("totalCount")}, " +
                    "deviceCount=${fetchRes.alarmsPayloadJson.optInt("deviceCount")}, " +
                    "checkedAt=${fetchRes.widgetSummaryJson.optString("checkedAt")}"
            )

            // 2. Force refresh and persist to temp file
            val refreshRes = client.fetchAndBuildSummary(forceRefresh = true, persistCookie = true)
            assertTrue(refreshRes.ok)
            assertTrue(refreshRes.refreshedCookie)

            val updatedJson = JSONObject(tempCookieFile.readText(Charsets.UTF_8))
            val newTokenDate = updatedJson.optLong("tokenDate", 0L)
            assertTrue(newTokenDate > 0L)
            assertTrue(newTokenDate >= oldTokenDate)
            assertTrue(updatedJson.optString("csrf", "").isNotBlank())
            assertTrue(updatedJson.optString("localCookie", "").isNotBlank())

            // 3. Re-fetch using the newly refreshed cookie in temp file
            val postRefreshRes = client.fetchAndBuildSummary(forceRefresh = false, persistCookie = false)
            assertTrue(postRefreshRes.ok)
            assertFalse(postRefreshRes.refreshedCookie)
            assertNotNull(postRefreshRes.alarmsPayloadJson.optJSONArray("active"))
            println(
                "[AlexaDirectClientTest] Refresh + re-fetch OK: totalCount=${postRefreshRes.widgetSummaryJson.optInt("totalCount")}, " +
                    "checkedAt=${postRefreshRes.widgetSummaryJson.optString("checkedAt")}"
            )
        } finally {
            tempCookieFile.delete()
            tempDir.deleteRecursively()
        }
    }

    private fun createRecordingClient(
        recorded: CopyOnWriteArrayList<Triple<String, String, String>>
    ): OkHttpClient {
        return OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                val buf = Buffer()
                req.body?.writeTo(buf)
                val bodyStr = buf.readUtf8()
                val auth = req.header("authorization") ?: ""
                recorded.add(Triple(req.method, req.url.encodedPath, "$auth|$bodyStr"))
                Response.Builder()
                    .request(req)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("""{"ok":true}""".toResponseBody("application/json".toMediaType()))
                    .build()
            }
            .build()
    }

    @Test
    fun skipAlarmAndRestoreAlarm_sendExpectedAuthApiPutRequests() {
        val recorded = CopyOnWriteArrayList<Triple<String, String, String>>()
        val mockHttp = createRecordingClient(recorded)

        val tempDir = Files.createTempDirectory("alexa-skip-restore-").toFile()
        val cookieFile = File(tempDir, "alexa-cookie.json")
        val nowMs = jstEpochMs("2026-11-19T06:00:00+09:00")
        cookieFile.writeText(
            JSONObject().apply {
                put("localCookie", "session-id=1; csrf=abc")
                put("csrf", "abc")
                put("accessToken", "Atna|test-token")
                put("tokenDate", nowMs)
            }.toString(),
            Charsets.UTF_8
        )

        try {
            val client = AlexaDirectClient(
                cookieFile = cookieFile,
                client = mockHttp,
                nowProvider = { nowMs },
                alexaApiUrlOverride = "https://alexa-api.example.test"
            )
            val job = JSONObject().apply {
                put("opId", "op-1")
                put("action", "skip")
                put("alarmId", "alarm-idx-1")
                put("type", "Alarm")
                put("originalDate", "2026-11-19")
                put("originalTime", "08:00:00.000")
                put("recurringPattern", "P1D")
                put("soundId", "system_alerts_melodic_01")
            }

            assertTrue(client.skipAlarm(job, persistCookie = false))
            assertEquals(1, recorded.size)
            assertEquals("PUT", recorded[0].first)
            assertEquals("/v1/alerts/alarms/alarm-idx-1/nextOccurrence/cancel", recorded[0].second)
            assertTrue(recorded[0].third.startsWith("Atna|test-token|"))

            recorded.clear()
            assertTrue(client.restoreAlarm(job, persistCookie = false, restoreWaitMs = 0L))
            assertEquals(2, recorded.size)
            assertEquals("PUT", recorded[0].first)
            assertEquals("/v1/alerts/alarms/alarm-idx-1/cancel", recorded[0].second)
            assertEquals("PUT", recorded[1].first)
            assertEquals("/v1/alerts/alarms/alarm-idx-1", recorded[1].second)

            val v2Body = JSONObject(recorded[1].third.substringAfter("Atna|test-token|"))
            assertEquals("2026-11-19T08:00:00", v2Body.getJSONObject("trigger").getString("scheduledTime"))
            assertEquals("DAILY", v2Body.getJSONObject("trigger").getJSONObject("recurrence").getString("freq"))
            assertEquals("system_alerts_melodic_01", v2Body.getJSONArray("assets").getJSONObject(0).getString("assetId"))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun drainPendingMutations_processesQueueSequentiallyAndRemovesCompletedJobs() {
        val recorded = CopyOnWriteArrayList<Triple<String, String, String>>()
        val mockHttp = createRecordingClient(recorded)

        val store = LinkedHashMap<String, Any?>()
        val prefs = object : android.content.SharedPreferences {
            override fun getAll(): MutableMap<String, *> = store
            override fun getString(key: String?, defValue: String?): String? = (store[key] as? String) ?: defValue
            override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
            override fun getInt(key: String?, defValue: Int): Int = defValue
            override fun getLong(key: String?, defValue: Long): Long = defValue
            override fun getFloat(key: String?, defValue: Float): Float = defValue
            override fun getBoolean(key: String?, defValue: Boolean): Boolean = defValue
            override fun contains(key: String?): Boolean = store.containsKey(key)
            override fun registerOnSharedPreferenceChangeListener(listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener?) {}
            override fun unregisterOnSharedPreferenceChangeListener(listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener?) {}
            override fun edit(): android.content.SharedPreferences.Editor {
                val pending = LinkedHashMap<String, Any?>()
                return object : android.content.SharedPreferences.Editor {
                    override fun putString(key: String?, value: String?): android.content.SharedPreferences.Editor {
                        if (key != null) pending[key] = value
                        return this
                    }
                    override fun putStringSet(key: String?, values: MutableSet<String>?) = this
                    override fun putInt(key: String?, value: Int) = this
                    override fun putLong(key: String?, value: Long) = this
                    override fun putFloat(key: String?, value: Float) = this
                    override fun putBoolean(key: String?, value: Boolean) = this
                    override fun remove(key: String?) = this
                    override fun clear() = this
                    override fun commit(): Boolean {
                        store.putAll(pending)
                        return true
                    }
                    override fun apply() {
                        store.putAll(pending)
                    }
                }
            }
        }

        val initialQueue = JSONArray().apply {
            put(JSONObject().apply {
                put("opId", "op-skip-1")
                put("action", "skip")
                put("alarmId", "a-1")
            })
            put(JSONObject().apply {
                put("opId", "op-restore-2")
                put("action", "restore")
                put("alarmId", "a-2")
                put("originalDate", "2026-11-19")
                put("originalTime", "09:00:00.000")
            })
        }
        prefs.edit().putString(AlarmWidgetProvider.KEY_PENDING_MUTATIONS_JSON, initialQueue.toString()).commit()

        val client = AlexaDirectClient(cookieFile = File("unused.json"), client = mockHttp)
        val processed = AlarmRefreshWorker.drainPendingMutations(prefs, client, mockUrl = "http://127.0.0.1:9999")
        assertEquals(2, processed)
        assertEquals(2, recorded.size)
        assertEquals("/api/alarms/skip", recorded[0].second)
        assertEquals("/api/alarms/restore", recorded[1].second)
        assertEquals("[]", prefs.getString(AlarmWidgetProvider.KEY_PENDING_MUTATIONS_JSON, ""))
    }
}
