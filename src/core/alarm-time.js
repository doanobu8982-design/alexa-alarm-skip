'use strict';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 60 * 1000;
const JST_TIMEZONE = 'Asia/Tokyo';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAY_TO_JS_DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DISPLAY_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

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

function formatRecurrenceRule(rule) {
  if (!rule || !Array.isArray(rule.days) || rule.days.length === 0) return null;
  const uniqueDays = Array.from(new Set(rule.days));
  if (rule.freq === 'DAILY' || uniqueDays.length === 7) {
    return '毎日';
  }
  if (uniqueDays.length === 5 && [1, 2, 3, 4, 5].every((d) => uniqueDays.includes(d))) {
    return '平日（月〜金）';
  }
  if (uniqueDays.length === 2 && uniqueDays.includes(0) && uniqueDays.includes(6)) {
    return '週末（土日）';
  }
  if (uniqueDays.length === 1) {
    return `毎週${WEEKDAYS_JA[uniqueDays[0]]}曜`;
  }
  const joined = DISPLAY_WEEKDAY_ORDER
    .filter((d) => uniqueDays.includes(d))
    .map((d) => WEEKDAYS_JA[d])
    .join('・');
  return joined ? `毎週 ${joined}` : null;
}

function formatRecurring(patternOrNotification) {
  if (patternOrNotification && typeof patternOrNotification === 'object') {
    const rule = getRecurrenceRule(patternOrNotification);
    const formatted = formatRecurrenceRule(rule);
    if (formatted) return formatted;
    const pattern = patternOrNotification.recurringPattern;
    return pattern ? (RECURRING_LABELS[pattern] || String(pattern)) : '1回のみ';
  }
  if (!patternOrNotification) return '1回のみ';
  return RECURRING_LABELS[patternOrNotification] || String(patternOrNotification);
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

function extractUniqueJsDays(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return [];
  const days = codes
    .map((code) => (typeof code === 'string' ? WEEKDAY_TO_JS_DAY[code.trim().toUpperCase()] : undefined))
    .filter((d) => d !== undefined);
  return Array.from(new Set(days));
}

function extractValidWeekdayCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return [];
  const valid = codes
    .map((code) => (typeof code === 'string' ? code.trim().toUpperCase() : ''))
    .filter((code) => code && WEEKDAY_TO_JS_DAY[code] !== undefined);
  return Array.from(new Set(valid));
}

function parseRRuleString(ruleStr) {
  const empty = { freq: null, interval: null, byDay: [] };
  if (typeof ruleStr !== 'string' || !ruleStr.trim()) return empty;
  let freq = null;
  let interval = null;
  let byDay = [];
  for (const part of ruleStr.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim().toUpperCase();
    const val = part.slice(eqIdx + 1).trim().toUpperCase();
    if (!val) continue;
    if (key === 'FREQ') {
      freq = val;
    } else if (key === 'INTERVAL') {
      const parsed = Number(val);
      if (Number.isInteger(parsed) && parsed > 0) {
        interval = parsed;
      }
    } else if (key === 'BYDAY') {
      byDay = extractValidWeekdayCodes(val.split(','));
    }
  }
  return { freq, interval, byDay };
}

function parseRRuleData(rRule) {
  if (!rRule || typeof rRule !== 'object') return null;

  let parsedRule = { freq: null, interval: null, byDay: [] };
  if (Array.isArray(rRule.recurrenceRules)) {
    for (const raw of rRule.recurrenceRules) {
      const candidate = parseRRuleString(raw);
      if (candidate.freq || candidate.byDay.length > 0) {
        parsedRule = candidate;
        break;
      }
    }
  }

  const explicitDays = extractValidWeekdayCodes(rRule.byWeekDays);
  const byDayCodes = explicitDays.length > 0 ? explicitDays : parsedRule.byDay;

  let freq = typeof rRule.frequency === 'string' && rRule.frequency.trim()
    ? rRule.frequency.trim().toUpperCase()
    : parsedRule.freq;
  if (!freq && byDayCodes.length > 0) {
    freq = 'WEEKLY';
  }
  if (!freq) return null;

  let interval = 1;
  if (Array.isArray(rRule.intervals) && Number.isInteger(rRule.intervals[0]) && rRule.intervals[0] > 0) {
    interval = rRule.intervals[0];
  } else if (parsedRule.interval && parsedRule.interval > 0) {
    interval = parsedRule.interval;
  }

  if (freq === 'DAILY') {
    return { freq: 'DAILY', interval, byDay: [], days: [0, 1, 2, 3, 4, 5, 6] };
  }
  if (freq === 'WEEKLY' && byDayCodes.length > 0) {
    return {
      freq: 'WEEKLY',
      interval,
      byDay: byDayCodes,
      days: byDayCodes.map((c) => WEEKDAY_TO_JS_DAY[c]),
    };
  }
  return null;
}

function getRecurrenceRule(n) {
  if (!n || typeof n !== 'object') return null;

  const trigRec = n.trigger && n.trigger.recurrence;
  if (trigRec && trigRec.freq) {
    if (trigRec.interval && trigRec.interval > 1) return null;
    if (trigRec.freq === 'DAILY') {
      return { freq: 'DAILY', days: [0, 1, 2, 3, 4, 5, 6] };
    }
    if (trigRec.freq === 'WEEKLY') {
      const days = extractUniqueJsDays(trigRec.byDay);
      if (days.length > 0) return { freq: 'WEEKLY', days };
    }
  }

  const parsedRRule = parseRRuleData(n.rRuleData);
  if (parsedRRule) {
    if (parsedRRule.interval > 1) return null;
    return { freq: parsedRRule.freq, days: parsedRRule.days };
  }

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
  const trigRec = notification && notification.trigger && notification.trigger.recurrence;
  if (trigRec && trigRec.freq) {
    const byDay = extractValidWeekdayCodes(trigRec.byDay);
    if (trigRec.freq !== 'WEEKLY' || byDay.length > 0) {
      const rec = {
        freq: trigRec.freq,
        interval: trigRec.interval || 1,
      };
      if (byDay.length > 0) {
        rec.byDay = byDay;
      }
      return rec;
    }
  }

  const parsedRRule = parseRRuleData(notification && notification.rRuleData);
  if (parsedRRule) {
    const rec = {
      freq: parsedRRule.freq,
      interval: parsedRRule.interval,
    };
    if (parsedRRule.byDay.length > 0) {
      rec.byDay = [...parsedRRule.byDay];
    }
    return rec;
  }

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
  DISPLAY_WEEKDAY_ORDER,
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
  formatRecurrenceRule,
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
