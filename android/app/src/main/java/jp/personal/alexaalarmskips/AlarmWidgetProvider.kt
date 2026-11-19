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
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject

internal data class CompactDisplayTexts(
    val isEmpty: Boolean = false,
    val emptyLine1: String = "",
    val emptyLine2: String = "",
    val emptyLine3: String = "",
    val badgeText: String = "",
    val timeText: String = "",
    val subText: String = ""
)

internal data class WideDisplayTexts(
    val isEmpty: Boolean,
    val emptyText: String = "",
    val timeText: String = "",
    val dateText: String = "",
    val subText: String = ""
)

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

        internal const val COMPACT_MIN_WIDTH_DP = 40f
        internal const val COMPACT_MIN_HEIGHT_DP = 40f
        internal const val WIDE_WIDTH_THRESHOLD_DP = 95
        internal const val WIDE_MIN_HEIGHT_DP = 40f

        internal fun shouldUseWideLayout(minWidthDp: Int): Boolean {
            return minWidthDp >= WIDE_WIDTH_THRESHOLD_DP
        }

        internal fun sanitizeDisplayText(raw: String?): String {
            if (raw == null) return ""
            val trimmed = raw.trim()
            if (trimmed.isEmpty() || trimmed.equals("null", ignoreCase = true)) {
                return ""
            }
            return trimmed
        }

        internal fun resolveCompactTexts(
            authExpired: Boolean,
            hasAlarm: Boolean,
            nextTimeText: String?,
            dayBadge: String?,
            remainingCount: Int
        ): CompactDisplayTexts {
            if (authExpired) {
                return CompactDisplayTexts(
                    badgeText = "Alexa",
                    timeText = "要ログイン",
                    subText = "タップして開く"
                )
            }
            if (hasAlarm) {
                return CompactDisplayTexts(
                    isEmpty = false,
                    badgeText = sanitizeDisplayText(dayBadge),
                    timeText = sanitizeDisplayText(nextTimeText),
                    subText = if (remainingCount > 0) "+${remainingCount}件" else ""
                )
            }
            return CompactDisplayTexts(
                isEmpty = true,
                emptyLine1 = "次の",
                emptyLine2 = "アラーム",
                emptyLine3 = "なし"
            )
        }

        internal fun resolveWideTexts(
            authExpired: Boolean,
            hasAlarm: Boolean,
            nextTimeText: String?,
            dayBadge: String?,
            label: String?,
            remainingCount: Int
        ): WideDisplayTexts {
            if (authExpired) {
                return WideDisplayTexts(
                    isEmpty = false,
                    timeText = "要ログイン",
                    dateText = "タップして",
                    subText = "再ログイン"
                )
            }
            if (hasAlarm) {
                val cleanTime = sanitizeDisplayText(nextTimeText)
                val cleanDate = sanitizeDisplayText(dayBadge)
                val cleanLabel = sanitizeDisplayText(label)
                val sub = if (remainingCount > 0) "+${remainingCount}件" else cleanLabel
                return WideDisplayTexts(
                    isEmpty = false,
                    timeText = cleanTime,
                    dateText = cleanDate,
                    subText = sub
                )
            }
            return WideDisplayTexts(
                isEmpty = true,
                emptyText = "次のアラームなし"
            )
        }

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

            val rawTimeText = nextAlarm?.let { sanitizeDisplayText(it.optString("timeText", "")) } ?: ""
            val rawDayBadge = nextAlarm?.let { sanitizeDisplayText(it.optString("dayBadge", "")) } ?: ""
            val rawLabel = nextAlarm?.let { sanitizeDisplayText(it.optString("label", "")) } ?: ""
            val remainingCount = summary?.optInt("remainingCount", 0) ?: 0

            val views1x1 = RemoteViews(context.packageName, R.layout.widget_alarm_1x1)
            val views2x1 = RemoteViews(context.packageName, R.layout.widget_alarm_2x1)

            val pendingIntent = createLaunchPendingIntent(context)
            views1x1.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
            views2x1.setOnClickPendingIntent(R.id.widget_root, pendingIntent)

            val compactTexts = resolveCompactTexts(
                authExpired = authExpired,
                hasAlarm = isValidAlarm,
                nextTimeText = rawTimeText,
                dayBadge = rawDayBadge,
                remainingCount = remainingCount
            )
            if (compactTexts.isEmpty) {
                views1x1.setViewVisibility(R.id.layout_compact_content_1x1, View.GONE)
                views1x1.setViewVisibility(R.id.layout_compact_empty_1x1, View.VISIBLE)
                views1x1.setTextViewText(R.id.tv_empty_line1_1x1, compactTexts.emptyLine1)
                views1x1.setTextViewText(R.id.tv_empty_line2_1x1, compactTexts.emptyLine2)
                views1x1.setTextViewText(R.id.tv_empty_line3_1x1, compactTexts.emptyLine3)
            } else {
                views1x1.setViewVisibility(R.id.layout_compact_content_1x1, View.VISIBLE)
                views1x1.setViewVisibility(R.id.layout_compact_empty_1x1, View.GONE)
                views1x1.setTextViewText(R.id.tv_badge_1x1, compactTexts.badgeText)
                views1x1.setTextViewText(R.id.tv_time_1x1, compactTexts.timeText)
                if (compactTexts.subText.isBlank()) {
                    views1x1.setViewVisibility(R.id.tv_sub_1x1, View.GONE)
                } else {
                    views1x1.setViewVisibility(R.id.tv_sub_1x1, View.VISIBLE)
                    views1x1.setTextViewText(R.id.tv_sub_1x1, compactTexts.subText)
                }
            }

            val wideTexts = resolveWideTexts(
                authExpired = authExpired,
                hasAlarm = isValidAlarm,
                nextTimeText = rawTimeText,
                dayBadge = rawDayBadge,
                label = rawLabel,
                remainingCount = remainingCount
            )
            if (wideTexts.isEmpty) {
                views2x1.setViewVisibility(R.id.layout_wide_content_2x1, View.GONE)
                views2x1.setViewVisibility(R.id.tv_empty_2x1, View.VISIBLE)
                views2x1.setTextViewText(R.id.tv_empty_2x1, wideTexts.emptyText)
            } else {
                views2x1.setViewVisibility(R.id.layout_wide_content_2x1, View.VISIBLE)
                views2x1.setViewVisibility(R.id.tv_empty_2x1, View.GONE)
                views2x1.setTextViewText(R.id.tv_time_2x1, wideTexts.timeText)
                views2x1.setTextViewText(R.id.tv_date_2x1, wideTexts.dateText)
                if (wideTexts.subText.isBlank()) {
                    views2x1.setViewVisibility(R.id.tv_sub_2x1, View.GONE)
                } else {
                    views2x1.setViewVisibility(R.id.tv_sub_2x1, View.VISIBLE)
                    views2x1.setTextViewText(R.id.tv_sub_2x1, wideTexts.subText)
                }
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
                val sizeMapping = mapOf(
                    SizeF(COMPACT_MIN_WIDTH_DP, COMPACT_MIN_HEIGHT_DP) to views1x1,
                    SizeF(WIDE_WIDTH_THRESHOLD_DP.toFloat(), WIDE_MIN_HEIGHT_DP) to views2x1
                )
                appWidgetManager.updateAppWidget(appWidgetId, RemoteViews(sizeMapping))
            } else {
                val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
                val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 140)
                val selected = if (shouldUseWideLayout(minWidth)) views2x1 else views1x1
                appWidgetManager.updateAppWidget(appWidgetId, selected)
            }
        }
    }
}
