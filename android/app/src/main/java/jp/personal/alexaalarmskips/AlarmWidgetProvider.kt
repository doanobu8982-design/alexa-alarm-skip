package jp.personal.alexaalarmskips

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.widget.RemoteViews
import org.json.JSONObject

class AlarmWidgetProvider : AppWidgetProvider() {

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        AlarmRefreshScheduler.ensurePeriodicWork(context)
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        AlarmRefreshScheduler.ensurePeriodicWork(context)
        for (appWidgetId in appWidgetIds) {
            updateSingleWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle
    ) {
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
        updateSingleWidget(context, appWidgetManager, appWidgetId)
    }

    companion object {
        const val PREFS_NAME = "alexa_alarm_widget_prefs"
        const val KEY_WIDGET_SUMMARY_JSON = "widget_summary_json"
        const val KEY_CACHED_ALARMS_PAYLOAD_JSON = "cached_alarms_payload_json"
        const val KEY_COOKIE_FILE_PATH = "cookie_file_path"
        const val KEY_LAST_BG_UPDATED_MS = "last_bg_updated_ms"
        const val KEY_AUTH_EXPIRED = "auth_expired"
        const val KEY_PENDING_MUTATIONS_JSON = "pending_mutations_json"
        private const val PAST_GRACE_MS = 60_000L
        private const val WIDTH_THRESHOLD_DP = 100

        fun updateAllWidgets(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, AlarmWidgetProvider::class.java)
            val ids = manager.getAppWidgetIds(component)
            for (appWidgetId in ids) {
                updateSingleWidget(context, manager, appWidgetId)
            }
        }

        private fun createLaunchPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun parseSummary(context: Context): JSONObject? {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_WIDGET_SUMMARY_JSON, null) ?: return null
            return try {
                JSONObject(raw)
            } catch (_: Exception) {
                null
            }
        }

        private fun isAuthExpired(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return prefs.getBoolean(KEY_AUTH_EXPIRED, false)
        }

        private fun buildRemoteViews(context: Context): Pair<RemoteViews, RemoteViews> {
            val authExpired = isAuthExpired(context)
            val summary = parseSummary(context)
            val hasAlarmFlag = summary?.optBoolean("hasAlarm", false) == true
            val nextAlarm = summary?.optJSONObject("nextAlarm")
            val whenMs = nextAlarm?.optLong("whenMs", 0L) ?: 0L
            val nowMs = System.currentTimeMillis()
            val isValidAlarm = !authExpired && hasAlarmFlag && nextAlarm != null && whenMs >= (nowMs - PAST_GRACE_MS)

            val views1x1 = RemoteViews(context.packageName, R.layout.widget_alarm_1x1)
            val views2x1 = RemoteViews(context.packageName, R.layout.widget_alarm_2x1)

            val pendingIntent = createLaunchPendingIntent(context)
            views1x1.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
            views2x1.setOnClickPendingIntent(R.id.widget_root, pendingIntent)

            if (authExpired) {
                views1x1.setTextViewText(R.id.tv_badge_1x1, "Alexa")
                views1x1.setTextViewText(R.id.tv_time_1x1, "要ログイン")
                views1x1.setTextViewText(R.id.tv_sub_1x1, "タップして開く")

                views2x1.setTextViewText(R.id.tv_time_2x1, "要ログイン")
                views2x1.setTextViewText(R.id.tv_date_2x1, "認証期限切れ")
                views2x1.setTextViewText(R.id.tv_device_2x1, "Amazon 再ログインが必要です")
                views2x1.setTextViewText(R.id.tv_sub_2x1, "タップして開く")
            } else if (isValidAlarm && nextAlarm != null) {
                val timeText = nextAlarm.optString("timeText", "--:--")
                val dayBadge = nextAlarm.optString("dayBadge", "次のアラーム")
                val deviceName = nextAlarm.optString("deviceName", "Echo")
                val label = nextAlarm.optString("label", "")
                val remainingCount = summary?.optInt("remainingCount", 0) ?: 0

                views1x1.setTextViewText(R.id.tv_badge_1x1, dayBadge.ifEmpty { "次のアラーム" })
                views1x1.setTextViewText(R.id.tv_time_1x1, timeText)
                views1x1.setTextViewText(
                    R.id.tv_sub_1x1,
                    if (remainingCount > 0) "+${remainingCount}件" else "24h以内"
                )

                views2x1.setTextViewText(R.id.tv_time_2x1, timeText)
                views2x1.setTextViewText(R.id.tv_date_2x1, dayBadge.ifEmpty { "次のアラーム" })
                views2x1.setTextViewText(R.id.tv_device_2x1, deviceName.ifEmpty { "Echo" })

                val sub2x1 = when {
                    label.isNotEmpty() && remainingCount > 0 -> "$label ・ ほか${remainingCount}件"
                    label.isNotEmpty() -> label
                    remainingCount > 0 -> "ほか${remainingCount}件 (24h以内)"
                    else -> "24h以内の予定"
                }
                views2x1.setTextViewText(R.id.tv_sub_2x1, sub2x1)
            } else {
                views1x1.setTextViewText(R.id.tv_badge_1x1, "次のアラーム")
                views1x1.setTextViewText(R.id.tv_time_1x1, "なし")
                views1x1.setTextViewText(R.id.tv_sub_1x1, "24h以内")

                views2x1.setTextViewText(R.id.tv_time_2x1, "なし")
                views2x1.setTextViewText(R.id.tv_date_2x1, "次のアラーム")
                views2x1.setTextViewText(R.id.tv_device_2x1, "24時間以内の予定なし")
                views2x1.setTextViewText(
                    R.id.tv_sub_2x1,
                    if (summary == null) "タップして確認" else "タップしてアプリを開く"
                )
            }

            return Pair(views1x1, views2x1)
        }

        private fun updateSingleWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int
        ) {
            val (views1x1, views2x1) = buildRemoteViews(context)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val sizedViews = RemoteViews(
                    mapOf(
                        SizeF(50f, 50f) to views1x1,
                        SizeF(120f, 50f) to views2x1
                    )
                )
                appWidgetManager.updateAppWidget(appWidgetId, sizedViews)
            } else {
                val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
                val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 140)
                val selected = if (minWidth < WIDTH_THRESHOLD_DP) views1x1 else views2x1
                appWidgetManager.updateAppWidget(appWidgetId, selected)
            }
        }
    }
}
