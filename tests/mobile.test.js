'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { createAlexaAuthManager } = require('../src/core/alexa-auth');
const { createAlarmService } = require('../src/core/alarm-service');
const { createMobileServer } = require('../nodejs/server');
const { runPrepare } = require('../scripts/prepare-mobile');
const { createMobilePreviewServer } = require('../scripts/mobile-preview-server');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-mobile-test-'));
}

function createMockAlexaClass(behavior = {}) {
  return class MockAlexaRemote extends EventEmitter {
    constructor() {
      super();
      this.endpoints = { alexaApiUrl: 'https://alexa.amazon.co.jp' };
      this.cookieData = { cookie: 'mock-cookie=1', macDms: { k: 'v' } };
    }

    init(opts, cb) {
      if (behavior.init) {
        behavior.init(this, opts, cb);
        return;
      }
      process.nextTick(() => cb(null));
    }

    getDevices(cb) {
      if (behavior.getDevices) {
        behavior.getDevices(this, cb);
        return;
      }
      process.nextTick(() => cb(null, { devices: [] }));
    }

    getNotifications(cached, cb) {
      if (behavior.getNotifications) {
        behavior.getNotifications(this, cached, cb);
        return;
      }
      process.nextTick(() => cb(null, { notifications: [] }));
    }

    cancelNotification(notification, cb) {
      process.nextTick(() => cb(null));
    }

    changeNotification(notification, value, cb) {
      process.nextTick(() => cb(null));
    }

    setNotificationV2(notificationIndex, payload, cb) {
      process.nextTick(() => cb(null));
    }
  };
}

describe('scripts/prepare-mobile.js', () => {
  it('syncs src/core and production node_modules without any cookie secrets', () => {
    const result = runPrepare();
    assert.ok(result.coreCount >= 4);
    assert.ok(result.pkgCount >= 1);

    const rootDir = path.resolve(__dirname, '..');
    assert.equal(fs.existsSync(path.join(rootDir, 'nodejs', 'src', 'core', 'alarm-service.js')), true);
    assert.equal(fs.existsSync(path.join(rootDir, 'nodejs', 'node_modules', 'alexa-remote2', 'package.json')), true);
    assert.equal(fs.existsSync(path.join(rootDir, 'www', 'nodejs', 'node_modules', 'alexa-remote2', 'package.json')), true);
    assert.equal(fs.existsSync(path.join(rootDir, 'nodejs', 'alexa-cookie.json')), false);
    assert.equal(fs.existsSync(path.join(rootDir, 'www', 'alexa-cookie.json')), false);
  });

  it('removes mipmap-anydpi-v26 adaptive icon XMLs and copies custom mipmap icons byte-for-byte', () => {
    runPrepare();
    const rootDir = path.resolve(__dirname, '..');
    const resDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'res');
    const srcResDir = path.join(rootDir, 'assets', 'icons', 'android', 'res');

    assert.equal(fs.existsSync(path.join(resDir, 'mipmap-anydpi-v26')), false);
    assert.equal(fs.existsSync(path.join(resDir, 'drawable', 'ic_launcher_background.xml')), false);
    assert.equal(fs.existsSync(path.join(resDir, 'drawable-v24', 'ic_launcher_foreground.xml')), false);

    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const expected = fs.readFileSync(path.join(srcResDir, `mipmap-${density}`, 'ic_launcher.png'));
      const actual = fs.readFileSync(path.join(resDir, `mipmap-${density}`, 'ic_launcher.png'));
      assert.equal(Buffer.compare(actual, expected), 0, `mipmap-${density}/ic_launcher.png mismatch`);
    }
  });

  it('generates android/app/src/main/assets/builtin_modules/bridge with valid JS syntax', () => {
    runPrepare();
    const rootDir = path.resolve(__dirname, '..');
    const bridgeDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'assets', 'builtin_modules', 'bridge');
    const bridgeIndexPath = path.join(bridgeDir, 'index.js');
    const bridgePkgPath = path.join(bridgeDir, 'package.json');

    assert.equal(fs.existsSync(bridgeIndexPath), true);
    assert.equal(fs.existsSync(bridgePkgPath), true);

    const pkg = JSON.parse(fs.readFileSync(bridgePkgPath, 'utf8'));
    assert.equal(pkg.name, 'bridge');
    assert.equal(pkg.main, 'index.js');

    const src = fs.readFileSync(bridgeIndexPath, 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: bridgeIndexPath }));
    assert.equal(fs.existsSync(path.join(rootDir, 'nodejs', 'node_modules', 'bridge', 'index.js')), true);
    assert.equal(fs.existsSync(path.join(rootDir, 'www', 'nodejs', 'node_modules', 'bridge', 'index.js')), true);
  });
});

