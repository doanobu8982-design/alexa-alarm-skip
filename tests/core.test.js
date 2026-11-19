'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  buildV2Recurrence,
  computeExpectedNextMs,
  formatTimeParts,
  getRecurrenceRule,
  nextTriggerMs,
  parseTimestampMs,
  resolveRestoreDateTime,
} = require('../src/core/alarm-time');
const {
  AuthRequiredError,
  createAlexaAuthManager,
  isAuthError,
  prepareCookieForAlexaRemote,
} = require('../src/core/alexa-auth');
const {
  buildWidgetSummary,
  classifyNotifications,
  createAlarmService,
} = require('../src/core/alarm-service');
const { applyProxyPatch, patchedLookup, upstreamAgent } = require('../src/core/proxy-patch');
const {
  DEFAULT_APP_WINDOW_HEIGHT,
  DEFAULT_APP_WINDOW_WIDTH,
  createWindowManager,
  resetChromeWindowPlacement,
} = require('../src/desktop/window-manager');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-alarm-test-'));
}

function createMockAlexaClass(behavior = {}) {
  return class MockAlexaRemote extends EventEmitter {
    constructor() {
      super();
      this.endpoints = { alexaApiUrl: 'https://alexa.amazon.co.jp' };
      this.cookieData = { cookie: 'mock-cookie=1', macDms: { device_private_key: 'k' } };
      this.calls = {
        init: [],
        getDevices: 0,
        getNotifications: 0,
        cancelNotification: [],
        changeNotification: [],
        setNotificationV2: [],
      };
      if (behavior.onConstruct) {
        behavior.onConstruct(this);
      }
    }

    init(opts, cb) {
      this.calls.init.push(opts);
      if (behavior.init) {
        behavior.init(this, opts, cb);
        return;
      }
      process.nextTick(() => cb(null));
    }

    getDevices(cb) {
      this.calls.getDevices += 1;
      if (behavior.getDevices) {
        behavior.getDevices(this, cb);
        return;
      }
      process.nextTick(() => cb(null, { devices: [] }));
    }

    getNotifications(cached, cb) {
      this.calls.getNotifications += 1;
      if (behavior.getNotifications) {
        behavior.getNotifications(this, cached, cb);
        return;
      }
      process.nextTick(() => cb(null, { notifications: [] }));
    }

    cancelNotification(notification, cb) {
      this.calls.cancelNotification.push(notification);
      if (behavior.cancelNotification) {
        behavior.cancelNotification(this, notification, cb);
        return;
      }
      process.nextTick(() => cb(null));
    }

    changeNotification(notification, value, cb) {
      this.calls.changeNotification.push({ notification, value });
      if (behavior.changeNotification) {
        behavior.changeNotification(this, notification, value, cb);
        return;
      }
      process.nextTick(() => cb(null));
    }

    setNotificationV2(notificationIndex, payload, cb) {
      this.calls.setNotificationV2.push({ notificationIndex, payload });
      if (behavior.setNotificationV2) {
        behavior.setNotificationV2(this, notificationIndex, payload, cb);
        return;
      }
      process.nextTick(() => cb(null));
    }
  };
}

