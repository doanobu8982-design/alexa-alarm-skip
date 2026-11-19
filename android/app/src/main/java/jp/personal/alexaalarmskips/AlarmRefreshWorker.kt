package jp.personal.alexaalarmskips

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File

class AlarmRefreshWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : Worker(appContext, workerParams) {

    override fun getForegroundInfo(): ForegroundInfo {
        ensureNotificationChannel(applicationContext)
        val iconRes = applicationContext.applicationInfo.icon.takeIf { it != 0 }
            ?: android.R.drawable.ic_popup_sync
        val notification = NotificationCompat.Builder(applicationContext, SYNC_CHANNEL_ID)
            .setContentTitle("Alexa アラーム同期中")
            .setSmallIcon(iconRes)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return ForegroundInfo(FOREGROUND_NOTIFICATION_ID, notification)
    }

    private fun ensureNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        if (manager.getNotificationChannel(SYNC_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            SYNC_CHANNEL_ID,
            "アラーム同期",
            NotificationManager.IMPORTANCE_LOW
        )
        manager.createNotificationChannel(channel)
    }

    override fun doWork(): Result {
        val cookieFile = resolveCookieFile(applicationContext)
        if (cookieFile == null) {
            Log.i(TAG, "alexa-cookie.json not found; skipping background refresh")
            return Result.success()
        }

        val prefs = applicationContext.getSharedPreferences(
            AlarmWidgetProvider.PREFS_NAME,
            Context.MODE_PRIVATE
        )
        val forceRefresh = inputData.getBoolean(KEY_FORCE_REFRESH, false)
        val mockUrl = inputData.getString(KEY_MOCK_URL)
        return try {
            val client = AlexaDirectClient(cookieFile)
            drainPendingMutations(prefs, client, mockUrl)

            val result = client.fetchAndBuildSummary(
                forceRefresh = forceRefresh,
                persistCookie = true
            )

            prefs.edit()
                .putString(AlarmWidgetProvider.KEY_WIDGET_SUMMARY_JSON, result.widgetSummaryJson.toString())
                .putString(AlarmWidgetProvider.KEY_CACHED_ALARMS_PAYLOAD_JSON, result.alarmsPayloadJson.toString())
                .putLong(AlarmWidgetProvider.KEY_LAST_BG_UPDATED_MS, System.currentTimeMillis())
                .putBoolean(AlarmWidgetProvider.KEY_AUTH_EXPIRED, false)
                .apply()

            AlarmWidgetProvider.updateAllWidgets(applicationContext)

            val nextAlarm = result.widgetSummaryJson.optJSONObject("nextAlarm")
            val whenMs = nextAlarm?.optLong("whenMs", 0L) ?: 0L
            val preAlarmTriggerMs = whenMs - PRE_ALARM_OFFSET_MS
            if (whenMs > 0L && preAlarmTriggerMs > System.currentTimeMillis() + MIN_PRE_ALARM_LEAD_MS) {
                AlarmRefreshScheduler.schedulePreAlarmRefresh(applicationContext, preAlarmTriggerMs)
            }

            Log.i(
                TAG,
                "Background refresh succeeded: totalCount=${result.widgetSummaryJson.optInt("totalCount")}, " +
                    "refreshedCookie=${result.refreshedCookie}, checkedAt=${result.widgetSummaryJson.optString("checkedAt")}"
            )
            Result.success()
        } catch (authEx: AlexaAuthException) {
            Log.w(TAG, "Authentication expired during background refresh (status=${authEx.statusCode})")
            val prefs = applicationContext.getSharedPreferences(
                AlarmWidgetProvider.PREFS_NAME,
                Context.MODE_PRIVATE
            )
            prefs.edit()
                .putBoolean(AlarmWidgetProvider.KEY_AUTH_EXPIRED, true)
                .apply()
            AlarmWidgetProvider.updateAllWidgets(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "Background refresh failed (${e.javaClass.simpleName}); scheduling retry")
            Result.retry()
        }
    }

    private fun resolveCookieFile(context: Context): File? {
        val prefs = context.getSharedPreferences(AlarmWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE)
        val savedPath = prefs.getString(AlarmWidgetProvider.KEY_COOKIE_FILE_PATH, null)
        if (!savedPath.isNullOrBlank()) {
            val savedFile = File(savedPath)
            if (savedFile.exists() && savedFile.isFile) {
                return savedFile
            }
        }

        val roots = linkedSetOf<File>().apply {
            add(context.filesDir)
            context.filesDir.parentFile?.let { add(it) }
        }
        for (root in roots) {
            findCookieFile(root, maxDepth = 2)?.let { return it }
        }
        return null
    }

    private fun findCookieFile(dir: File, maxDepth: Int): File? {
        if (!dir.exists() || !dir.isDirectory) return null
        val direct = File(dir, COOKIE_FILE_NAME)
        if (direct.exists() && direct.isFile) {
            return direct
        }
        if (maxDepth <= 0) return null
        val children = dir.listFiles() ?: return null
        for (child in children) {
            if (child.isDirectory) {
                findCookieFile(child, maxDepth - 1)?.let { return it }
            }
        }
        return null
    }

    companion object {
        const val KEY_FORCE_REFRESH = "forceRefresh"
        const val KEY_MOCK_URL = "mockUrl"
        private const val TAG = "AlarmRefreshWorker"
        private const val SYNC_CHANNEL_ID = "alarm_sync_channel"
        private const val FOREGROUND_NOTIFICATION_ID = 1001
        private const val COOKIE_FILE_NAME = "alexa-cookie.json"
        private const val PRE_ALARM_OFFSET_MS = 5L * 60L * 1000L
        private const val MIN_PRE_ALARM_LEAD_MS = 30_000L

        fun drainPendingMutations(
            prefs: android.content.SharedPreferences,
            client: AlexaDirectClient,
            mockUrl: String? = null
        ): Int {
            var processed = 0
            while (true) {
                val head = synchronized(AlarmWidgetPlugin.MUTATION_LOCK) {
                    val queue = AlarmWidgetPlugin.readPendingMutationsArray(prefs)
                    if (queue.length() == 0) null else queue.optJSONObject(0)
                } ?: break

                val opId = head.optString("opId", "")
                val action = head.optString("action", "")
                when (action) {
                    "skip" -> client.skipAlarm(head, mockUrl = mockUrl, persistCookie = true)
                    "restore" -> client.restoreAlarm(head, mockUrl = mockUrl, persistCookie = true)
                    else -> Log.w(TAG, "Unknown pending mutation action: $action (opId=$opId)")
                }

                synchronized(AlarmWidgetPlugin.MUTATION_LOCK) {
                    val current = AlarmWidgetPlugin.readPendingMutationsArray(prefs)
                    val next = org.json.JSONArray()
                    for (i in 0 until current.length()) {
                        val item = current.optJSONObject(i) ?: continue
                        if (opId.isNotBlank() && item.optString("opId", "") == opId) {
                            continue
                        }
                        if (opId.isBlank() && i == 0) {
                            continue
                        }
                        next.put(item)
                    }
                    prefs.edit()
                        .putString(AlarmWidgetProvider.KEY_PENDING_MUTATIONS_JSON, next.toString())
                        .commit()
                }
                processed += 1
            }
            return processed
        }
    }
}
