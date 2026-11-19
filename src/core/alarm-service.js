'use strict';

const {
  PAST_GRACE_MS,
  WINDOW_MS,
  buildV2Recurrence,
  cloneJson,
  computeExpectedNextMs,
  delay,
  formatJstClock,
  formatJstTimeWithMs,
  formatRecurring,
  formatTimeParts,
  jstDateKey,
  nextTriggerMs,
  resolveRestoreDateTime,
} = require('./alarm-time');

const DEFAULT_RESTORE_WAIT_MS = 500;

function isAlarmType(type) {
  return type === 'Alarm' || type === 'MusicAlarm';
}

function serializeAlarm(n, deviceMap, whenMs, nowMs, options = {}) {
  const parts = formatTimeParts(whenMs, nowMs);
  const serial = n.deviceSerialNumber || '';
  const isSkipped = Boolean(options.isSkipped);
  const effectiveDate = isSkipped ? parts.dateKey : (n.originalDate || parts.dateKey);
  const effectiveTime = n.originalTime || formatJstTimeWithMs(whenMs);
  return {
    id: n.notificationIndex || n.id || '',
    notificationIndex: n.notificationIndex || n.id || '',
    deviceSerialNumber: serial,
    deviceName: deviceMap[serial] || serial || '不明な端末',
    type: n.type || 'Alarm',
    status: n.status || 'ON',
    label: n.alarmLabel || n.reminderLabel || n.label || '',
    recurringPattern: n.recurringPattern || null,
    recurringText: formatRecurring(n.recurringPattern),
    originalDate: effectiveDate,
    originalTime: effectiveTime,
    scheduledDate: n.originalDate || (options.scheduledMs ? jstDateKey(options.scheduledMs) : ''),
    whenMs,
    timeText: parts.timeText,
    dayBadge: parts.dayBadge,
    dateLabel: parts.dateLabel,
    dateKey: parts.dateKey,
    whenText: parts.whenText,
    isSkipped,
    notification: n,
  };
}

function classifyNotifications(notifications, deviceMap = {}, nowMs = Date.now()) {
  const minMs = nowMs - PAST_GRACE_MS;
  const maxMs = nowMs + WINDOW_MS;
  const activeItems = [];
  const skippedItems = [];

  for (const n of Array.isArray(notifications) ? notifications : []) {
    if (!n || !isAlarmType(n.type)) continue;
    if (n.status !== 'ON') continue;
    const scheduledMs = nextTriggerMs(n);
    if (!scheduledMs) continue;

    const expectedNextMs = computeExpectedNextMs(n, nowMs);
    const isSkipped = Boolean(expectedNextMs && scheduledMs > expectedNextMs + PAST_GRACE_MS);
    if (isSkipped) {
      skippedItems.push({ n, whenMs: expectedNextMs, scheduledMs });
      continue;
    }

    if (scheduledMs > minMs && scheduledMs <= maxMs) {
      activeItems.push({ n, whenMs: scheduledMs, scheduledMs });
    }
  }

  activeItems.sort((a, b) => a.whenMs - b.whenMs);
  skippedItems.sort((a, b) => a.whenMs - b.whenMs);

  return {
    active: activeItems.map(({ n, whenMs, scheduledMs }) => (
      serializeAlarm(n, deviceMap, whenMs, nowMs, { isSkipped: false, scheduledMs })
    )),
    skipped: skippedItems.map(({ n, whenMs, scheduledMs }) => (
      serializeAlarm(n, deviceMap, whenMs, nowMs, { isSkipped: true, scheduledMs })
    )),
  };
}

function findNotificationById(notifications, id) {
  if (!id) return null;
  return notifications.find((n) => n.notificationIndex === id || n.id === id) || null;
}

function buildWidgetSummary(payload) {
  const active = payload && Array.isArray(payload.active) ? payload.active : [];
  const next = active.length > 0 ? active[0] : null;
  return {
    hasAlarm: active.length > 0,
    nextAlarm: next ? {
      id: next.id,
      timeText: next.timeText,
      dayBadge: next.dayBadge,
      dateLabel: next.dateLabel,
      deviceName: next.deviceName,
      label: next.label || '',
      whenMs: next.whenMs,
    } : null,
    remainingCount: Math.max(0, active.length - 1),
    totalCount: active.length,
    checkedAt: (payload && payload.checkedAt) || '',
  };
}