describe('nodejs/server.js HTTP API & 24h widget summary', () => {
  function httpRequest(baseUrl, reqPath, options = {}) {
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
            body: raw ? JSON.parse(raw) : null,
          });
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  it('responds to OPTIONS with 204 CORS headers and serves alarms, skip, restore, and widget summary', async () => {
    const tmpDir = createTempDir();
    const cookieFile = path.join(tmpDir, 'cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'ok=1' }), 'utf8');

    const fixedNow = Date.parse('2026-11-15T10:00:00+09:00');
    const MockClass = createMockAlexaClass({
      getDevices(inst, cb) {
        process.nextTick(() => cb(null, { devices: [{ serialNumber: 'DEV1', accountName: 'Echo Show' }] }));
      },
      getNotifications(inst, cached, cb) {
        process.nextTick(() => cb(null, {
          notifications: [
            {
              notificationIndex: 'within-24h',
              type: 'Alarm',
              status: 'ON',
              deviceSerialNumber: 'DEV1',
              recurringPattern: 'P1D',
              sound: { id: 'system_alerts_melodic_01' },
              trigger: { scheduledTime: '2026-11-16T07:00:00+09:00' },
            },
            {
              notificationIndex: 'beyond-24h',
              type: 'Alarm',
              status: 'ON',
              deviceSerialNumber: 'DEV1',
              trigger: { scheduledTime: '2026-11-16T12:00:00+09:00' },
            },
          ],
        }));
      },
    });

    const authManager = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: MockClass });
    const alarmService = createAlarmService(authManager, { restoreWaitMs: 1, nowFn: () => fixedNow });
    const srv = createMobileServer({ authManager, alarmService });

    try {
      const { port } = await srv.start();
      const baseUrl = `http://127.0.0.1:${port}`;

      const preflight = await httpRequest(baseUrl, '/api/alarms', { method: 'OPTIONS' });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers['access-control-allow-origin'], '*');

      const alarms = await httpRequest(baseUrl, '/api/alarms');
      assert.equal(alarms.status, 200);
      assert.equal(alarms.headers['access-control-allow-origin'], '*');
      assert.equal(alarms.body.active.length, 1);
      assert.equal(alarms.body.active[0].id, 'within-24h');
      assert.equal(alarms.body.widgetSummary.hasAlarm, true);
      assert.equal(alarms.body.widgetSummary.nextAlarm.id, 'within-24h');

      const widget = await httpRequest(baseUrl, '/api/widget/summary');
      assert.equal(widget.status, 200);
      assert.equal(widget.body.hasAlarm, true);
      assert.equal(widget.body.totalCount, 1);

      const skip = await httpRequest(baseUrl, '/api/alarms/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'within-24h' }),
      });
      assert.equal(skip.status, 200);
      assert.equal(skip.body.ok, true);
      assert.equal(skip.body.widgetSummary.hasAlarm, true);

      const restore = await httpRequest(baseUrl, '/api/alarms/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'within-24h' }),
      });
      assert.equal(restore.status, 200);
      assert.equal(restore.body.ok, true);
      assert.equal(restore.body.widgetSummary.hasAlarm, true);
    } finally {
      await srv.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns widgetSummary.hasAlarm === false when only alarms beyond 24h exist', async () => {
    const tmpDir = createTempDir();
    const cookieFile = path.join(tmpDir, 'cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'ok=1' }), 'utf8');

    const fixedNow = Date.parse('2026-11-15T10:00:00+09:00');
    const MockClass = createMockAlexaClass({
      getDevices(inst, cb) {
        process.nextTick(() => cb(null, { devices: [{ serialNumber: 'DEV1', accountName: 'Echo Show' }] }));
      },
      getNotifications(inst, cached, cb) {
        process.nextTick(() => cb(null, {
          notifications: [
            {
              notificationIndex: 'far-alarm',
              type: 'Alarm',
              status: 'ON',
              deviceSerialNumber: 'DEV1',
              trigger: { scheduledTime: '2026-11-16T11:00:00+09:00' },
            },
          ],
        }));
      },
    });

    const authManager = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: MockClass });
    const alarmService = createAlarmService(authManager, { restoreWaitMs: 1, nowFn: () => fixedNow });
    const srv = createMobileServer({ authManager, alarmService });

    try {
      const { port } = await srv.start();
      const baseUrl = `http://127.0.0.1:${port}`;
      const widget = await httpRequest(baseUrl, '/api/widget/summary');
      assert.equal(widget.status, 200);
      assert.equal(widget.body.hasAlarm, false);
      assert.equal(widget.body.nextAlarm, null);
      assert.equal(widget.body.totalCount, 0);
    } finally {
      await srv.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('POST /api/alarms/skip succeeds without needsLogin when cookie and refreshToken coexist in alexa-cookie.json', async () => {
    const tmpDir = createTempDir();
    const cookieFile = path.join(tmpDir, 'alexa-cookie.json');
    fs.writeFileSync(cookieFile, JSON.stringify({
      cookie: 'session-id=123; csrf=abc',
      localCookie: 'session-id=123; csrf=abc',
      refreshToken: 'Atnr|valid-refresh-token',
      macDms: { device_private_key: 'k', adp_token: 't' },
    }), 'utf8');

    const AlexaRemote = require('alexa-remote2');
    const fixedNow = Date.parse('2026-11-15T10:00:00+09:00');
    class CoexistingCookieAlexa extends AlexaRemote {
      init(opts, cb) {
        this._options = opts;
        this.setCookie(opts.cookie);
        this.endpoints = { alexaApiUrl: 'https://alexa.amazon.co.jp' };
        process.nextTick(() => cb(null));
      }
      getDevices(cb) {
        process.nextTick(() => cb(null, { devices: [{ serialNumber: 'DEV1', accountName: 'Echo' }] }));
      }
      getNotifications(cached, cb) {
        process.nextTick(() => cb(null, {
          notifications: [{
            notificationIndex: 'n-coexist',
            type: 'Alarm',
            status: 'ON',
            deviceSerialNumber: 'DEV1',
            trigger: { scheduledTime: '2026-11-15T12:00:00+09:00' },
          }],
        }));
      }
      cancelNotification(notification, cb) {
        if (!this.cookieData || !this.cookieData.refreshToken) {
          process.nextTick(() => cb(new TypeError("Cannot read properties of null (reading 'refreshToken')")));
          return;
        }
        process.nextTick(() => cb(null));
      }
    }

    const authManager = createAlexaAuthManager({ cookieFile, AlexaRemoteClass: CoexistingCookieAlexa });
    const alarmService = createAlarmService(authManager, { restoreWaitMs: 1, nowFn: () => fixedNow });
    const srv = createMobileServer({ authManager, alarmService });

    try {
      const { port } = await srv.start();
      const baseUrl = `http://127.0.0.1:${port}`;
      const skip = await httpRequest(baseUrl, '/api/alarms/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'n-coexist' }),
      });
      assert.equal(skip.status, 200);
      assert.equal(skip.body.ok, true);
      assert.equal(skip.body.needsLogin, undefined);
    } finally {
      await srv.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('scripts/mobile-preview-server.js (--mock)', () => {
  function rawRequest(baseUrl, reqPath, options = {}) {
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
          resolve({ status: res.statusCode, headers: res.headers, raw });
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  it('serves www/, /widget-preview.html, and mock /api/* routes', async () => {
    const preview = createMobilePreviewServer({ mock: true });
    try {
      const info = await preview.start();

      const home = await rawRequest(info.url, '/');
      assert.equal(home.status, 200);
      assert.match(home.raw, /<html/i);

      const widgetPage = await rawRequest(info.url, '/widget-preview.html');
      assert.equal(widgetPage.status, 200);
      assert.match(widgetPage.raw, /widget-box/);

      const alarms = await rawRequest(info.url, '/api/alarms');
      assert.equal(alarms.status, 200);
      const alarmsJson = JSON.parse(alarms.raw);
      assert.equal(alarmsJson.active.length, 2);
      assert.equal(alarmsJson.skipped.length, 1);

      const skipped = await rawRequest(info.url, '/api/alarms/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alarmsJson.active[0].id }),
      });
      assert.equal(skipped.status, 200);
      const skippedJson = JSON.parse(skipped.raw);
      assert.equal(skippedJson.active.length, 1);

      const summary = await rawRequest(info.url, '/api/widget/summary');
      assert.equal(summary.status, 200);
      const summaryJson = JSON.parse(summary.raw);
      assert.equal(summaryJson.hasAlarm, true);
      assert.equal(summaryJson.nextAlarm.timeText, '08:30');
    } finally {
      await preview.stop();
    }
  });

  it('supports freshAuth mode with isolated temp cookie and returns 401 needsLogin initially', async () => {
    const rootDir = path.resolve(__dirname, '..');
    const rootCookiePath = path.join(rootDir, 'alexa-cookie.json');
    const rootCookieBefore = fs.existsSync(rootCookiePath) ? fs.readFileSync(rootCookiePath, 'utf8') : null;

    const MockAuthAlexa = createMockAlexaClass({
      init(inst, opts, cb) {
        if (opts && opts.proxyOnly) {
          process.nextTick(() => cb(new Error(`Please open http://127.0.0.1:${opts.proxyPort}/`)));
          return;
        }
        process.nextTick(() => cb(null));
      },
    });
    const preview = createMobilePreviewServer({ freshAuth: true, AlexaRemoteClass: MockAuthAlexa });
    let tempDir = null;
    try {
      const info = await preview.start();
      assert.equal(info.freshAuth, true);
      assert.ok(info.cookieFile && !info.cookieFile.startsWith(rootDir));
      tempDir = path.dirname(info.cookieFile);

      const res = await rawRequest(info.url, '/api/alarms');
      assert.equal(res.status, 401);
      const body = JSON.parse(res.raw);
      assert.equal(body.needsLogin, true);
      assert.match(body.loginUrl || '', /^http:\/\/127\.0\.0\.1:\d+\/?$/);

      const rootCookieAfter = fs.existsSync(rootCookiePath) ? fs.readFileSync(rootCookiePath, 'utf8') : null;
      assert.equal(rootCookieAfter, rootCookieBefore);
    } finally {
      await preview.stop();
      if (tempDir) {
        assert.equal(fs.existsSync(tempDir), false);
      }
    }
  });
});

describe('www/app.js CapgoInAppBrowser integration', () => {
  function runAppInMockContext(plugins) {
    const vm = require('vm');
    const appCode = fs.readFileSync(path.resolve(__dirname, '..', 'www', 'app.js'), 'utf8');
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
          setAttribute() {},
          addEventListener(type, fn) {
            listeners[type] = fn;
          },
        };
      }
      return elements[id];
    };

    const windowOpenCalls = [];
    const windowObj = {
      location: { search: '', origin: 'http://localhost' },
      open: (...args) => {
        windowOpenCalls.push(args);
      },
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: plugins,
      },
    };
    const context = {
      window: windowObj,
      document: { getElementById: getEl },
      URLSearchParams,
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ loginUrl: 'http://127.0.0.1:45678/' }),
      }),
    };
    vm.runInNewContext(appCode, context);
    return { elements, windowOpenCalls };
  }

  it('uses CapgoInAppBrowser.openWebView with preventDeeplink: true and never calls window.open on native', async () => {
    const openCalls = [];
    const listenerEvents = [];
    const capgoPlugin = {
      addListener(eventName, fn) {
        listenerEvents.push({ eventName, fn });
      },
      async openWebView(opts) {
        openCalls.push(opts);
      },
      async close() {},
    };
    const nodejsPlugin = {
      async addListener() {},
      async isReady() { return { ready: false }; },
      async send() {},
    };

    const { elements, windowOpenCalls } = runAppInMockContext({
      CapgoInAppBrowser: capgoPlugin,
      Nodejs: nodejsPlugin,
    });

    assert.deepEqual(
      listenerEvents.map((x) => x.eventName),
      ['urlChangeEvent', 'closeEvent']
    );

    await elements.openLoginBtn._listeners.click();
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0].url, 'http://127.0.0.1:45678/');
    assert.equal(openCalls[0].preventDeeplink, true);
    assert.equal(windowOpenCalls.length, 0);
  });

  it('does not fall back to window.open on native when CapgoInAppBrowser is missing', async () => {
    const nodejsPlugin = {
      async addListener() {},
      async isReady() { return { ready: false }; },
      async send() {},
    };

    const { elements, windowOpenCalls } = runAppInMockContext({
      Nodejs: nodejsPlugin,
    });

    await elements.openLoginBtn._listeners.click();
    assert.equal(windowOpenCalls.length, 0);
    assert.match(elements.statusBar.textContent, /CapgoInAppBrowser/);
  });

  it('applies fixed layout (100dvh, overflow: hidden) and scrollable .list in both www/style.css and prototype/web-ui.js', () => {
    const mobileCss = fs.readFileSync(path.resolve(__dirname, '..', 'www', 'style.css'), 'utf8');
    const desktopHtml = fs.readFileSync(path.resolve(__dirname, '..', 'prototype', 'web-ui.js'), 'utf8');

    for (const content of [mobileCss, desktopHtml]) {
      assert.match(content, /height:\s*100dvh;/);
      assert.match(content, /overflow:\s*hidden;/);
      assert.match(content, /\.list\s*\{[\s\S]*?overflow-y:\s*auto;/);
      assert.match(content, /\.tab-panel\s*\{[\s\S]*?min-height:\s*0;/);
    }
  });

  it('defines .date-divider and .empty-group in www/style.css and renders date-grouped active rows in www/app.js', async () => {
    const mobileCss = fs.readFileSync(path.resolve(__dirname, '..', 'www', 'style.css'), 'utf8');
    assert.match(mobileCss, /\.date-divider\s*\{[\s\S]*?min-height:\s*36px;/);
    assert.match(mobileCss, /\.date-divider\s*\{[\s\S]*?pointer-events:\s*none;/);
    assert.match(mobileCss, /\.date-divider::after\s*\{[\s\S]*?height:\s*1px;/);
    assert.match(mobileCss, /\.empty-group\s*\{[\s\S]*?min-height:\s*46px;/);
    assert.match(mobileCss, /\.empty-group\s*\{[\s\S]*?pointer-events:\s*none;/);
    assert.match(mobileCss, /\.list\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/);
    assert.match(mobileCss, /\.list::-webkit-scrollbar-thumb\s*\{[\s\S]*?rgba\(148,\s*163,\s*184,\s*0\.38\)/);
    assert.match(mobileCss, /\.status-bar\s*\{[\s\S]*?white-space:\s*nowrap;/);
    assert.match(mobileCss, /\.status-bar\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
    assert.match(mobileCss, /\.status-bar\s*\{[\s\S]*?border-top:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.14\)/);
    assert.match(mobileCss, /\.row\s*\{[\s\S]*?flex-shrink:\s*0;/);
    assert.equal(mobileCss.includes('.row-next'), false);
    assert.equal(mobileCss.includes('border-style: dashed'), false);
    assert.match(mobileCss, /\.tabs\s*\{[\s\S]*?border-bottom:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.18\)/);
    assert.match(mobileCss, /\.tab-btn\.active::after\s*\{[\s\S]*?height:\s*3px;/);

    const appCode = fs.readFileSync(path.resolve(__dirname, '..', 'www', 'app.js'), 'utf8');
    assert.ok(appCode.includes('function renderActiveTimeline('));
    assert.ok(appCode.includes('function isTodayAlarmItem('));

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
          classList: { add() {}, remove() {} },
          _listeners: listeners,
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
        id: 'm1',
        timeText: '07:00',
        dayBadge: '今日 (木)',
        dateLabel: '今日 11/19 (木)',
        dateKey: '2026-11-19',
        deviceName: 'Echo Show',
        recurringText: '毎日',
        whenMs: 1000,
      },
      {
        id: 'm2',
        timeText: '08:00',
        dayBadge: '今日 (木)',
        dateLabel: '今日 11/19 (木)',
        dateKey: '2026-11-19',
        deviceName: 'Echo Dot',
        recurringText: '1回のみ',
        whenMs: 2000,
      },
      {
        id: 'm3',
        timeText: '06:45',
        dayBadge: '明日 (金)',
        dateLabel: '明日 11/20 (金)',
        dateKey: '2026-11-20',
        deviceName: 'Echo Show',
        recurringText: '毎日',
        whenMs: 3000,
      },
    ];

    const context = {
      window: {
        location: { search: '?mockUrl=http://127.0.0.1:9999', origin: 'http://localhost' },
        open() {},
      },
      document: {
        visibilityState: 'visible',
        getElementById: getEl,
        addEventListener() {},
      },
      URLSearchParams,
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (url) => {
        if (url.endsWith('/api/alarms')) {
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

    vm.runInNewContext(appCode, context);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const html = elements.timelineList.innerHTML;
    const dividers = [...html.matchAll(/<div class="date-divider"[^>]*>([^<]+)<\/div>/g)].map((m) => m[1]);
    assert.deepEqual(dividers, ['今日 11/19 (木)', '明日 11/20 (金)']);

    const idxMatches = [...html.matchAll(/data-idx="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(idxMatches, ['0', '1', '2']);
    assert.equal(html.includes('class="day-tag"'), false);

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
    assert.deepEqual(
      [...afterTodaySkipped.matchAll(/<div class="date-divider"[^>]*>([^<]+)<\/div>/g)].map((m) => m[1]),
      ['今日 11/19 (木)', '明日 11/20 (金)']
    );
    assert.ok(afterTodaySkipped.includes('<div class="empty-group">今日のアラームはありません</div>'));
    assert.deepEqual([...afterTodaySkipped.matchAll(/data-idx="(\d+)"/g)].map((m) => m[1]), ['0']);

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
    vm.runInNewContext(appCode, {
      window: { location: { search: '?mockUrl=http://127.0.0.1:9999', origin: 'http://localhost' }, open() {} },
      document: { visibilityState: 'visible', getElementById: getEl2, addEventListener() {} },
      URLSearchParams,
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith('/api/alarms')
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

  it('www/app.js enqueues and completes persistent mutations via AlarmWidget on native', async () => {
    const appCode = fs.readFileSync(path.resolve(__dirname, '..', 'www', 'app.js'), 'utf8');
    const enqueued = [];
    const completed = [];
    const elements = {};
    const getEl = (id) => {
      if (!elements[id]) {
        const listeners = {};
        elements[id] = {
          id, hidden: false, disabled: false, textContent: '', className: '', innerHTML: '',
          classList: { add() {}, remove() {} }, _listeners: listeners,
          setAttribute() {}, addEventListener(t, fn) { listeners[t] = fn; },
        };
      }
      return elements[id];
    };

    const sampleAlarm = {
      id: 'n-1',
      notificationIndex: 'n-1',
      deviceSerialNumber: 'DEV1',
      deviceName: 'Echo',
      type: 'Alarm',
      originalDate: '2026-11-19',
      originalTime: '08:00:00.000',
      label: '起床',
      recurringPattern: 'P1D',
      recurringText: '毎日',
      timeText: '08:00',
      dayBadge: '今日 (木)',
      dateLabel: '今日 11/19 (木)',
      dateKey: '2026-11-19',
      whenMs: 1000,
    };

    vm.runInNewContext(appCode, {
      window: {
        location: { search: '?mockUrl=http://127.0.0.1:9999', origin: 'http://localhost' },
        open() {},
        Capacitor: {
          isNativePlatform: () => true,
          Plugins: {
            AlarmWidget: {
              async enqueueMutation(opts) { enqueued.push(JSON.parse(opts.jobJson)); return { queued: true, count: 1 }; },
              async completeMutation(opts) { completed.push(opts.opId); return { removed: true, count: 0 }; },
            },
          },
        },
      },
      document: { visibilityState: 'visible', getElementById: getEl, addEventListener() {} },
      URLSearchParams,
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith('/api/alarms')
          ? { active: [sampleAlarm], skipped: [], deviceCount: 1, checkedAt: '05:00:00' }
          : { ok: true, active: [], skipped: [Object.assign({}, sampleAlarm, { isSkipped: true })], deviceCount: 1, checkedAt: '05:00:01' }),
      }),
    });

    await new Promise((r) => setTimeout(r, 30));
    elements.timelineList._listeners.click({
      target: {
        closest(sel) {
          return sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null;
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].action, 'skip');
    assert.equal(enqueued[0].alarmId, 'n-1');
    assert.equal(completed.length, 1);
    assert.equal(completed[0], enqueued[0].opId);
  });

  it('www/app.js sanitizes "null" labels from cached state and calls releaseInFlightMutation on skip failure', async () => {
    const rootDir = path.resolve(__dirname, '..');
    const appCode = fs.readFileSync(path.join(rootDir, 'www', 'app.js'), 'utf8');
    const released = [];

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
    const getEl = (id) => elements[id] || makeEl();

    const cachedPayload = {
      active: [{
        id: 'n-null',
        notificationIndex: 'n-null',
        deviceSerialNumber: 'DEV1',
        deviceName: 'Echo',
        type: 'Alarm',
        label: 'null',
        recurringText: '毎日',
        originalDate: '2026-11-19',
        originalTime: '06:30:00.000',
        timeText: '06:30',
        dayBadge: '今日',
        dateLabel: '今日 11/19 (木)',
        dateKey: '2026-11-19',
        whenMs: 1000,
      }],
      skipped: [],
      deviceCount: 1,
      checkedAt: '05:00:00',
    };

    vm.runInNewContext(appCode, {
      window: {
        location: { search: '?mockUrl=http://127.0.0.1:9999', origin: 'http://localhost' },
        open() {},
        Capacitor: {
          isNativePlatform: () => true,
          Plugins: {
            AlarmWidget: {
              async getCachedState() {
                return { hasCache: true, alarmsPayloadJson: JSON.stringify(cachedPayload) };
              },
              async enqueueMutation() { return { queued: true, count: 1 }; },
              async releaseInFlightMutation(opts) { released.push(opts.opId); return { ok: true }; },
            },
          },
        },
      },
      document: { visibilityState: 'visible', getElementById: getEl, addEventListener() {} },
      URLSearchParams,
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (url) => {
        if (url.endsWith('/api/alarms')) {
          return {
            ok: true,
            status: 200,
            json: async () => cachedPayload,
          };
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'network failure', needsLogin: false }),
        };
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(elements.timelineList.innerHTML.includes('alarm-label'), false);
    assert.equal(elements.timelineList.innerHTML.includes('>null<'), false);

    elements.timelineList._listeners.click({
      target: {
        closest(sel) {
          return sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null;
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(released.length, 1);
  });

  it('www/app.js calls AlarmWidget.updateWidgetSummary optimistically before API resolves on skip, restore, and restoreAll', async () => {
    const rootDir = path.resolve(__dirname, '..');
    const appCode = fs.readFileSync(path.join(rootDir, 'www', 'app.js'), 'utf8');
    const summaryUpdates = [];
    const deferredResponses = [];

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
    const getEl = (id) => elements[id] || makeEl();

    const alarm1 = {
      id: 'a-1',
      notificationIndex: 'a-1',
      deviceSerialNumber: 'DEV1',
      deviceName: 'Echo',
      type: 'Alarm',
      label: '',
      recurringText: '毎日',
      originalDate: '2026-11-20',
      originalTime: '08:00:00.000',
      timeText: '08:00',
      dayBadge: '明日 (金)',
      dateLabel: '明日 11/20 (金)',
      dateKey: '2026-11-20',
      whenMs: 1000,
    };
    const alarm2 = {
      id: 'a-2',
      notificationIndex: 'a-2',
      deviceSerialNumber: 'DEV1',
      deviceName: 'Echo',
      type: 'Alarm',
      label: '仕事',
      recurringText: '毎日',
      originalDate: '2026-11-20',
      originalTime: '08:30:00.000',
      timeText: '08:30',
      dayBadge: '明日 (金)',
      dateLabel: '明日 11/20 (金)',
      dateKey: '2026-11-20',
      whenMs: 2000,
    };

    vm.runInNewContext(appCode, {
      window: {
        location: { search: '?mockUrl=http://127.0.0.1:9999', origin: 'http://localhost' },
        open() {},
        Capacitor: {
          isNativePlatform: () => true,
          Plugins: {
            AlarmWidget: {
              async updateWidgetSummary(opts) {
                summaryUpdates.push(JSON.parse(opts.summaryJson));
                return { ok: true };
              },
              async enqueueMutation() { return { queued: true, count: 1 }; },
              async completeMutation() { return { removed: true, count: 0 }; },
            },
          },
        },
      },
      document: { visibilityState: 'visible', getElementById: getEl, addEventListener() {} },
      URLSearchParams,
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: (url) => {
        if (url.endsWith('/api/alarms')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              active: [alarm1, alarm2],
              skipped: [],
              deviceCount: 1,
              checkedAt: '05:00:00',
            }),
          });
        }
        return new Promise((resolve) => {
          deferredResponses.push({ url, resolve });
        });
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(summaryUpdates.length, 0);

    // 1. Skip alarm1 -> immediate optimistic updateWidgetSummary before API resolves
    elements.timelineList._listeners.click({
      target: { closest: (sel) => (sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null) },
    });
    assert.equal(summaryUpdates.length, 1);
    assert.equal(summaryUpdates[0].hasAlarm, true);
    assert.equal(summaryUpdates[0].nextAlarm.id, 'a-2');
    assert.equal(summaryUpdates[0].remainingCount, 0);

    // 2. Skip alarm2 -> immediate optimistic empty summary
    elements.timelineList._listeners.click({
      target: { closest: (sel) => (sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null) },
    });
    assert.equal(summaryUpdates.length, 2);
    assert.equal(summaryUpdates[1].hasAlarm, false);
    assert.equal(summaryUpdates[1].nextAlarm, null);

    // 3. Restore single (alarm1) -> immediate optimistic updateWidgetSummary
    elements.skippedList._listeners.click({
      target: { closest: (sel) => (sel === 'button[data-action="restore"]' ? { getAttribute: () => '0' } : null) },
    });
    assert.equal(summaryUpdates.length, 3);
    assert.equal(summaryUpdates[2].hasAlarm, true);
    assert.equal(summaryUpdates[2].nextAlarm.id, 'a-1');

    // 4. Skip alarm1 again, then RestoreAll -> single immediate optimistic summary with both alarms
    elements.timelineList._listeners.click({
      target: { closest: (sel) => (sel === 'button[data-action="skip"]' ? { getAttribute: () => '0' } : null) },
    });
    assert.equal(summaryUpdates.length, 4);
    elements.restoreAllBtn._listeners.click();
    assert.equal(summaryUpdates.length, 5);
    assert.equal(summaryUpdates[4].hasAlarm, true);
    assert.equal(summaryUpdates[4].nextAlarm.id, 'a-1');
    assert.equal(summaryUpdates[4].remainingCount, 1);
    assert.equal(summaryUpdates[4].totalCount, 2);
  });
});