describe('alarm-time.js', () => {
  it('parseTimestampMs parses ISO timestamps with and without timezone as JST', () => {
    assert.equal(parseTimestampMs('2026-11-15T07:00:00+09:00'), Date.parse('2026-11-15T07:00:00+09:00'));
    assert.equal(parseTimestampMs('2026-11-15T07:00:00'), Date.parse('2026-11-15T07:00:00+09:00'));
    assert.equal(parseTimestampMs(''), null);
    assert.equal(parseTimestampMs(null), null);
  });

  it('nextTriggerMs extracts trigger time across V2 and V1 formats', () => {
    const expected = Date.parse('2026-11-15T07:30:00+09:00');
    assert.equal(nextTriggerMs({ trigger: { scheduledTime: '2026-11-15T07:30:00+09:00' } }), expected);
    assert.equal(nextTriggerMs({ alarmTime: '2026-11-15T07:30:00+09:00' }), expected);
    assert.equal(nextTriggerMs({ alarmTime: expected }), expected);
    assert.equal(nextTriggerMs({ originalDate: '2026-11-15', originalTime: '07:30:00.000' }), expected);
    assert.equal(nextTriggerMs({}), null);
  });

  it('getRecurrenceRule parses recurringPattern, trigger.recurrence, and rRuleData', () => {
    assert.deepEqual(getRecurrenceRule({ recurringPattern: 'P1D' }), { freq: 'DAILY', days: [0, 1, 2, 3, 4, 5, 6] });
    assert.deepEqual(getRecurrenceRule({ recurringPattern: 'XXXX-WD' }), { freq: 'WEEKLY', days: [1, 2, 3, 4, 5] });
    assert.deepEqual(getRecurrenceRule({ recurringPattern: 'XXXX-WE' }), { freq: 'WEEKLY', days: [0, 6] });
    assert.deepEqual(getRecurrenceRule({ recurringPattern: 'XXXX-WXX-7' }), { freq: 'WEEKLY', days: [0] });
    assert.deepEqual(
      getRecurrenceRule({ trigger: { recurrence: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'] } } }),
      { freq: 'WEEKLY', days: [1, 3] }
    );
    assert.deepEqual(
      getRecurrenceRule({ rRuleData: { frequency: 'WEEKLY', intervals: [1], byWeekDays: ['FR'] } }),
      { freq: 'WEEKLY', days: [5] }
    );
    assert.equal(getRecurrenceRule({ trigger: { recurrence: { freq: 'DAILY', interval: 2 } } }), null);
  });

  it('computeExpectedNextMs computes next occurrence in JST', () => {
    // 2026-11-13 is Friday (JST)
    const nowBefore = Date.parse('2026-11-13T06:00:00+09:00');
    const nowAfter = Date.parse('2026-11-13T08:00:00+09:00');
    const weekdayAlarm = {
      recurringPattern: 'XXXX-WD',
      originalTime: '07:00:00.000',
    };

    assert.equal(computeExpectedNextMs(weekdayAlarm, nowBefore), Date.parse('2026-11-13T07:00:00+09:00'));
    // After Friday 07:00, next weekday is Monday 2026-11-16
    assert.equal(computeExpectedNextMs(weekdayAlarm, nowAfter), Date.parse('2026-11-16T07:00:00+09:00'));
  });

  it('formatTimeParts formats today, tomorrow, and future dates in JST', () => {
    const now = Date.parse('2026-11-15T10:00:00+09:00'); // Sunday
    const today = formatTimeParts(Date.parse('2026-11-15T18:05:00+09:00'), now);
    assert.equal(today.timeText, '18:05');
    assert.equal(today.dayBadge, '今日 (日)');

    const tomorrow = formatTimeParts(Date.parse('2026-11-16T07:00:00+09:00'), now);
    assert.equal(tomorrow.dayBadge, '明日 (月)');
    assert.equal(tomorrow.dateLabel, '明日 11/16 (月)');

    const later = formatTimeParts(Date.parse('2026-11-18T07:00:00+09:00'), now);
    assert.equal(later.dayBadge, '11/18 (水)');
  });

  it('buildV2Recurrence converts patterns to V2 recurrence objects', () => {
    assert.deepEqual(buildV2Recurrence({ recurringPattern: 'P1D' }), { freq: 'DAILY', interval: 1 });
    assert.deepEqual(buildV2Recurrence({ recurringPattern: 'XXXX-WD' }), {
      freq: 'WEEKLY',
      interval: 1,
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });
    assert.deepEqual(buildV2Recurrence({ recurringPattern: 'XXXX-WXX-3' }), {
      freq: 'WEEKLY',
      interval: 1,
      byDay: ['WE'],
    });
    assert.equal(buildV2Recurrence({}), null);
  });

  it('resolveRestoreDateTime handles desired, recurring, and past date bump', () => {
    const now = Date.parse('2026-11-15T10:00:00+09:00');
    assert.deepEqual(
      resolveRestoreDateTime({ originalDate: '2026-11-15', originalTime: '07:00:00.000' }, '2026-11-16', '07:00:00.000', now),
      { date: '2026-11-16', time: '07:00:00.000' }
    );
    assert.deepEqual(
      resolveRestoreDateTime({ recurringPattern: 'P1D', originalTime: '07:00:00.000' }, '2026-11-15', '07:00:00.000', now),
      { date: '2026-11-16', time: '07:00:00.000' }
    );
    assert.deepEqual(
      resolveRestoreDateTime({ originalDate: '2026-11-15', originalTime: '07:00:00.000' }, null, null, now),
      { date: '2026-11-16', time: '07:00:00.000' }
    );
  });
});

describe('alarm-service.js pure functions', () => {
  it('classifyNotifications filters 24h window, detects cloud-skipped alarms, and sorts ascending', () => {
    const now = Date.parse('2026-11-15T10:00:00+09:00');
    const deviceMap = { S1: 'Echo Show' };
    const notifications = [
      // Active in 24h (later)
      {
        notificationIndex: 'a2',
        type: 'Alarm',
        status: 'ON',
        deviceSerialNumber: 'S1',
        originalDate: '2026-11-16',
        originalTime: '07:00:00.000',
        trigger: { scheduledTime: '2026-11-16T07:00:00+09:00' },
      },
      // Active within past grace (30s ago)
      {
        notificationIndex: 'a1',
        type: 'MusicAlarm',
        status: 'ON',
        deviceSerialNumber: 'S1',
        originalDate: '2026-11-15',
        originalTime: '09:59:30.000',
        trigger: { scheduledTime: '2026-11-15T09:59:30+09:00' },
      },
      // Skipped daily alarm (expected 2026-11-16 06:30, actual 2026-11-17 06:30)
      {
        notificationIndex: 's1',
        type: 'Alarm',
        status: 'ON',
        deviceSerialNumber: 'S1',
        recurringPattern: 'P1D',
        originalDate: '2026-11-17',
        originalTime: '06:30:00.000',
        trigger: { scheduledTime: '2026-11-17T06:30:00+09:00' },
      },
      // Beyond 24h (excluded from active)
      {
        notificationIndex: 'far',
        type: 'Alarm',
        status: 'ON',
        deviceSerialNumber: 'S1',
        trigger: { scheduledTime: '2026-11-17T10:00:00+09:00' },
      },
      // OFF & Reminder (excluded)
      {
        notificationIndex: 'off',
        type: 'Alarm',
        status: 'OFF',
        deviceSerialNumber: 'S1',
        trigger: { scheduledTime: '2026-11-15T11:00:00+09:00' },
      },
      {
        notificationIndex: 'rem',
        type: 'Reminder',
        status: 'ON',
        deviceSerialNumber: 'S1',
        trigger: { scheduledTime: '2026-11-15T11:00:00+09:00' },
      },
    ];

    const res = classifyNotifications(notifications, deviceMap, now);
    assert.deepEqual(res.active.map((x) => x.id), ['a1', 'a2']);
    assert.deepEqual(res.skipped.map((x) => x.id), ['s1']);
    assert.equal(res.skipped[0].isSkipped, true);
    assert.equal(res.skipped[0].originalDate, '2026-11-16');
  });

  it('buildWidgetSummary builds summary for 0, 1, and multiple alarms', () => {
    assert.deepEqual(buildWidgetSummary({ active: [], checkedAt: '10:00:00' }), {
      hasAlarm: false,
      nextAlarm: null,
      remainingCount: 0,
      totalCount: 0,
      checkedAt: '10:00:00',
    });

    const one = buildWidgetSummary({
      active: [{
        id: '1',
        timeText: '07:00',
        dayBadge: '明日 (月)',
        dateLabel: '明日 11/16 (月)',
        deviceName: 'Echo Show',
        label: '起床',
        whenMs: 12345,
      }],
      checkedAt: '10:01:00',
    });
    assert.equal(one.hasAlarm, true);
    assert.equal(one.remainingCount, 0);
    assert.equal(one.totalCount, 1);
    assert.equal(one.nextAlarm.id, '1');

    const many = buildWidgetSummary({
      active: [
        { id: '1', timeText: '07:00', dayBadge: '明日 (月)', dateLabel: '明日 11/16 (月)', deviceName: 'Echo Show', label: '', whenMs: 1 },
        { id: '2', timeText: '08:00', dayBadge: '明日 (月)', dateLabel: '明日 11/16 (月)', deviceName: 'Echo Dot', label: '', whenMs: 2 },
      ],
      checkedAt: '10:02:00',
    });
    assert.equal(many.remainingCount, 1);
    assert.equal(many.totalCount, 2);
  });
});

describe('alexa-auth.js', () => {
  it('isAuthError distinguishes transient errors from authentication errors', () => {
    assert.equal(isAuthError(new Error('getaddrinfo ENOTFOUND alexa.amazon.co.jp')), false);
    assert.equal(isAuthError(new Error('connect ETIMEDOUT 1.2.3.4:443')), false);
    assert.equal(isAuthError(new Error('HTTP 502 Bad Gateway')), false);

    assert.equal(isAuthError(new AuthRequiredError('expired')), true);
    assert.equal(isAuthError(new Error('401 Unauthorized')), true);
    assert.equal(isAuthError(new Error('AUTH_REQUIRED')), true);
  });

  it('loadSavedCookie and backupCookieFile operate safely in temp dir', () => {
    const tmpDir = createTempDir();
    try {
      const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
      const auth = createAlexaAuthManager({ cookieFile });

      assert.equal(auth.loadSavedCookie(), null);
      assert.equal(auth.backupCookieFile(), false);

      fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'session=abc', macDms: { a: 1 } }), 'utf8');
      assert.equal(auth.loadSavedCookie(), 'session=abc');
      assert.equal(auth.backupCookieFile(), true);
      assert.equal(fs.existsSync(`${cookieFile}.bak`), true);

      const fullCookie = {
        cookie: 'session=full',
        localCookie: 'session=full; csrf=123',
        refreshToken: 'Atzr|refresh-1',
        macDms: { k: 1 },
      };
      fs.writeFileSync(cookieFile, JSON.stringify(fullCookie), 'utf8');
      assert.deepEqual(auth.loadSavedCookie(), fullCookie);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('connectAlexa and startProxyLogin work with mocked AlexaRemoteClass', async () => {
    const tmpDir = createTempDir();
    try {
      const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
      fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'session=xyz', macDms: { k: 1 } }), 'utf8');

      const notifiedUrls = [];
      const MockClass = createMockAlexaClass({
        init(instance, opts, cb) {
          if (opts.setupProxy) {
            process.nextTick(() => cb(new Error('Please open http://127.0.0.1:45678/ with your browser')));
            return;
          }
          process.nextTick(() => cb(null));
        },
      });

      const auth = createAlexaAuthManager({
        cookieFile,
        AlexaRemoteClass: MockClass,
        onLoginUrl: (url) => notifiedUrls.push(url),
      });

      const client = await auth.connectAlexa();
      assert.equal(client.calls.init.length, 1);
      assert.equal(auth.getAuthState().status, 'ready');

      const loginState = await auth.startProxyLogin({ notify: true });
      assert.equal(loginState.status, 'logging_in');
      assert.equal(loginState.loginUrl, 'http://127.0.0.1:45678/');
      assert.deepEqual(notifiedUrls, ['http://127.0.0.1:45678/']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('alarm-service.js skip & restore flow with mock client', () => {
  it('skipAlarm calls cancelNotification and restoreAlarm calls changeNotification(false) then setNotificationV2', async () => {
    const tmpDir = createTempDir();
    try {
      const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
      fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'ok=1' }), 'utf8');

      const fixedNow = Date.parse('2026-11-15T10:00:00+09:00');
      const sampleNotif = {
        notificationIndex: 'idx-1',
        type: 'Alarm',
        status: 'ON',
        deviceSerialNumber: 'DEV1',
        recurringPattern: 'P1D',
        originalDate: '2026-11-16',
        originalTime: '07:00:00.000',
        sound: { id: 'system_alerts_melodic_01' },
        trigger: { scheduledTime: '2026-11-16T07:00:00+09:00' },
      };

      let mockInstance = null;
      const MockClass = createMockAlexaClass({
        onConstruct(inst) {
          mockInstance = inst;
        },
        getDevices(inst, cb) {
          process.nextTick(() => cb(null, { devices: [{ serialNumber: 'DEV1', accountName: 'Echo Show' }] }));
        },
        getNotifications(inst, cached, cb) {
          process.nextTick(() => cb(null, { notifications: [sampleNotif] }));
        },
      });

      const auth = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: MockClass });
      const service = createAlarmService(auth, { restoreWaitMs: 1, nowFn: () => fixedNow });

      const skipRes = await service.skipAlarm({ id: 'idx-1' });
      assert.equal(skipRes.ok, true);
      assert.equal(skipRes.skippedId, 'idx-1');
      assert.equal(mockInstance.calls.cancelNotification.length, 1);

      const restoreRes = await service.restoreAlarm({ id: 'idx-1' });
      assert.equal(restoreRes.ok, true);
      assert.equal(restoreRes.restoredId, 'idx-1');
      assert.equal(mockInstance.calls.changeNotification.length, 1);
      assert.equal(mockInstance.calls.changeNotification[0].value, false);
      assert.equal(mockInstance.calls.setNotificationV2.length, 1);
      assert.equal(mockInstance.calls.setNotificationV2[0].notificationIndex, 'idx-1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('prototype/web-ui.js HTTP integration', () => {
  let tmpDir;
  let prevCookieEnv;
  let alexaRemotePath;
  let prevAlexaRemoteCache;
  let webUi;
  let testServer;
  let baseUrl;

  function fetchJson(reqPath, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}${reqPath}`);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: options.raw ? raw : JSON.parse(raw),
          });
        });
      });
      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  before(async () => {
    tmpDir = createTempDir();
    prevCookieEnv = process.env.ALEXA_COOKIE_FILE;
    process.env.ALEXA_COOKIE_FILE = path.join(tmpDir, 'nonexistent-cookie.json');

    alexaRemotePath = require.resolve('alexa-remote2');
    prevAlexaRemoteCache = require.cache[alexaRemotePath];
    const MockAlexaForWebUi = createMockAlexaClass({
      init(instance, opts, cb) {
        if (opts.setupProxy) {
          process.nextTick(() => cb(new Error(`Please open http://127.0.0.1:${opts.proxyPort}/ with your browser`)));
          return;
        }
        process.nextTick(() => cb(null));
      },
    });
    require.cache[alexaRemotePath] = {
      id: alexaRemotePath,
      filename: alexaRemotePath,
      loaded: true,
      exports: MockAlexaForWebUi,
    };

    delete require.cache[require.resolve('../prototype/web-ui')];
    webUi = require('../prototype/web-ui');

    testServer = http.createServer(webUi.handleRequest);
    await new Promise((resolve) => {
      testServer.listen(0, '127.0.0.1', () => {
        const { port } = testServer.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (testServer && testServer.listening) {
      await new Promise((resolve) => testServer.close(resolve));
    }
    delete require.cache[require.resolve('../prototype/web-ui')];
    if (prevAlexaRemoteCache) {
      require.cache[alexaRemotePath] = prevAlexaRemoteCache;
    } else {
      delete require.cache[alexaRemotePath];
    }
    if (prevCookieEnv === undefined) {
      delete process.env.ALEXA_COOKIE_FILE;
    } else {
      process.env.ALEXA_COOKIE_FILE = prevCookieEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/health and /api/auth/status respond with 200', async () => {
    const health = await fetchJson('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });

    const auth = await fetchJson('/api/auth/status');
    assert.equal(auth.status, 200);
    assert.equal(auth.body.ok, true);
  });

  it('GET /api/alarms and /api/widget/summary return 401 with needsLogin: true when cookie is missing', async () => {
    const alarms = await fetchJson('/api/alarms');
    assert.equal(alarms.status, 401);
    assert.equal(alarms.body.needsLogin, true);

    const widget = await fetchJson('/api/widget/summary');
    assert.equal(widget.status, 401);
    assert.equal(widget.body.needsLogin, true);
  });

  it('GET /, /manifest.webmanifest, and 404 routes respond properly', async () => {
    const html = await fetchJson('/', { raw: true });
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.match(html.body, /Alexa アラーム管理/);

    const idx256 = html.body.indexOf('href="/icon-256.png"');
    const idx48 = html.body.indexOf('href="/icon-48.png"');
    const idx32 = html.body.indexOf('href="/icon-32.png"');
    const idxIco = html.body.indexOf('href="/favicon.ico"');
    assert.ok(idx256 > 0 && idx48 > idx256 && idx32 > idx48 && idxIco > idx32, 'icon links should be ordered high-res first');

    const manifest = await fetchJson('/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.short_name, 'Alexaアラーム');
    assert.deepEqual(
      manifest.body.icons.map((i) => ({ src: i.src, sizes: i.sizes, purpose: i.purpose })),
      [
        { src: '/icon-48.png', sizes: '48x48', purpose: 'any' },
        { src: '/icon-192.png', sizes: '192x192', purpose: 'any' },
        { src: '/icon-256.png', sizes: '256x256', purpose: 'any' },
      ]
    );

    for (const [route, mime] of [
      ['/icon-256.png', 'image/png'],
      ['/icon-192.png', 'image/png'],
      ['/icon-48.png', 'image/png'],
      ['/icon-32.png', 'image/png'],
      ['/favicon.ico', 'image/x-icon'],
    ]) {
      const res = await fetchJson(route, { raw: true });
      assert.equal(res.status, 200, `${route} should return 200`);
      assert.equal(res.headers['content-type'], mime);
    }

    const icoBuf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icons', 'app.ico'));
    const icoCount = icoBuf.readUInt16LE(4);
    assert.equal(icoCount, 8);
    const icoWidths = [];
    for (let i = 0; i < icoCount; i++) {
      const rawW = icoBuf.readUInt8(6 + i * 16);
      icoWidths.push(rawW === 0 ? 256 : rawW);
    }
    assert.deepEqual(icoWidths, [16, 24, 32, 40, 48, 64, 128, 256]);

    const notFound = await fetchJson('/nonexistent', { raw: true });
    assert.equal(notFound.status, 404);
  });
});

describe('proxy-patch.js & window-manager.js', () => {
  it('applyProxyPatch is idempotent and returns true when alexa-cookie2 is installed', () => {
    assert.equal(applyProxyPatch(), true);
    assert.equal(applyProxyPatch(), true);
  });

  it('createWindowManager manages single-instance lock lifecycle in temp dir', async () => {
    const tmpDir = createTempDir();
    try {
      const lockFile = path.join(tmpDir, 'test.lock.json');
      const wm = createWindowManager({ lockFile });

      assert.equal(await wm.acquireSingleInstanceLock(), true);
      wm.writeSingleInstanceLock(43210);
      assert.equal(fs.existsSync(lockFile), true);

      wm.releaseSingleInstanceLock();
      assert.equal(fs.existsSync(lockFile), false);

      // Stale/corrupted lock file is cleaned up automatically
      fs.writeFileSync(lockFile, '{invalid-json', 'utf8');
      assert.equal(await wm.acquireSingleInstanceLock(), true);
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('prototype/web-ui.js authenticated HTTP endpoints with mock Alexa', () => {
  let tmpDir;
  let prevCookieEnv;
  let alexaRemotePath;
  let prevAlexaRemoteCache;
  let webUi;
  let testServer;
  let baseUrl;

  function fetchJson(reqPath, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}${reqPath}`);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  before(async () => {
    tmpDir = createTempDir();
    const cookieFile = path.join(tmpDir, 'mock-cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'mock=ok', macDms: { k: 1 } }), 'utf8');
    prevCookieEnv = process.env.ALEXA_COOKIE_FILE;
    process.env.ALEXA_COOKIE_FILE = cookieFile;

    const soonIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    alexaRemotePath = require.resolve('alexa-remote2');
    prevAlexaRemoteCache = require.cache[alexaRemotePath];
    const MockAlexaAuthed = createMockAlexaClass({
      getDevices(inst, cb) {
        process.nextTick(() => cb(null, { devices: [{ serialNumber: 'DEV1', accountName: 'Echo Show' }] }));
      },
      getNotifications(inst, cached, cb) {
        process.nextTick(() => cb(null, {
          notifications: [{
            notificationIndex: 'alarm-1',
            type: 'Alarm',
            status: 'ON',
            deviceSerialNumber: 'DEV1',
            recurringPattern: 'P1D',
            sound: { id: 'system_alerts_melodic_01' },
            trigger: { scheduledTime: soonIso },
          }],
        }));
      },
    });
    require.cache[alexaRemotePath] = {
      id: alexaRemotePath,
      filename: alexaRemotePath,
      loaded: true,
      exports: MockAlexaAuthed,
    };

    delete require.cache[require.resolve('../prototype/web-ui')];
    webUi = require('../prototype/web-ui');

    testServer = http.createServer(webUi.handleRequest);
    await new Promise((resolve) => {
      testServer.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${testServer.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (testServer && testServer.listening) {
      await new Promise((resolve) => testServer.close(resolve));
    }
    delete require.cache[require.resolve('../prototype/web-ui')];
    if (prevAlexaRemoteCache) {
      require.cache[alexaRemotePath] = prevAlexaRemoteCache;
    } else {
      delete require.cache[alexaRemotePath];
    }
    if (prevCookieEnv === undefined) {
      delete process.env.ALEXA_COOKIE_FILE;
    } else {
      process.env.ALEXA_COOKIE_FILE = prevCookieEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/alarms, /api/widget/summary, POST /api/alarms/skip and /restore succeed', async () => {
    const alarms = await fetchJson('/api/alarms');
    assert.equal(alarms.status, 200);
    assert.equal(alarms.body.deviceCount, 1);
    assert.equal(alarms.body.active.length, 1);

    const widget = await fetchJson('/api/widget/summary');
    assert.equal(widget.status, 200);
    assert.equal(widget.body.hasAlarm, true);
    assert.equal(widget.body.totalCount, 1);
    assert.equal(widget.body.nextAlarm.id, 'alarm-1');

    const skip = await fetchJson('/api/alarms/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alarm-1' }),
    });
    assert.equal(skip.status, 200);
    assert.equal(skip.body.ok, true);
    assert.equal(skip.body.skippedId, 'alarm-1');

    const restore = await fetchJson('/api/alarms/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alarm-1' }),
    });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.ok, true);
    assert.equal(restore.body.restoredId, 'alarm-1');
  });
});

describe('proxy-patch.js', () => {
  it('applyProxyPatch injects keepAlive: false agent, proxyTimeout, and globalAgent', () => {
    const https = require('https');
    const path = require('path');
    assert.equal(applyProxyPatch(), true);
    assert.equal(https.globalAgent, upstreamAgent);
    assert.equal(upstreamAgent.keepAlive, false);

    const cookiePkgDir = path.dirname(require.resolve('alexa-cookie2/package.json'));
    const hpmPath = require.resolve('http-proxy-middleware', {
      paths: [path.join(cookiePkgDir, 'lib'), cookiePkgDir],
    });
    const hpm = require(hpmPath);
    const opts = {
      target: 'https://www.amazon.co.jp',
      pathRewrite: (p) => p,
    };
    const middleware = hpm.createProxyMiddleware(opts);
    assert.equal(typeof middleware, 'function');
    assert.equal(opts.agent, upstreamAgent);
    assert.equal(opts.agent.keepAlive, false);
    assert.equal(opts.proxyTimeout, 60000);
    assert.equal(
      opts.pathRewrite('/ap/signin?openid.ns.oa2=https%3A%2F%2Fwww.amazon.co.jp%2Fap%2Fext%2Foauth%2F2', {}),
      `/ap/signin?openid.ns.oa2=${encodeURIComponent('http://www.amazon.com/ap/ext/oauth/2')}`
    );
  });

  it('patchedLookup resolves via dns.lookup and falls back to public DNS on lookup error', async () => {
    const dns = require('dns');
    const origLookup = dns.lookup;
    const origResolve4 = dns.Resolver.prototype.resolve4;

    try {
      // Normal path via dns.lookup
      dns.lookup = (hostname, opts, cb) => cb(null, '127.0.0.1', 4);
      const normal = await new Promise((resolve, reject) => {
        patchedLookup('localhost', (err, address, family) => (err ? reject(err) : resolve({ address, family })));
      });
      assert.deepEqual(normal, { address: '127.0.0.1', family: 4 });

      // Fallback path when dns.lookup fails
      dns.lookup = (hostname, opts, cb) => cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      dns.Resolver.prototype.resolve4 = function (_hostname, cb) {
        cb(null, ['203.0.113.10', '203.0.113.11']);
      };
      const fallbackSingle = await new Promise((resolve, reject) => {
        patchedLookup('www.amazon.co.jp', (err, address, family) => (err ? reject(err) : resolve({ address, family })));
      });
      assert.deepEqual(fallbackSingle, { address: '203.0.113.10', family: 4 });

      const fallbackAll = await new Promise((resolve, reject) => {
        patchedLookup('www.amazon.co.jp', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
      });
      assert.deepEqual(fallbackAll, [
        { address: '203.0.113.10', family: 4 },
        { address: '203.0.113.11', family: 4 },
      ]);
    } finally {
      dns.lookup = origLookup;
      dns.Resolver.prototype.resolve4 = origResolve4;
    }
  });
});

describe('prototype/web-ui.js --desktop-host mode', () => {
  it('outputs __ALEXA_HOST_READY__ port JSON, disables beforeunload shutdown in HTML, and exits 0 on POST /api/shutdown', async () => {
    const { spawn } = require('node:child_process');
    const vm = require('vm');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-desktop-host-test-'));
    const cookiePath = path.join(tempDir, 'missing-cookie.json');
    const scriptPath = path.join(__dirname, '..', 'prototype', 'web-ui.js');

    const child = spawn(process.execPath, [scriptPath, '--desktop-host'], {
      env: {
        ...process.env,
        ALEXA_WEB_PORT: '0',
        ALEXA_COOKIE_FILE: cookiePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const readyPayload = await new Promise((resolve, reject) => {
        let stdoutBuf = '';
        let stderrBuf = '';
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for __ALEXA_HOST_READY__. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        }, 10000);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdoutBuf += chunk;
          const lines = stdoutBuf.split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith('__ALEXA_HOST_READY__ ')) {
              clearTimeout(timer);
              resolve(JSON.parse(line.slice('__ALEXA_HOST_READY__ '.length)));
              return;
            }
          }
        });
        child.stderr.on('data', (chunk) => {
          stderrBuf += chunk;
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited prematurely with code ${code}. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        });
      });

      assert.equal(Number.isInteger(readyPayload.port), true);
      assert.ok(readyPayload.port > 0 && readyPayload.port <= 65535);

      const html = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${readyPayload.port}/`, (res) => {
          assert.equal(res.statusCode, 200);
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve(raw));
        }).on('error', reject);
      });

      assert.match(html, /data-desktop-host="1"/);

      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      assert.ok(scriptMatch, 'Expected inline <script> in --desktop-host HTML');
      const windowListeners = {};
      const beaconUrls = [];
      const noopEl = {
        textContent: '',
        title: '',
        className: '',
        hidden: false,
        disabled: false,
        innerHTML: '',
        classList: { add() {}, remove() {} },
        setAttribute() {},
        addEventListener() {},
      };
      vm.runInNewContext(scriptMatch[1], {
        window: {
          location: { origin: `http://127.0.0.1:${readyPayload.port}` },
          open() {},
          addEventListener(type, fn) { windowListeners[type] = fn; },
        },
        document: {
          visibilityState: 'visible',
          documentElement: {
            getAttribute: (attr) => (attr === 'data-desktop-host' ? '1' : null),
          },
          getElementById: () => noopEl,
          addEventListener() {},
        },
        navigator: {
          sendBeacon: (url) => {
            beaconUrls.push(url);
            return true;
          },
        },
        console,
        setInterval: () => 1,
        clearInterval: () => {},
        fetch: () => Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ active: [], skipped: [], deviceCount: 0, checkedAt: '00:00:00' }),
        }),
      });

      assert.equal(windowListeners.beforeunload, undefined);
      assert.equal(windowListeners.pagehide, undefined);
      assert.equal(windowListeners.keydown, undefined);
      assert.deepEqual(beaconUrls, []);

      const exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });

      await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: readyPayload.port,
          path: '/api/shutdown',
          method: 'POST',
        }, (res) => {
          assert.equal(res.statusCode, 200);
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      });

      const exitResult = await exitPromise;
      assert.equal(exitResult.code, 0);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('POST /api/shutdown drains hasPendingWork before exiting with code 0', async () => {
    const { spawn } = require('node:child_process');
    const inlineCode = `
      const http = require('http');
      const { createWindowManager } = require('./src/desktop/window-manager');
      let pending = true;
      setTimeout(() => { pending = false; }, 180);
      const srv = http.createServer((req, res) => {
        if (req.url === '/api/shutdown' && req.method === 'POST') {
          res.on('finish', () => wm.shutdownServer('beforeunload'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const wm = createWindowManager({
        getServers: () => [srv],
        hasPendingWork: () => pending,
      });
      srv.listen(0, '127.0.0.1', () => {
        process.stdout.write('PORT:' + srv.address().port + '\\n');
      });
    `;

    const child = spawn(process.execPath, ['-e', inlineCode], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const port = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Timed out waiting for PORT')), 5000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buf += chunk;
          const m = buf.match(/PORT:(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited early with ${code}`));
        });
      });

      const startedAt = Date.now();
      const exitPromise = new Promise((resolve) => {
        child.once('exit', (code) => resolve({ code, elapsedMs: Date.now() - startedAt }));
      });

      await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/shutdown',
          method: 'POST',
        }, (res) => {
          assert.equal(res.statusCode, 200);
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      });

      const { code, elapsedMs } = await exitPromise;
      assert.equal(code, 0);
      assert.ok(elapsedMs >= 140, `Expected drain delay >= 140ms, got ${elapsedMs}ms`);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }
  });

  it('exits promptly with code 0 on POST /api/shutdown even while auth state is logging_in', async () => {
    const { spawn } = require('node:child_process');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-desktop-login-shutdown-'));
    const cookiePath = path.join(tempDir, 'missing-cookie.json');
    const scriptPath = path.join(__dirname, '..', 'prototype', 'web-ui.js');

    const child = spawn(process.execPath, [scriptPath, '--desktop-host'], {
      env: {
        ...process.env,
        ALEXA_WEB_PORT: '0',
        ALEXA_COOKIE_FILE: cookiePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const readyPayload = await new Promise((resolve, reject) => {
        let stdoutBuf = '';
        let stderrBuf = '';
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for __ALEXA_HOST_READY__. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        }, 10000);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdoutBuf += chunk;
          for (const line of stdoutBuf.split(/\r?\n/)) {
            if (line.startsWith('__ALEXA_HOST_READY__ ')) {
              clearTimeout(timer);
              resolve(JSON.parse(line.slice('__ALEXA_HOST_READY__ '.length)));
              return;
            }
          }
        });
        child.stderr.on('data', (chunk) => {
          stderrBuf += chunk;
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited prematurely with code ${code}. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        });
      });

      const loginPayload = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ openBrowser: false });
        const req = http.request({
          hostname: '127.0.0.1',
          port: readyPayload.port,
          path: '/api/auth/login',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ statusCode: res.statusCode, json: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      assert.equal(loginPayload.statusCode, 200);
      assert.equal(loginPayload.json.status, 'logging_in');

      const startedAt = Date.now();
      const exitPromise = new Promise((resolve) => {
        child.once('exit', (code) => resolve({ code, elapsedMs: Date.now() - startedAt }));
      });

      await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: readyPayload.port,
          path: '/api/shutdown',
          method: 'POST',
        }, (res) => {
          assert.equal(res.statusCode, 200);
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      });

      const { code, elapsedMs } = await exitPromise;
      assert.equal(code, 0);
      assert.ok(elapsedMs < 3000, `Expected shutdown while logging_in < 3000ms, got ${elapsedMs}ms`);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves focus-visible CSS and mouse click blur handler to prevent focus ring on mouse clicks', async () => {
    const vm = require('vm');
    const { handleRequest: webUiHandleRequest } = require('../prototype/web-ui');
    const html = await new Promise((resolve, reject) => {
      const srv = http.createServer(webUiHandleRequest);
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          assert.equal(res.statusCode, 200);
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => srv.close(() => resolve(raw)));
        }).on('error', reject);
      });
    });

    assert.match(html, /button:focus[\s\S]*outline:\s*none;/);
    assert.match(html, /button:focus-visible[\s\S]*outline:\s*2px solid/);

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Expected inline <script> in HTML');

    const docListeners = {};
    const noopEl = {
      textContent: '',
      title: '',
      className: '',
      hidden: false,
      disabled: false,
      innerHTML: '',
      classList: { add() {}, remove() {} },
      setAttribute() {},
      addEventListener() {},
    };
    vm.runInNewContext(scriptMatch[1], {
      window: { location: { origin: 'http://127.0.0.1' }, open() {}, addEventListener() {} },
      document: {
        visibilityState: 'visible',
        getElementById: () => noopEl,
        addEventListener(type, fn) { docListeners[type] = fn; },
      },
      navigator: { sendBeacon: () => true },
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: () => Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ active: [], skipped: [], deviceCount: 0, checkedAt: '00:00:00' }),
      }),
    });

    assert.equal(typeof docListeners.click, 'function');
    let blurCount = 0;
    const mockBtn = { blur() { blurCount += 1; } };
    docListeners.click({ detail: 1, target: { closest: (sel) => (sel === 'button' ? mockBtn : null) } });
    assert.equal(blurCount, 1);
    docListeners.click({ detail: 0, target: { closest: (sel) => (sel === 'button' ? mockBtn : null) } });
    assert.equal(blurCount, 1);
  });
});

describe('alexa-auth.js listener cleanup & UI loading/auto-refresh', () => {
  it('resetConnection and startProxyLogin remove event listeners on old AlexaRemote instances', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { EventEmitter } = require('events');
    const { createAlexaAuthManager } = require('../src/core/alexa-auth');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-auth-leak-'));
    const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'session-id=1', localCookie: 'session-id=1' }));

    const created = [];
    class FakeAlexaRemote extends EventEmitter {
      constructor() {
        super();
        this.removedCount = 0;
        created.push(this);
      }
      removeAllListeners() {
        this.removedCount += 1;
        return super.removeAllListeners();
      }
      init(opts, cb) {
        if (opts && opts.setupProxy) {
          cb(new Error('Please open http://127.0.0.1:12345/ in your browser'));
          return;
        }
        cb(null);
      }
    }

    try {
      const auth = createAlexaAuthManager({
        cookieFile,
        AlexaRemoteClass: FakeAlexaRemote,
      });

      await auth.connectAlexa();
      assert.equal(created.length, 1);
      assert.ok(created[0].listenerCount('cookie') > 0);
      assert.ok(created[0].listenerCount('error') > 0);

      auth.resetConnection();
      assert.equal(created[0].removedCount, 1);
      assert.equal(created[0].listenerCount('cookie'), 0);
      assert.equal(created[0].listenerCount('error'), 0);

      await auth.startProxyLogin({ notify: false });
      assert.equal(created.length, 2);
      assert.ok(created[1].listenerCount('cookie') > 0);

      // Re-invoking startProxyLogin when status is logging_in with loginUrl reuses existing state;
      // resetConnection + startProxyLogin replaces old login client and cleans up listeners.
      auth.resetConnection();
      assert.equal(created[1].removedCount, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prototype/web-ui.js and www/ include 90-ring overlay and 60s visibility-aware auto-refresh', () => {
    const fs = require('fs');
    const path = require('path');

    const webUiSrc = fs.readFileSync(path.join(__dirname, '..', 'prototype', 'web-ui.js'), 'utf8');
    assert.ok(webUiSrc.includes('id="loadingOverlay"'));
    assert.ok(webUiSrc.includes('spinner-90-ring.svg'));
    assert.ok(webUiSrc.includes('AUTO_REFRESH_INTERVAL_MS = 60000'));
    assert.ok(webUiSrc.includes('visibilitychange'));
    assert.ok(webUiSrc.includes('Boolean(options && options.silent)'));

    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'www', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="loadingOverlay"'));
    assert.ok(indexHtml.includes('animateTransform'));

    const styleCss = fs.readFileSync(path.join(__dirname, '..', 'www', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.loading-overlay'));
    assert.ok(styleCss.includes('color: #60a5fa'));

    const appJs = fs.readFileSync(path.join(__dirname, '..', 'www', 'app.js'), 'utf8');
    assert.ok(appJs.includes('AUTO_REFRESH_INTERVAL_MS = 60000'));
    assert.ok(appJs.includes('visibilitychange'));
    assert.ok(appJs.includes('getCachedState'));
    assert.ok(appJs.includes('saveCookieFilePath'));
  });

  it('prototype/web-ui.js renders .date-divider per JST date group while preserving data-idx', async () => {
    const vm = require('vm');
    const webUiSrc = fs.readFileSync(path.join(__dirname, '..', 'prototype', 'web-ui.js'), 'utf8');

    assert.match(webUiSrc, /\.date-divider\s*\{[\s\S]*?min-height:\s*32px;/);
    assert.match(webUiSrc, /\.date-divider\s*\{[\s\S]*?pointer-events:\s*none;/);
    assert.match(webUiSrc, /\.date-divider::after\s*\{[\s\S]*?height:\s*1px;/);
    assert.match(webUiSrc, /\.empty-group\s*\{[\s\S]*?min-height:\s*38px;/);
    assert.match(webUiSrc, /\.empty-group\s*\{[\s\S]*?pointer-events:\s*none;/);
    assert.match(webUiSrc, /\.list\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/);
    assert.match(webUiSrc, /\.list::-webkit-scrollbar-thumb\s*\{[\s\S]*?rgba\(148,\s*163,\s*184,\s*0\.38\)/);
    assert.match(webUiSrc, /\.status-bar\s*\{[\s\S]*?white-space:\s*nowrap;/);
    assert.match(webUiSrc, /\.status-bar\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
    assert.match(webUiSrc, /\.status-bar\s*\{[\s\S]*?border-top:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.14\)/);
    assert.match(webUiSrc, /\.row\s*\{[\s\S]*?flex-shrink:\s*0;/);
    assert.equal(webUiSrc.includes('.row-next'), false);
    assert.equal(webUiSrc.includes('border-style: dashed'), false);
    assert.match(webUiSrc, /\.tabs\s*\{[\s\S]*?border-bottom:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.18\)/);
    assert.match(webUiSrc, /\.tab-btn:hover\s*\{\s*background:\s*transparent;/);
    assert.match(webUiSrc, /\.tab-btn\.active::after\s*\{[\s\S]*?height:\s*3px;/);
    assert.ok(webUiSrc.includes('keepalive: true'));
    assert.ok(webUiSrc.includes("e.key === 'F4'"));
    assert.ok(webUiSrc.includes('serverMutationQueue'));
    assert.ok(webUiSrc.includes('function renderActiveTimeline('));
    assert.ok(webUiSrc.includes('function isTodayAlarmItem('));

    const scriptMatch = webUiSrc.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(scriptMatch, 'Expected inline <script> in prototype/web-ui.js');

    const elements = {};
    const getEl = (id) => {
      if (!elements[id]) {
        const listeners = {};
        elements[id] = {
          id,
          hidden: false,
          disabled: false,
          textContent: '',
          className: '',
          innerHTML: '',
          _listeners: listeners,
          classList: { add() {}, remove() {} },
          setAttribute() {},
          addEventListener(type, fn) {
            listeners[type] = fn;
          },
        };
      }
      return elements[id];
    };

    const sampleAlarms = [
      {
        id: 'a1',
        timeText: '07:00',
        dayBadge: '今日 (木)',
        dateLabel: '今日 11/19 (木)',
        dateKey: '2026-11-19',
        deviceName: 'Echo Show',
        recurringText: '毎日',
        whenMs: 1000,
      },
      {
        id: 'a2',
        timeText: '07:30',
        dayBadge: '今日 (木)',
        dateLabel: '今日 11/19 (木)',
        dateKey: '2026-11-19',
        deviceName: 'Echo Dot',
        recurringText: '1回のみ',
        whenMs: 2000,
      },
      {
        id: 'a3',
        timeText: '06:30',
        dayBadge: '明日 (金)',
        dateLabel: '明日 11/20 (金)',
        dateKey: '2026-11-20',
        deviceName: 'Echo Show',
        recurringText: '毎日',
        whenMs: 3000,
      },
    ];

    const context = {
      document: {
        visibilityState: 'visible',
        getElementById: getEl,
        addEventListener() {},
      },
      window: { addEventListener() {} },
      navigator: {},
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (url) => {
        if (url === '/api/alarms') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              active: sampleAlarms,
              skipped: [],
              deviceCount: 2,
              checkedAt: '03:50:00',
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    };

    vm.runInNewContext(scriptMatch[1], context);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const html = elements.timelineList.innerHTML;
    const dividers = [...html.matchAll(/<div class="date-divider"[^>]*>([^<]+)<\/div>/g)].map((m) => m[1]);
    assert.deepEqual(dividers, ['今日 11/19 (木)', '明日 11/20 (金)']);

    const idxMatches = [...html.matchAll(/data-idx="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(idxMatches, ['0', '1', '2']);
    assert.equal(html.includes('class="day-tag"'), false);

    const todayHeaderPos = html.indexOf('今日 11/19 (木)');
    const firstRowPos = html.indexOf('07:00');
    const secondRowPos = html.indexOf('07:30');
    const tomorrowHeaderPos = html.indexOf('明日 11/20 (金)');
    const thirdRowPos = html.indexOf('06:30');
    assert.ok(todayHeaderPos < firstRowPos);
    assert.ok(firstRowPos < secondRowPos);
    assert.ok(secondRowPos < tomorrowHeaderPos);
    assert.ok(tomorrowHeaderPos < thirdRowPos);

    // Skip both today alarms (idx 0 twice) -> today placeholder + tomorrow group
    const makeSkipClick = (idx) => ({
      target: {
        closest(sel) {
          return sel === 'button[data-action="skip"]' ? { getAttribute: () => String(idx) } : null;
        },
      },
    });
    elements.timelineList._listeners.click(makeSkipClick(0));
    elements.timelineList._listeners.click(makeSkipClick(0));

    const afterTodaySkipped = elements.timelineList.innerHTML;
    const afterDividers = [...afterTodaySkipped.matchAll(/<div class="date-divider"[^>]*>([^<]+)<\/div>/g)].map((m) => m[1]);
    assert.deepEqual(afterDividers, ['今日 11/19 (木)', '明日 11/20 (金)']);
    assert.ok(afterTodaySkipped.includes('<div class="empty-group">今日のアラームはありません</div>'));
    const afterIdx = [...afterTodaySkipped.matchAll(/data-idx="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(afterIdx, ['0']);
    assert.ok(afterTodaySkipped.indexOf('今日のアラームはありません') < afterTodaySkipped.indexOf('明日 11/20 (金)'));
    assert.ok(afterTodaySkipped.indexOf('明日 11/20 (金)') < afterTodaySkipped.indexOf('06:30'));

    // Skip remaining tomorrow alarm -> overall .empty only
    elements.timelineList._listeners.click(makeSkipClick(0));
    const afterAllSkipped = elements.timelineList.innerHTML;
    assert.ok(afterAllSkipped.includes('<div class="empty">直近のアラームはありません</div>'));
    assert.equal(afterAllSkipped.includes('empty-group'), false);
    assert.equal(afterAllSkipped.includes('date-divider'), false);

    // Fresh context with only tomorrow alarm -> no .empty-group
    const elementsTomorrowOnly = {};
    const getEl2 = (id) => {
      if (!elementsTomorrowOnly[id]) {
        elementsTomorrowOnly[id] = {
          id, hidden: false, disabled: false, textContent: '', className: '', innerHTML: '',
          classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {},
        };
      }
      return elementsTomorrowOnly[id];
    };
    vm.runInNewContext(scriptMatch[1], {
      document: { visibilityState: 'visible', getElementById: getEl2, addEventListener() {} },
      window: { addEventListener() {} },
      navigator: {},
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => (url === '/api/alarms'
          ? { active: [sampleAlarms[2]], skipped: [], deviceCount: 1, checkedAt: '23:55:00' }
          : { ok: true }),
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const tomorrowOnlyHtml = elementsTomorrowOnly.timelineList.innerHTML;
    assert.equal(tomorrowOnlyHtml.includes('empty-group'), false);
    assert.deepEqual(
      [...tomorrowOnlyHtml.matchAll(/<div class="date-divider"[^>]*>([^<]+)<\/div>/g)].map((m) => m[1]),
      ['明日 11/20 (金)']
    );
  });

  it('window-manager shutdownServer drains hasPendingWork before closing servers', async () => {
    const tmpDir = createTempDir();
    try {
      let pending = true;
      let closed = false;
      const fakeServer = {
        listening: true,
        closeAllConnections() {},
        close(cb) {
          closed = true;
          cb();
        },
      };
      const origExit = process.exit;
      let exitCode = null;
      process.exit = (code) => { exitCode = code; };
      try {
        const wm = createWindowManager({
          lockFile: path.join(tmpDir, 'drain.lock.json'),
          getServers: () => [fakeServer],
          hasPendingWork: () => pending,
        });
        wm.shutdownServer('test-drain');
        wm.shutdownServer('test-drain-dup');
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(closed, false);
        assert.equal(exitCode, null);

        pending = false;
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(closed, true);
        assert.equal(exitCode, 0);
      } finally {
        process.exit = origExit;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prepareCookieForAlexaRemote preserves cookieData.refreshToken on real alexa-remote2 setCookie', () => {
    const AlexaRemote = require('alexa-remote2');
    const remote = new AlexaRemote();
    remote._options = {};
    const rawCookie = {
      cookie: 'session-id=123; csrf=abc',
      localCookie: 'session-id=123; csrf=abc',
      refreshToken: 'Atnr|test-refresh-token',
      macDms: { device_private_key: 'k', adp_token: 't' },
    };

    const prepared = prepareCookieForAlexaRemote(rawCookie);
    assert.equal('cookie' in prepared, false);
    assert.equal(prepared.localCookie, 'session-id=123; csrf=abc');
    assert.equal(rawCookie.cookie, 'session-id=123; csrf=abc');

    remote.setCookie(prepared);
    assert.ok(remote.cookieData);
    assert.equal(remote.cookieData.refreshToken, 'Atnr|test-refresh-token');
  });

  it('connectAlexa reloads cookieFile automatically when mtime/size changes on disk', async () => {
    const tmpDir = createTempDir();
    try {
      const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
      fs.writeFileSync(cookieFile, JSON.stringify({
        localCookie: 'session=v1; csrf=c1',
        refreshToken: 'Atnr|v1',
        macDms: { k: 1 },
      }), 'utf8');

      const seenCookies = [];
      class MockAlexa {
        on() {}
        removeAllListeners() {}
        init(opts, cb) {
          seenCookies.push(opts.cookie.localCookie);
          process.nextTick(() => cb(null));
        }
      }

      const authManager = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: MockAlexa });
      await authManager.connectAlexa();
      assert.deepEqual(seenCookies, ['session=v1; csrf=c1']);

      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(cookieFile, JSON.stringify({
        localCookie: 'session=v2-updated; csrf=c2',
        refreshToken: 'Atnr|v2-updated',
        macDms: { k: 2 },
      }), 'utf8');

      await authManager.connectAlexa();
      assert.deepEqual(seenCookies, ['session=v1; csrf=c1', 'session=v2-updated; csrf=c2']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('connectAlexa does not re-initialize when saveCookieData writes during init cookie event', async () => {
    const tmpDir = createTempDir();
    try {
      const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
      fs.writeFileSync(cookieFile, JSON.stringify({
        localCookie: 'session=v1; csrf=c1',
        refreshToken: 'Atnr|v1',
        macDms: { k: 1 },
      }), 'utf8');

      let initCount = 0;
      class CookieEmittingAlexa extends EventEmitter {
        init(opts, cb) {
          initCount += 1;
          this.cookieData = { ...opts.cookie, extraField: `init-${initCount}` };
          this.emit('cookie', this.cookieData);
          process.nextTick(() => cb(null));
        }
        removeAllListeners() {
          super.removeAllListeners();
        }
      }

      const authManager = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: CookieEmittingAlexa });
      await authManager.connectAlexa();
      assert.equal(initCount, 1);

      // 2nd connectAlexa should reuse existing connection without re-init
      await authManager.connectAlexa();
      assert.equal(initCount, 1);

      // External update should still trigger reconnect
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(cookieFile, JSON.stringify({
        localCookie: 'session=external-v2; csrf=c2',
        refreshToken: 'Atnr|external-v2',
        macDms: { k: 2 },
      }), 'utf8');
      await authManager.connectAlexa();
      assert.equal(initCount, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('alarmService.skipAlarm retries once from disk on first auth error and throws AuthRequiredError only after 2nd auth failure', async () => {
    const tmpDir = createTempDir();
    try {
      const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
      fs.writeFileSync(cookieFile, JSON.stringify({
        localCookie: 'session=ok; csrf=c1',
        refreshToken: 'Atnr|ok',
        macDms: { k: 1 },
      }), 'utf8');

      let cancelAttempts = 0;
      const soonIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      class MockAlexa {
        constructor() {
          this.endpoints = { alexaApiUrl: 'https://alexa.amazon.co.jp' };
        }
        on() {}
        removeAllListeners() {}
        init(opts, cb) { process.nextTick(() => cb(null)); }
        getDevices(cb) { process.nextTick(() => cb(null, { devices: [] })); }
        getNotifications(cached, cb) {
          process.nextTick(() => cb(null, {
            notifications: [{
              notificationIndex: 'a-1',
              type: 'Alarm',
              status: 'ON',
              trigger: { scheduledTime: soonIso },
            }],
          }));
        }
        cancelNotification(n, cb) {
          cancelAttempts += 1;
          if (cancelAttempts === 1) {
            process.nextTick(() => cb(new Error('401 Unauthorized')));
            return;
          }
          process.nextTick(() => cb(null));
        }
      }

      const authManager = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: MockAlexa });
      const alarmService = createAlarmService(authManager);

      const res = await alarmService.skipAlarm({ id: 'a-1' });
      assert.equal(res.ok, true);
      assert.equal(cancelAttempts, 2);

      // Always fail with 401 -> throws AuthRequiredError after 1 retry (2 more attempts)
      cancelAttempts = 0;
      class AlwaysFailAlexa extends MockAlexa {
        cancelNotification(n, cb) {
          cancelAttempts += 1;
          process.nextTick(() => cb(new Error('401 Unauthorized')));
        }
      }
      const failAuth = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: AlwaysFailAlexa });
      const failService = createAlarmService(failAuth);
      await assert.rejects(() => failService.skipAlarm({ id: 'a-1' }), (err) => err instanceof AuthRequiredError);
      assert.equal(cancelAttempts, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resetChromeWindowPlacement preserves last position, resets size, cleans Sessions, and handles missing/corrupt files', () => {
    const tmpDir = createTempDir();
    try {
      assert.equal(DEFAULT_APP_WINDOW_WIDTH, 420);
      assert.equal(DEFAULT_APP_WINDOW_HEIGHT, 720);

      // Missing Preferences -> no throw, returns default { left: 80, top: 80 }
      assert.deepEqual(resetChromeWindowPlacement(tmpDir, 420, 720), { left: 80, top: 80 });

      const defaultDir = path.join(tmpDir, 'Default');
      const sessionsDir = path.join(defaultDir, 'Sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'Apps_123'), 'x', 'utf8');
      fs.writeFileSync(path.join(sessionsDir, 'Tabs_456'), 'x', 'utf8');
      fs.writeFileSync(path.join(sessionsDir, 'Session_789'), 'x', 'utf8');
      fs.writeFileSync(path.join(sessionsDir, 'README.txt'), 'keep', 'utf8');

      const prefsPath = path.join(defaultDir, 'Preferences');

      // Corrupt JSON -> no throw, cleans Sessions and returns default { left: 80, top: 80 }
      fs.writeFileSync(prefsPath, '{not-json', 'utf8');
      assert.deepEqual(resetChromeWindowPlacement(tmpDir, 420, 720), { left: 80, top: 80 });
      assert.equal(fs.existsSync(path.join(sessionsDir, 'Apps_123')), false);
      assert.equal(fs.existsSync(path.join(sessionsDir, 'Tabs_456')), false);
      assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_789')), false);
      assert.equal(fs.existsSync(path.join(sessionsDir, 'README.txt')), true);

      // Valid Preferences with app_window_placement (230, 49, 1296x861)
      fs.writeFileSync(prefsPath, JSON.stringify({
        profile: { name: 'AppUser' },
        browser: {
          has_seen_welcome_page: true,
          app_window_placement: {
            127: {
              0: {
                0: {
                  '1_/': {
                    left: 230,
                    top: 49,
                    right: 1526,
                    bottom: 910,
                    maximized: false,
                    work_area_left: 0,
                    work_area_top: 0,
                    work_area_right: 1920,
                    work_area_bottom: 1032,
                  },
                },
              },
            },
          },
          window_placement: {
            left: 100,
            top: 50,
            right: 900,
            bottom: 850,
            maximized: true,
          },
        },
      }), 'utf8');

      assert.deepEqual(resetChromeWindowPlacement(tmpDir, 420, 720), { left: 230, top: 49 });
      const updated = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      assert.equal(updated.profile.name, 'AppUser');
      assert.equal(updated.browser.has_seen_welcome_page, true);
      assert.deepEqual(updated.browser.window_placement, {
        work_area_left: 0,
        work_area_top: 0,
        work_area_right: 1920,
        work_area_bottom: 1032,
        left: 230,
        top: 49,
        right: 650,
        bottom: 769,
        maximized: false,
      });
      assert.deepEqual(updated.browser.app_window_placement['127']['0']['0']['1_/'], {
        work_area_left: 0,
        work_area_top: 0,
        work_area_right: 1920,
        work_area_bottom: 1032,
        left: 230,
        top: 49,
        right: 650,
        bottom: 769,
        maximized: false,
      });

      // Off-screen coordinates clamped into work_area
      fs.writeFileSync(prefsPath, JSON.stringify({
        browser: {
          app_window_placement: {
            127: { 0: { 0: { '1_/': { left: 1800, top: 900, right: 2220, bottom: 1620, work_area_left: 0, work_area_top: 0, work_area_right: 1920, work_area_bottom: 1032 } } } },
          },
        },
      }), 'utf8');
      assert.deepEqual(resetChromeWindowPlacement(tmpDir, 420, 720), { left: 1500, top: 312 });

      // Minimized invalid coordinates (-32000) -> reset to default (80, 80)
      fs.writeFileSync(prefsPath, JSON.stringify({
        browser: {
          app_window_placement: {
            127: { 0: { 0: { '1_/': { left: -32000, top: -32000, right: -31580, bottom: -31280 } } } },
          },
        },
      }), 'utf8');
      assert.deepEqual(resetChromeWindowPlacement(tmpDir, 420, 720), { left: 80, top: 80 });

      // Valid multi-monitor negative coordinates preserved within negative work_area
      fs.writeFileSync(prefsPath, JSON.stringify({
        browser: {
          app_window_placement: {
            127: { 0: { 0: { '1_/': { left: -800, top: 100, right: -380, bottom: 820, work_area_left: -1920, work_area_top: 0, work_area_right: 0, work_area_bottom: 1080 } } } },
          },
        },
      }), 'utf8');
      assert.deepEqual(resetChromeWindowPlacement(tmpDir, 420, 720), { left: -800, top: 100 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('launchAppBrowser passes --window-position, --window-size, and --disable-session-crashed-bubble to Chrome', async () => {
    const tmpDir = createTempDir();
    try {
      const defaultDir = path.join(tmpDir, 'Default');
      fs.mkdirSync(defaultDir, { recursive: true });
      fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify({
        browser: {
          app_window_placement: {
            127: { 0: { 0: { '1_/': { left: 230, top: 49, right: 1526, bottom: 910, work_area_left: 0, work_area_top: 0, work_area_right: 1920, work_area_bottom: 1032 } } } },
          },
        },
      }), 'utf8');

      let capturedCmd = '';
      const origExit = process.exit;
      process.exit = () => {};
      try {
        const wm = createWindowManager({
          userDataDir: tmpDir,
          exec: (cmd) => { capturedCmd = cmd; },
        });
        wm.launchAppBrowser(54321);
        await wm.shutdownServer('test-cleanup');
      } finally {
        process.exit = origExit;
      }

      assert.match(capturedCmd, /--window-position=230,49/);
      assert.match(capturedCmd, /--window-size=420,720/);
      assert.match(capturedCmd, /--disable-session-crashed-bubble/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prototype/web-ui.js serializes rapid skip and restoreAll mutations, isolates errors, and prevents mid-queue disappearance', async () => {
    const vm = require('vm');
    const { handleRequest: webUiHandleRequest } = require('../prototype/web-ui');
    const htmlRes = await new Promise((resolve, reject) => {
      const srv = http.createServer(webUiHandleRequest);
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => { srv.close(() => resolve(raw)); });
        }).on('error', reject);
      });
    });

    const scriptMatch = htmlRes.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch);
    const scriptCode = scriptMatch[1];

    const makeEl = () => ({
      textContent: '',
      title: '',
      className: '',
      hidden: false,
      disabled: false,
      innerHTML: '',
      _listeners: {},
      classList: { add() {}, remove() {} },
      setAttribute() {},
      addEventListener(type, fn) { this._listeners[type] = fn; },
    });
    const elements = {
      statusBar: makeEl(),
      loadingOverlay: makeEl(),
      metaText: makeEl(),
      loginCard: makeEl(),
      timelineList: makeEl(),
      skippedList: makeEl(),
      tabActiveBtn: makeEl(),
      tabSkippedBtn: makeEl(),
      activeCountText: makeEl(),
      skippedCountText: makeEl(),
      panelActive: makeEl(),
      panelSkipped: makeEl(),
      restoreAllBtn: makeEl(),
      refreshBtn: makeEl(),
      openLoginBtn: makeEl(),
    };

    const a1 = {
      id: 'a-1', notificationIndex: 'a-1', deviceName: 'Echo', type: 'Alarm', label: '',
      recurringText: '毎日', originalDate: '2026-11-20', originalTime: '08:00:00.000',
      timeText: '08:00', dayBadge: '明日 (金)', dateLabel: '明日 11/20 (金)', dateKey: '2026-11-20', whenMs: 1000,
    };
    const a2 = {
      id: 'a-2', notificationIndex: 'a-2', deviceName: 'Echo', type: 'Alarm', label: '',
      recurringText: '毎日', originalDate: '2026-11-20', originalTime: '08:30:00.000',
      timeText: '08:30', dayBadge: '明日 (金)', dateLabel: '明日 11/20 (金)', dateKey: '2026-11-20', whenMs: 2000,
    };

    let inFlightCount = 0;
    let maxInFlight = 0;
    const mutationRequests = [];
    const deferred = [];

    vm.runInNewContext(scriptCode, {
      window: { location: { origin: 'http://127.0.0.1' }, open() {}, addEventListener() {} },
      document: {
        visibilityState: 'visible',
        getElementById: (id) => elements[id] || makeEl(),
        addEventListener() {},
      },
      navigator: { sendBeacon: () => true },
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: (url, opts) => {
        if (url === '/api/heartbeat') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        }
        if (url === '/api/alarms') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ active: [a1, a2], skipped: [], deviceCount: 1, checkedAt: '10:00:00' }),
          });
        }
        inFlightCount += 1;
        maxInFlight = Math.max(maxInFlight, inFlightCount);
        const body = JSON.parse(opts.body);
        mutationRequests.push({ url, id: body.id });
        return new Promise((resolve) => {
          deferred.push({ url, id: body.id, resolve });
        });
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Rapidly click skip twice (index 0 twice: a-1 then a-2)
    elements.timelineList._listeners.click({
      target: { closest: (sel) => (sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null) },
    });
    elements.timelineList._listeners.click({
      target: { closest: (sel) => (sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null) },
    });

    await new Promise((r) => setTimeout(r, 20));
    // Serialized: only 1st request should have started while 1st is pending
    assert.equal(maxInFlight, 1);
    assert.equal(mutationRequests.length, 1);
    assert.equal(mutationRequests[0].id, 'a-1');

    // Fail 1st request (HTTP 500) -> 2nd request must still run, and a-2 must stay in skipped (not lost)
    inFlightCount -= 1;
    deferred[0].resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(maxInFlight, 1);
    assert.equal(mutationRequests.length, 2);
    assert.equal(mutationRequests[1].id, 'a-2');
    assert.equal(elements.skippedList.innerHTML.includes('08:30'), true);

    // Complete 2nd request -> mid-queue a-1 was rolled back, a-2 is skipped
    inFlightCount -= 1;
    deferred[1].resolve({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        active: [a1],
        skipped: [Object.assign({}, a2, { isSkipped: true })],
        deviceCount: 1,
        checkedAt: '10:00:02',
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(elements.skippedList.innerHTML.includes('08:30'), true);
    assert.equal(elements.timelineList.innerHTML.includes('08:00'), true);
  });
});