function createAlarmService(authManager, options = {}) {
  const restoreWaitMs = options.restoreWaitMs !== undefined ? options.restoreWaitMs : DEFAULT_RESTORE_WAIT_MS;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();

  function getDevicesMap() {
    return authManager.connectAlexa().then((client) => new Promise((resolve, reject) => {
      if (typeof client.getDevices !== 'function') {
        resolve({});
        return;
      }
      client.getDevices((err, res) => {
        if (err) {
          reject(authManager.normalizeAlexaError(err));
          return;
        }
        const devices = Array.isArray(res) ? res : (res && res.devices ? res.devices : []);
        const map = {};
        for (const d of devices) {
          if (!d || !d.serialNumber) continue;
          map[d.serialNumber] = d.accountName || d.deviceName || d.serialNumber;
        }
        resolve(map);
      });
    }));
  }

  function getNotifications() {
    return authManager.connectAlexa().then((client) => new Promise((resolve, reject) => {
      client.getNotifications(false, (err, result) => {
        if (err) {
          reject(authManager.normalizeAlexaError(err));
          return;
        }
        resolve((result && result.notifications) || []);
      });
    }));
  }

  async function buildAlarmsPayload() {
    const [notifications, deviceMap] = await Promise.all([
      getNotifications(),
      getDevicesMap(),
    ]);
    const nowMs = nowFn();
    const { active, skipped } = classifyNotifications(notifications, deviceMap, nowMs);

    return {
      active,
      skipped,
      deviceCount: Object.keys(deviceMap).length,
      checkedAt: formatJstClock(nowMs),
    };
  }

  async function getWidgetSummary() {
    const payload = await buildAlarmsPayload();
    return buildWidgetSummary(payload);
  }

  function cancelNotificationAsync(client, notification) {
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(authManager.normalizeAlexaError(err)) : resolve());
      try {
        if (typeof notification.cancel === 'function') {
          notification.cancel(done);
          return;
        }
        if (typeof client.cancelNotification === 'function') {
          if (!client.endpoints || !client.endpoints.alexaApiUrl) {
            reject(new Error('Alexa API エンドポイントが未初期化です。画面を更新してやり直してください。'));
            return;
          }
          client.cancelNotification(notification, done);
          return;
        }
        reject(new Error('cancelNotification 関数が利用できません。'));
      } catch (e) {
        reject(authManager.normalizeAlexaError(e));
      }
    });
  }

  function changeNotificationAsync(client, notification, value) {
    return new Promise((resolve, reject) => {
      if (typeof client.changeNotification !== 'function') {
        reject(new Error('changeNotification 関数が利用できません。'));
        return;
      }
      try {
        client.changeNotification(cloneJson(notification), value, (err) => {
          if (err) {
            reject(authManager.normalizeAlexaError(err));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(authManager.normalizeAlexaError(e));
      }
    });
  }

  function setNotificationV2Async(client, notificationIndex, payload) {
    return new Promise((resolve, reject) => {
      client.setNotificationV2(notificationIndex, payload, (err) => {
        if (err) {
          reject(authManager.normalizeAlexaError(err));
          return;
        }
        resolve();
      });
    });
  }

  async function skipAlarm(rawBody) {
    const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const client = await authManager.connectAlexa();
    const notifFromBody = body.notification && typeof body.notification === 'object' ? body.notification : null;
    const requestedId = body.id
      || body.notificationIndex
      || (notifFromBody && (notifFromBody.notificationIndex || notifFromBody.id))
      || '';
    const notifications = await getNotifications();
    const target = findNotificationById(notifications, requestedId) || notifFromBody;
    if (!target || typeof target !== 'object') {
      throw new Error('スキップ対象のアラームが見つかりませんでした。');
    }

    await cancelNotificationAsync(client, target);
    const payload = await buildAlarmsPayload();
    return { ok: true, skippedId: requestedId || target.notificationIndex || target.id || '', ...payload };
  }

  async function restoreAlarm(body) {
    const reqBody = body && typeof body === 'object' ? body : {};
    const client = await authManager.connectAlexa();
    const clientNotif = reqBody.notification || null;
    const requestedId = reqBody.id
      || reqBody.notificationIndex
      || (clientNotif && (clientNotif.notificationIndex || clientNotif.id));

    const notifications = await getNotifications();
    const serverNotif = findNotificationById(notifications, requestedId);
    const baseNotif = serverNotif ? cloneJson(serverNotif) : (clientNotif ? cloneJson(clientNotif) : null);
    if (!baseNotif) {
      throw new Error('復活対象のアラームが見つかりませんでした。');
    }

    const targetDt = resolveRestoreDateTime(
      baseNotif,
      reqBody.originalDate || (clientNotif && clientNotif.originalDate),
      reqBody.originalTime || (clientNotif && clientNotif.originalTime),
      nowFn()
    );
    if (targetDt.date && targetDt.time) {
      baseNotif.originalDate = targetDt.date;
      baseNotif.originalTime = targetDt.time;
    }

    await changeNotificationAsync(client, baseNotif, false);
    await delay(restoreWaitMs);

    const assetId = baseNotif.musicAlarmId
      ? `MUSIC-${baseNotif.musicAlarmId}`
      : (baseNotif.sound && baseNotif.sound.id);
    const targetIndex = baseNotif.notificationIndex || requestedId;

    if (isAlarmType(baseNotif.type) && assetId && targetIndex && typeof client.setNotificationV2 === 'function' && targetDt.date && targetDt.time) {
      const trigger = { scheduledTime: `${targetDt.date}T${targetDt.time.slice(0, 8)}` };
      const recurrence = buildV2Recurrence(baseNotif);
      if (recurrence) {
        trigger.recurrence = recurrence;
      }
      await setNotificationV2Async(client, targetIndex, {
        trigger,
        extensions: [],
        assets: [{ type: 'TONE', assetId }],
      });
    } else {
      await changeNotificationAsync(client, baseNotif, true);
    }

    const payload = await buildAlarmsPayload();
    return { ok: true, restoredId: requestedId, ...payload };
  }

  return {
    getDevicesMap,
    getNotifications,
    buildAlarmsPayload,
    getWidgetSummary,
    cancelNotificationAsync,
    changeNotificationAsync,
    setNotificationV2Async,
    skipAlarm,
    restoreAlarm,
  };
}

module.exports = {
  buildWidgetSummary,
  classifyNotifications,
  createAlarmService,
  findNotificationById,
  isAlarmType,
  serializeAlarm,
};
