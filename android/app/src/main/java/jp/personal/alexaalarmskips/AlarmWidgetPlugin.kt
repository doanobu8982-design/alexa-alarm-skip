package jp.personal.alexaalarmskips

import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "AlarmWidget")
class AlarmWidgetPlugin : Plugin() {

    @PluginMethod
    fun updateWidgetSummary(call: PluginCall) {
        val summaryJson = call.getString("summaryJson")
        if (summaryJson.isNullOrBlank()) {
            call.reject("summaryJson is required")
            return
        }
        val alarmsPayloadJson = call.getString("alarmsPayloadJson")

        val prefs = context.getSharedPreferences(
            AlarmWidgetProvider.PREFS_NAME,
            Context.MODE_PRIVATE
        )
        val editor = prefs.edit()
            .putString(AlarmWidgetProvider.KEY_WIDGET_SUMMARY_JSON, summaryJson)
            .putBoolean(AlarmWidgetProvider.KEY_AUTH_EXPIRED, false)
            .putLong(AlarmWidgetProvider.KEY_LAST_BG_UPDATED_MS, System.currentTimeMillis())
        if (!alarmsPayloadJson.isNullOrBlank()) {
            editor.putString(AlarmWidgetProvider.KEY_CACHED_ALARMS_PAYLOAD_JSON, alarmsPayloadJson)
        }
        editor.apply()

        AlarmWidgetProvider.updateAllWidgets(context)

        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    @PluginMethod
    fun saveCookieFilePath(call: PluginCall) {
        val cookieFile = call.getString("cookieFile")
        if (cookieFile.isNullOrBlank()) {
            call.reject("cookieFile is required")
            return
        }

        val prefs = context.getSharedPreferences(
            AlarmWidgetProvider.PREFS_NAME,
            Context.MODE_PRIVATE
        )
        prefs.edit()
            .putString(AlarmWidgetProvider.KEY_COOKIE_FILE_PATH, cookieFile)
            .apply()

        AlarmRefreshScheduler.ensurePeriodicWork(context)

        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    @PluginMethod
    fun getCachedState(call: PluginCall) {
        val prefs = context.getSharedPreferences(
            AlarmWidgetProvider.PREFS_NAME,
            Context.MODE_PRIVATE
        )
        val alarmsPayloadJson = prefs.getString(AlarmWidgetProvider.KEY_CACHED_ALARMS_PAYLOAD_JSON, null)
        val widgetSummaryJson = prefs.getString(AlarmWidgetProvider.KEY_WIDGET_SUMMARY_JSON, null)
        val lastUpdatedMs = prefs.getLong(AlarmWidgetProvider.KEY_LAST_BG_UPDATED_MS, 0L)
        val authExpired = prefs.getBoolean(AlarmWidgetProvider.KEY_AUTH_EXPIRED, false)
        val hasRawCache = !alarmsPayloadJson.isNullOrBlank()
        val cacheExpired = hasRawCache && isCacheExpired(lastUpdatedMs)
        val hasCache = hasRawCache && !cacheExpired

        val result = JSObject()
        result.put("hasCache", hasCache)
        result.put("cacheExpired", cacheExpired)
        result.put("alarmsPayloadJson", alarmsPayloadJson ?: JSObject.NULL)
        result.put("widgetSummaryJson", widgetSummaryJson ?: JSObject.NULL)
        result.put("lastUpdatedMs", lastUpdatedMs)
        result.put("authExpired", authExpired)
        call.resolve(result)
    }

    @PluginMethod
    fun triggerImmediateRefresh(call: PluginCall) {
        val forceTokenRefresh = call.getBoolean("forceTokenRefresh") ?: false
        AlarmRefreshScheduler.enqueueImmediateRefresh(context, forceTokenRefresh)

        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    @PluginMethod
    fun getMockConfig(call: PluginCall) {
        val mockUrl = activity?.intent?.getStringExtra("mockUrl")
        val result = JSObject()
        if (!mockUrl.isNullOrBlank()) {
            result.put("mockUrl", mockUrl)
        } else {
            result.put("mockUrl", JSObject.NULL)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun enqueueMutation(call: PluginCall) {
        val jobJsonRaw = call.getString("jobJson")
        if (jobJsonRaw.isNullOrBlank()) {
            call.reject("jobJson is required")
            return
        }
        val job = try {
            JSONObject(jobJsonRaw)
        } catch (e: Exception) {
            call.reject("Invalid jobJson: ${e.message}")
            return
        }
        val opId = job.optString("opId", "")
        val action = job.optString("action", "")
        if (opId.isBlank() || action.isBlank()) {
            call.reject("opId and action are required")
            return
        }

        val count = synchronized(MUTATION_LOCK) {
            val prefs = context.getSharedPreferences(
                AlarmWidgetProvider.PREFS_NAME,
                Context.MODE_PRIVATE
            )
            val current = readPendingMutationsArray(prefs)
            val next = JSONArray()
            for (i in 0 until current.length()) {
                val item = current.optJSONObject(i) ?: continue
                if (item.optString("opId", "") != opId) {
                    next.put(item)
                }
            }
            next.put(job)
            prefs.edit()
                .putString(AlarmWidgetProvider.KEY_PENDING_MUTATIONS_JSON, next.toString())
                .commit()
            next.length()
        }

        markWebMutationInFlight(opId)
        AlarmRefreshScheduler.enqueueImmediateRefresh(context)

        val result = JSObject()
        result.put("queued", true)
        result.put("count", count)
        call.resolve(result)
    }

    @PluginMethod
    fun completeMutation(call: PluginCall) {
        val opId = call.getString("opId")
        if (opId.isNullOrBlank()) {
            call.reject("opId is required")
            return
        }

        val (removed, count) = synchronized(MUTATION_LOCK) {
            val prefs = context.getSharedPreferences(
                AlarmWidgetProvider.PREFS_NAME,
                Context.MODE_PRIVATE
            )
            val current = readPendingMutationsArray(prefs)
            val next = JSONArray()
            var didRemove = false
            for (i in 0 until current.length()) {
                val item = current.optJSONObject(i) ?: continue
                if (item.optString("opId", "") == opId) {
                    didRemove = true
                } else {
                    next.put(item)
                }
            }
            if (didRemove) {
                prefs.edit()
                    .putString(AlarmWidgetProvider.KEY_PENDING_MUTATIONS_JSON, next.toString())
                    .commit()
            }
            Pair(didRemove, next.length())
        }

        clearWebMutationInFlight(opId)
        if (count == 0) {
            AlarmRefreshScheduler.cancelDeferredFallbackRefresh(context)
        }

        val result = JSObject()
        result.put("removed", removed)
        result.put("count", count)
        call.resolve(result)
    }

    @PluginMethod
    fun releaseInFlightMutation(call: PluginCall) {
        val opId = call.getString("opId")
        if (opId.isNullOrBlank()) {
            call.reject("opId is required")
            return
        }

        clearWebMutationInFlight(opId)
        val hasPending = synchronized(MUTATION_LOCK) {
            val prefs = context.getSharedPreferences(
                AlarmWidgetProvider.PREFS_NAME,
                Context.MODE_PRIVATE
            )
            readPendingMutationsArray(prefs).length() > 0
        }
        if (hasPending) {
            AlarmRefreshScheduler.enqueueImmediateRefresh(context)
        }

        val result = JSObject()
        result.put("ok", true)
        result.put("hasPending", hasPending)
        call.resolve(result)
    }

    @PluginMethod
    fun getPendingMutations(call: PluginCall) {
        val array = synchronized(MUTATION_LOCK) {
            val prefs = context.getSharedPreferences(
                AlarmWidgetProvider.PREFS_NAME,
                Context.MODE_PRIVATE
            )
            readPendingMutationsArray(prefs)
        }
        val result = JSObject()
        result.put("jobsJson", array.toString())
        result.put("count", array.length())
        call.resolve(result)
    }

    companion object {
        val MUTATION_LOCK = Any()
        internal const val CACHE_TTL_MS: Long = 6L * 60L * 60L * 1000L
        internal const val IN_FLIGHT_TTL_MS = 10_000L
        private val inFlightWebMutations = ConcurrentHashMap<String, Long>()

        internal fun isCacheExpired(lastUpdatedMs: Long, nowMs: Long = System.currentTimeMillis()): Boolean {
            return lastUpdatedMs <= 0L || (nowMs - lastUpdatedMs) > CACHE_TTL_MS
        }

        internal fun markWebMutationInFlight(opId: String, nowMs: Long = System.currentTimeMillis()) {
            if (opId.isBlank()) return
            inFlightWebMutations[opId] = nowMs
        }

        internal fun clearWebMutationInFlight(opId: String) {
            if (opId.isBlank()) return
            inFlightWebMutations.remove(opId)
        }

        internal fun isWebMutationInFlight(opId: String, nowMs: Long = System.currentTimeMillis()): Boolean {
            if (opId.isBlank()) return false
            val startedAt = inFlightWebMutations[opId] ?: return false
            if (nowMs - startedAt < IN_FLIGHT_TTL_MS) {
                return true
            }
            inFlightWebMutations.remove(opId, startedAt)
            return false
        }

        internal fun resetInFlightForTest() {
            inFlightWebMutations.clear()
        }

        fun readPendingMutationsArray(prefs: android.content.SharedPreferences): JSONArray {
            val raw = prefs.getString(AlarmWidgetProvider.KEY_PENDING_MUTATIONS_JSON, null)
            if (raw.isNullOrBlank()) return JSONArray()
            return try {
                JSONArray(raw)
            } catch (_: Exception) {
                JSONArray()
            }
        }
    }
}
