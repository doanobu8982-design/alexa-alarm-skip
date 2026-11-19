'use strict';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 60 * 1000;
const JST_TIMEZONE = 'Asia/Tokyo';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAY_TO_JS_DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const RECURRING_LABELS = {
  P1D: '毎日',
  'XXXX-WD': '平日（月〜金）',
  'XXXX-WE': '週末（土日）',
  'XXXX-WXX-1': '毎週月曜',
  'XXXX-WXX-2': '毎週火曜',
  'XXXX-WXX-3': '毎週水曜',
  'XXXX-WXX-4': '毎週木曜',
  'XXXX-WXX-5': '毎週金曜',
  'XXXX-WXX-6': '毎週土曜',
  'XXXX-WXX-7': '毎週日曜',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseTimestampMs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const t = Date.parse(hasTz ? s : `${s}+09:00`);
  return Number.isNaN(t) ? null : t;
}

function nextTriggerMs(n) {
  if (!n || typeof n !== 'object') return null;
  if (n.trigger && n.trigger.scheduledTime) {
    const t = parseTimestampMs(n.trigger.scheduledTime);
    if (t !== null) return t;
  }
  if (n.alarmTime && typeof n.alarmTime === 'string') {
    const t = parseTimestampMs(n.alarmTime);
    if (t !== null) return t;
  }
  if (typeof n.alarmTime === 'number' && n.alarmTime > 0) {
    return n.alarmTime;
  }
  if (n.originalDate && n.originalTime) {
    const t = parseTimestampMs(`${n.originalDate}T${n.originalTime}`);
    if (t !== null) return t;
  }
  return null;
}

function formatRecurring(pattern) {
  if (!pattern) return '1回のみ';
  return RECURRING_LABELS[pattern] || String(pattern);
}

function toJstDate(epochMs) {
  return new Date(epochMs + JST_OFFSET_MS);
}

function pad2(num) {
  return String(num).padStart(2, '0');
}

