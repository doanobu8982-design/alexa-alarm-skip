package jp.personal.alexaalarmskips

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmWidgetProviderTest {

    @Test
    fun shouldUseWideLayout_checksThreshold95dp() {
        assertFalse(AlarmWidgetProvider.shouldUseWideLayout(70))
        assertFalse(AlarmWidgetProvider.shouldUseWideLayout(94))
        assertTrue(AlarmWidgetProvider.shouldUseWideLayout(95))
        assertTrue(AlarmWidgetProvider.shouldUseWideLayout(110))
        assertTrue(AlarmWidgetProvider.shouldUseWideLayout(150))
    }

    @Test
    fun sanitizeDisplayText_filtersNullStringsAndWhitespace() {
        assertEquals("", AlarmWidgetProvider.sanitizeDisplayText(null))
        assertEquals("", AlarmWidgetProvider.sanitizeDisplayText("null"))
        assertEquals("", AlarmWidgetProvider.sanitizeDisplayText(" NULL "))
        assertEquals("", AlarmWidgetProvider.sanitizeDisplayText(""))
        assertEquals("", AlarmWidgetProvider.sanitizeDisplayText("   "))
        assertEquals("朝アラーム", AlarmWidgetProvider.sanitizeDisplayText("朝アラーム"))
        assertEquals("朝アラーム", AlarmWidgetProvider.sanitizeDisplayText("  朝アラーム  "))
    }

    @Test
    fun resolveWideTexts_formatsAllStatesWithoutLegacyPlaceholders() {
        val multi = AlarmWidgetProvider.resolveWideTexts(
            authExpired = false,
            hasAlarm = true,
            nextTimeText = "08:00",
            dayBadge = "明日 (金)",
            label = "起床",
            remainingCount = 2
        )
        assertFalse(multi.isEmpty)
        assertEquals("08:00", multi.timeText)
        assertEquals("明日 (金)", multi.dateText)
        assertEquals("+2件", multi.subText)

        val singleWithLabel = AlarmWidgetProvider.resolveWideTexts(
            authExpired = false,
            hasAlarm = true,
            nextTimeText = "07:30",
            dayBadge = "今日",
            label = "起床",
            remainingCount = 0
        )
        assertFalse(singleWithLabel.isEmpty)
        assertEquals("07:30", singleWithLabel.timeText)
        assertEquals("今日", singleWithLabel.dateText)
        assertEquals("起床", singleWithLabel.subText)

        val singleNoLabel = AlarmWidgetProvider.resolveWideTexts(
            authExpired = false,
            hasAlarm = true,
            nextTimeText = "07:30",
            dayBadge = "今日",
            label = "null",
            remainingCount = 0
        )
        assertFalse(singleNoLabel.isEmpty)
        assertEquals("07:30", singleNoLabel.timeText)
        assertEquals("今日", singleNoLabel.dateText)
        assertEquals("", singleNoLabel.subText)
        assertFalse(singleNoLabel.subText.contains("24h以内"))

        val noAlarm = AlarmWidgetProvider.resolveWideTexts(
            authExpired = false,
            hasAlarm = false,
            nextTimeText = null,
            dayBadge = null,
            label = null,
            remainingCount = 0
        )
        assertTrue(noAlarm.isEmpty)
        assertEquals("次のアラームなし", noAlarm.emptyText)
        assertEquals("", noAlarm.timeText)
        assertEquals("", noAlarm.dateText)
        assertEquals("", noAlarm.subText)
        assertFalse(noAlarm.emptyText.contains("--:--"))
        assertFalse(noAlarm.emptyText.contains("24h以内"))
        assertFalse(noAlarm.emptyText.contains("スキップ"))

        val authExpired = AlarmWidgetProvider.resolveWideTexts(
            authExpired = true,
            hasAlarm = true,
            nextTimeText = "08:00",
            dayBadge = "今日",
            label = "起床",
            remainingCount = 1
        )
        assertFalse(authExpired.isEmpty)
        assertEquals("要ログイン", authExpired.timeText)
        assertEquals("タップして", authExpired.dateText)
        assertEquals("再ログイン", authExpired.subText)
    }

    @Test
    fun resolveCompactTexts_omits24hLabelAndFormatsAllStates() {
        val multi = AlarmWidgetProvider.resolveCompactTexts(
            authExpired = false,
            hasAlarm = true,
            nextTimeText = "08:00",
            dayBadge = "明日 (金)",
            remainingCount = 2
        )
        assertFalse(multi.isEmpty)
        assertEquals("明日 (金)", multi.badgeText)
        assertEquals("08:00", multi.timeText)
        assertEquals("+2件", multi.subText)

        val single = AlarmWidgetProvider.resolveCompactTexts(
            authExpired = false,
            hasAlarm = true,
            nextTimeText = "07:30",
            dayBadge = "今日",
            remainingCount = 0
        )
        assertFalse(single.isEmpty)
        assertEquals("今日", single.badgeText)
        assertEquals("07:30", single.timeText)
        assertEquals("", single.subText)
        assertFalse(single.subText.contains("24h以内"))

        val noAlarm = AlarmWidgetProvider.resolveCompactTexts(
            authExpired = false,
            hasAlarm = false,
            nextTimeText = null,
            dayBadge = null,
            remainingCount = 0
        )
        assertTrue(noAlarm.isEmpty)
        assertEquals("次の", noAlarm.emptyLine1)
        assertEquals("アラーム", noAlarm.emptyLine2)
        assertEquals("なし", noAlarm.emptyLine3)
        assertEquals("", noAlarm.badgeText)
        assertEquals("", noAlarm.timeText)
        assertEquals("", noAlarm.subText)
        assertFalse(noAlarm.emptyLine1.contains("次回なし"))
        assertFalse(noAlarm.emptyLine3.contains("--:--"))
        assertFalse(noAlarm.emptyLine2.contains("24h以内"))

        val authExpired = AlarmWidgetProvider.resolveCompactTexts(
            authExpired = true,
            hasAlarm = true,
            nextTimeText = "08:00",
            dayBadge = "今日",
            remainingCount = 1
        )
        assertFalse(authExpired.isEmpty)
        assertEquals("Alexa", authExpired.badgeText)
        assertEquals("要ログイン", authExpired.timeText)
        assertEquals("タップして開く", authExpired.subText)
    }
}