function jstDateKey(epochMs) {
  const dt = toJstDate(epochMs);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function formatJstTimeWithMs(epochMs) {
  const dt = toJstDate(epochMs);
  return `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}.000`;
}

function formatJstClock(epochMs) {
  const dt = toJstDate(epochMs);
  return `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;
}

function getRecurrenceRule(n) {
  if (!n || typeof n !== 'object') return null;
  const pattern = n.recurringPattern;
  if (pattern === 'P1D') {
    return { freq: 'DAILY', days: [0, 1, 2, 3, 4, 5, 6] };
  }
  if (pattern === 'XXXX-WD') {
    return { freq: 'WEEKLY', days: [1, 2, 3, 4, 5] };
  }
  if (pattern === 'XXXX-WE') {
    return { freq: 'WEEKLY', days: [0, 6] };
  }
  const dayMatch = typeof pattern === 'string' && pattern.match(/^XXXX-WXX-([1-7])$/);
  if (dayMatch) {
    const isoDay = Number(dayMatch[1]);
    return { freq: 'WEEKLY', days: [isoDay === 7 ? 0 : isoDay] };
  }

  const trigRec = n.trigger && n.trigger.recurrence;
  if (trigRec && trigRec.freq) {
    if (trigRec.interval && trigRec.interval > 1) return null;
    if (trigRec.freq === 'DAILY') {
      return { freq: 'DAILY', days: [0, 1, 2, 3, 4, 5, 6] };
    }
    if (trigRec.freq === 'WEEKLY' && Array.isArray(trigRec.byDay) && trigRec.byDay.length > 0) {
      const days = trigRec.byDay.map((code) => WEEKDAY_TO_JS_DAY[code]).filter((d) => d !== undefined);
      if (days.length > 0) return { freq: 'WEEKLY', days };
    }
  }

  const rRule = n.rRuleData;
  if (rRule && rRule.frequency) {
    const interval = Array.isArray(rRule.intervals) && rRule.intervals[0] ? rRule.intervals[0] : 1;
    if (interval > 1) return null;
    if (rRule.frequency === 'DAILY') {
      return { freq: 'DAILY', days: [0, 1, 2, 3, 4, 5, 6] };
    }
    if (rRule.frequency === 'WEEKLY' && Array.isArray(rRule.byWeekDays) && rRule.byWeekDays.length > 0) {
      const days = rRule.byWeekDays.map((code) => WEEKDAY_TO_JS_DAY[code]).filter((d) => d !== undefined);
      if (days.length > 0) return { freq: 'WEEKLY', days };
    }
  }

  return null;
}

function extractAlarmTimeOfDay(n, fallbackMs) {
  if (n && typeof n.originalTime === 'string') {
    const m = n.originalTime.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return {
        hours: Number(m[1]),
        minutes: Number(m[2]),
        seconds: Number(m[3] || 0),
      };
    }
  }
  if (fallbackMs) {
    const dt = toJstDate(fallbackMs);
    return {
      hours: dt.getUTCHours(),
      minutes: dt.getUTCMinutes(),
      seconds: dt.getUTCSeconds(),
    };
  }
  return null;
}

function computeExpectedNextMs(n, nowMs) {
  const rule = getRecurrenceRule(n);
  if (!rule) return null;
  const scheduledMs = nextTriggerMs(n);
  const tod = extractAlarmTimeOfDay(n, scheduledMs);
  if (!tod) return null;

  const jstNow = toJstDate(nowMs);
  const y = jstNow.getUTCFullYear();
  const m = jstNow.getUTCMonth();
  const d = jstNow.getUTCDate();

  for (let offset = 0; offset <= 14; offset += 1) {
    const candJst = new Date(Date.UTC(y, m, d + offset, tod.hours, tod.minutes, tod.seconds));
    if (!rule.days.includes(candJst.getUTCDay())) continue;
    const candMs = candJst.getTime() - JST_OFFSET_MS;
    if (candMs > nowMs) {
      return candMs;
    }
  }
  return null;
}

function formatTimeParts(whenMs, nowMs) {
  const dt = toJstDate(whenMs);
  const month = dt.getUTCMonth() + 1;
  const day = dt.getUTCDate();
  const weekday = WEEKDAYS_JA[dt.getUTCDay()];
  const timeText = `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}`;
  const whenText = `${dt.getUTCFullYear()}/${month}/${day} ${timeText}:${pad2(dt.getUTCSeconds())}`;

  const jstNow = toJstDate(nowMs);
  const todayKey = jstDateKey(nowMs);
  const tomorrowMs = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + 1) - JST_OFFSET_MS;
  const tomorrowKey = jstDateKey(tomorrowMs);
  const targetKey = jstDateKey(whenMs);

  let dateLabel = `${month}/${day} (${weekday})`;
  let dayBadge = `${month}/${day} (${weekday})`;
  if (targetKey === todayKey) {
    dateLabel = `今日 ${month}/${day} (${weekday})`;
    dayBadge = `今日 (${weekday})`;
  } else if (targetKey === tomorrowKey) {
    dateLabel = `明日 ${month}/${day} (${weekday})`;
    dayBadge = `明日 (${weekday})`;
  }

  return { timeText, dayBadge, dateLabel, dateKey: targetKey, whenText };
}

function buildV2Recurrence(notification) {
  const pattern = notification && notification.recurringPattern;
  if (pattern === 'P1D') {
    return { freq: 'DAILY', interval: 1 };
  }
  if (pattern === 'XXXX-WD') {
    return { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] };
  }
  if (pattern === 'XXXX-WE') {
    return { freq: 'WEEKLY', interval: 1, byDay: ['SA', 'SU'] };
  }
  const dayMatch = typeof pattern === 'string' && pattern.match(/^XXXX-WXX-([1-7])$/);
  if (dayMatch) {
    return { freq: 'WEEKLY', interval: 1, byDay: [WEEKDAY_CODES[Number(dayMatch[1]) - 1]] };
  }
  const rRule = notification && notification.rRuleData;
  if (rRule && rRule.frequency) {
    const rec = {
      freq: rRule.frequency,
      interval: Array.isArray(rRule.intervals) && rRule.intervals[0] ? rRule.intervals[0] : 1,
    };
    if (Array.isArray(rRule.byWeekDays) && rRule.byWeekDays.length > 0) {
      rec.byDay = rRule.byWeekDays;
    }
    return rec;
  }
  return null;
}

function resolveRestoreDateTime(baseNotif, desiredDate, desiredTime, nowMs = Date.now()) {
  if (desiredDate && desiredTime) {
    const desiredMs = parseTimestampMs(`${desiredDate}T${desiredTime}`);
    if (desiredMs !== null && desiredMs > nowMs - PAST_GRACE_MS) {
      return { date: desiredDate, time: desiredTime };
    }
  }
  const expMs = computeExpectedNextMs(baseNotif, nowMs);
  if (expMs !== null) {
    return {
      date: jstDateKey(expMs),
      time: baseNotif.originalTime || formatJstTimeWithMs(expMs),
    };
  }
  let dateStr = baseNotif.originalDate;
  const timeStr = baseNotif.originalTime || '07:00:00.000';
  if (dateStr) {
    const curMs = parseTimestampMs(`${dateStr}T${timeStr}`);
    if (curMs !== null && curMs < nowMs) {
      const bumped = new Date(curMs + WINDOW_MS);
      dateStr = jstDateKey(bumped.getTime());
    }
  }
  return { date: dateStr, time: timeStr };
}

module.exports = {
  JST_OFFSET_MS,
  JST_TIMEZONE,
  PAST_GRACE_MS,
  RECURRING_LABELS,
  WEEKDAYS_JA,
  WEEKDAY_CODES,
  WEEKDAY_TO_JS_DAY,
  WINDOW_MS,
  buildV2Recurrence,
  cloneJson,
  computeExpectedNextMs,
  delay,
  extractAlarmTimeOfDay,
  formatJstClock,
  formatJstTimeWithMs,
  formatRecurring,
  formatTimeParts,
  getRecurrenceRule,
  jstDateKey,
  nextTriggerMs,
  pad2,
  parseTimestampMs,
  resolveRestoreDateTime,
  toJstDate,
};
