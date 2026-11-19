#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { buildWidgetSummary } = require('../src/core/alarm-service');
const { createAlexaAuthManager } = require('../src/core/alexa-auth');
const { createMobileServer } = require('../nodejs/server');

const ROOT_DIR = path.resolve(__dirname, '..');
const WWW_DIR = path.join(ROOT_DIR, 'www');
const DEFAULT_HOST = '127.0.0.1';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MOBILE_WINDOW_SIZE = '412,860';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createInitialMockData() {
  const now = Date.now();
  return {
    active: [
      {
        id: 'preview-alarm-1',
        notificationIndex: 'preview-alarm-1',
        whenMs: now + 2 * 60 * 60 * 1000,
        timeText: '07:00',
        dayBadge: '明日',
        originalDate: '2026-11-16',
        originalTime: '07:00:00.000',
        deviceName: 'Echo Show',
        label: '起床アラーム',
        recurringText: '毎日',
        isSkipped: false,
        notification: { notificationIndex: 'preview-alarm-1', type: 'Alarm', status: 'ON' },
      },
      {
        id: 'preview-alarm-2',
        notificationIndex: 'preview-alarm-2',
        whenMs: now + 3.5 * 60 * 60 * 1000,
        timeText: '08:30',
        dayBadge: '明日',
        originalDate: '2026-11-16',
        originalTime: '08:30:00.000',
        deviceName: 'Echo Dot',
        label: '定例ミーティング',
        recurringText: '平日',
        isSkipped: false,
        notification: { notificationIndex: 'preview-alarm-2', type: 'Alarm', status: 'ON' },
      },
    ],
    skipped: [
      {
        id: 'preview-alarm-3',
        notificationIndex: 'preview-alarm-3',
        whenMs: now + 24 * 60 * 60 * 1000 - 30 * 60 * 1000,
        timeText: '06:30',
        dayBadge: '明後日',
        originalDate: '2026-11-17',
        originalTime: '06:30:00.000',
        deviceName: 'Echo Show',
        label: '早朝アラーム',
        recurringText: '毎日',
        isSkipped: true,
        notification: { notificationIndex: 'preview-alarm-3', type: 'Alarm', status: 'ON' },
      },
    ],
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function createMockApiHandler() {
  const data = createInitialMockData();

  function buildPayload() {
    const active = data.active.slice().sort((a, b) => a.whenMs - b.whenMs);
    const skipped = data.skipped.slice().sort((a, b) => a.whenMs - b.whenMs);
    const base = {
      ok: true,
      checkedAt: 'プレビュー (モック)',
      deviceCount: 2,
      active,
      skipped,
    };
    return {
      ...base,
      widgetSummary: buildWidgetSummary(base),
    };
  }

  return async function handleMockApi(req, res, reqPath) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (reqPath === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, mode: 'mock' });
      return;
    }

    if (reqPath === '/api/auth/status' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, status: 'ready', loginUrl: null, error: null });
      return;
    }

    if (reqPath === '/api/alarms' && req.method === 'GET') {
      sendJson(res, 200, buildPayload());
      return;
    }

    if (reqPath === '/api/widget/summary' && req.method === 'GET') {
      sendJson(res, 200, buildPayload().widgetSummary);
      return;
    }

    if (reqPath === '/api/alarms/skip' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const idx = data.active.findIndex((item) => item.id === body.id || item.notificationIndex === body.notificationIndex);
      if (idx >= 0) {
        const [item] = data.active.splice(idx, 1);
        data.skipped.push({ ...item, isSkipped: true });
      }
      sendJson(res, 200, buildPayload());
      return;
    }

    if (reqPath === '/api/alarms/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const idx = data.skipped.findIndex((item) => item.id === body.id || item.notificationIndex === body.notificationIndex);
      if (idx >= 0) {
        const [item] = data.skipped.splice(idx, 1);
        data.active.push({ ...item, isSkipped: false });
      }
      sendJson(res, 200, buildPayload());
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}

function renderWidgetPreviewHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ウィジェット実寸プレビュー (Xiaomi 14T Pro 想定)</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: #0b101b;
      color: #eef2f8;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    h1 { font-size: 16px; margin: 0 0 6px; }
    .note { font-size: 12px; color: #8f9bb3; margin: 0 0 18px; }
    .section-title { font-size: 13px; color: #38bdf8; margin: 16px 0 8px; font-weight: 700; }
    .grid { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
    .case { display: flex; flex-direction: column; gap: 6px; }
    .case-label { font-size: 11px; color: #94a3b8; }
    .widget-box {
      background: linear-gradient(145deg, #162033, #0f172a);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    }
    .w-1x1 {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 4px;
      text-align: center;
    }
    .w-2x1 {
      flex-direction: row;
      align-items: center;
      padding: 6px 8px;
    }
    .w-1x1-sm { width: 68px; height: 68px; }
    .w-1x1-md { width: 82px; height: 82px; }
    .w-2x1-sm { width: 148px; height: 68px; }
    .w-2x1-md { width: 176px; height: 82px; }
    .left-col {
      width: 44%;
      padding-right: 6px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
    }
    .right-col {
      width: 56%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
    }
    .line {
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.15;
    }
    .badge { color: #38bdf8; font-weight: 700; }
    .time { color: #eef2f8; font-weight: 700; }
    .device { color: #eef2f8; font-weight: 700; }
    .sub { color: #8f9bb3; margin-top: 2px; }
    .toolbar { margin-bottom: 14px; display: flex; gap: 10px; align-items: center; }
    .btn {
      background: #1e293b;
      color: #eef2f8;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    a.link { color: #38bdf8; font-size: 12px; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Android ウィジェット実寸プレビュー</h1>
  <p class="note">Xiaomi 14T Pro の高密度ホーム画面（1×1 / 2×1）における autoSizeTextType="uniform" 相当の縮小表示確認</p>
  <div class="toolbar">
    <button class="btn" id="reloadBtn">最新データ再読込</button>
    <a class="link" href="/">← スマホ版 UI に戻る</a>
  </div>

  <div class="section-title">1×1 サイズ（68×68px / 82×82px）</div>
  <div class="grid" id="grid1x1"></div>

  <div class="section-title">縦1×横2 サイズ（148×68px / 176×82px）</div>
  <div class="grid" id="grid2x1"></div>

  <script>
    function fitText(el, minPx, maxPx) {
      var size = maxPx;
      el.style.fontSize = size + 'px';
      while (size > minPx && el.scrollWidth > el.clientWidth) {
        size -= 1;
        el.style.fontSize = size + 'px';
      }
    }

    function renderWidgets(summary) {
      var hasAlarm = summary && summary.hasAlarm && summary.nextAlarm;
      var next = hasAlarm ? summary.nextAlarm : null;
      var remaining = summary ? (summary.remainingCount || 0) : 0;

      var timeText = next ? next.timeText : 'なし';
      var dayBadge = next ? (next.dayBadge || '次のアラーム') : '次のアラーム';
      var deviceName = next ? (next.deviceName || 'Echo') : '24時間以内の予定なし';
      var label = next ? (next.label || '') : '';
      var sub1x1 = next ? (remaining > 0 ? '+' + remaining + '件' : '24h以内') : '24h以内';
      var sub2x1 = next
        ? (label && remaining > 0 ? label + ' ・ ほか' + remaining + '件' : (label || (remaining > 0 ? 'ほか' + remaining + '件 (24h以内)' : '24h以内の予定')))
        : 'タップしてアプリを開く';

      var g1 = document.getElementById('grid1x1');
      g1.innerHTML = [
        { cls: 'w-1x1-sm', title: '1×1 狭小 (68×68px)' },
        { cls: 'w-1x1-md', title: '1×1 標準 (82×82px)' }
      ].map(function (item) {
        return '<div class="case"><span class="case-label">' + item.title + '</span>'
          + '<div class="widget-box w-1x1 ' + item.cls + '">'
          + '<div class="line badge fit-badge">' + dayBadge + '</div>'
          + '<div class="line time fit-time1">' + timeText + '</div>'
          + '<div class="line sub fit-sub">' + sub1x1 + '</div>'
          + '</div></div>';
      }).join('');

      var g2 = document.getElementById('grid2x1');
      g2.innerHTML = [
        { cls: 'w-2x1-sm', title: '2×1 狭小 (148×68px)' },
        { cls: 'w-2x1-md', title: '2×1 標準 (176×82px)' }
      ].map(function (item) {
        return '<div class="case"><span class="case-label">' + item.title + '</span>'
          + '<div class="widget-box w-2x1 ' + item.cls + '">'
          + '<div class="left-col">'
          + '<div class="line time fit-time2">' + timeText + '</div>'
          + '<div class="line badge fit-badge">' + dayBadge + '</div>'
          + '</div>'
          + '<div class="right-col">'
          + '<div class="line device fit-device">' + deviceName + '</div>'
          + '<div class="line sub fit-sub">' + sub2x1 + '</div>'
          + '</div>'
          + '</div></div>';
      }).join('');

      document.querySelectorAll('.fit-badge').forEach(function (el) { fitText(el, 7, 11); });
      document.querySelectorAll('.fit-time1').forEach(function (el) { fitText(el, 11, 20); });
      document.querySelectorAll('.fit-time2').forEach(function (el) { fitText(el, 12, 22); });
      document.querySelectorAll('.fit-device').forEach(function (el) { fitText(el, 8, 13); });
      document.querySelectorAll('.fit-sub').forEach(function (el) { fitText(el, 7, 11); });
    }

    async function load() {
      var res = await fetch('/api/widget/summary');
      var data = await res.json();
      renderWidgets(data);
    }

    document.getElementById('reloadBtn').addEventListener('click', load);
    load();
  </script>
</body>
</html>`;
}

function serveWwwFile(res, reqPath) {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(WWW_DIR, cleanRel);
  if (!resolved.startsWith(WWW_DIR) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

function createMobilePreviewServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port !== undefined
    ? options.port
    : (process.env.ALEXA_MOBILE_PREVIEW_PORT ? Number(process.env.ALEXA_MOBILE_PREVIEW_PORT) : 0);
  const useMock = options.mock !== undefined
    ? Boolean(options.mock)
    : (process.env.MOBILE_PREVIEW_MOCK === '1' || process.argv.includes('--mock'));
  const useFreshAuth = !useMock && (options.freshAuth !== undefined
    ? Boolean(options.freshAuth)
    : (process.env.MOBILE_PREVIEW_FRESH_AUTH === '1' || process.argv.includes('--fresh-auth')));

  let tempAuthDir = null;
  let cookieFile = options.cookieFile || path.join(ROOT_DIR, 'alexa-cookie.json');
  if (useFreshAuth) {
    tempAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-mobile-auth-test-'));
    cookieFile = path.join(tempAuthDir, 'alexa-cookie.json');
  }

  const mockHandler = useMock ? createMockApiHandler() : null;
  const liveMobileServer = useMock
    ? null
    : createMobileServer(
        options.AlexaRemoteClass
          ? { authManager: createAlexaAuthManager({ cookieFile, AlexaRemoteClass: options.AlexaRemoteClass }) }
          : { cookieFile }
      );

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];

    if (reqPath === '/widget-preview.html' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderWidgetPreviewHtml());
      return;
    }

    if (reqPath.startsWith('/api/')) {
      if (mockHandler) {
        mockHandler(req, res, reqPath).catch((err) => {
          sendJson(res, 500, { error: err.message });
        });
        return;
      }
      liveMobileServer.handleRequest(req, res);
      return;
    }

    serveWwwFile(res, reqPath);
  });

  function cleanupTempAuthDir() {
    if (!tempAuthDir) return;
    try {
      fs.rmSync(tempAuthDir, { recursive: true, force: true });
    } catch {}
    tempAuthDir = null;
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        const boundPort = addr && typeof addr === 'object' ? addr.port : port;
        resolve({
          port: boundPort,
          url: `http://${host}:${boundPort}`,
          widgetPreviewUrl: `http://${host}:${boundPort}/widget-preview.html`,
          mock: useMock,
          freshAuth: useFreshAuth,
          cookieFile: useMock ? null : cookieFile,
        });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      const finish = () => {
        cleanupTempAuthDir();
        resolve();
      };
      if (!server.listening) {
        finish();
        return;
      }
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close(() => finish());
    });
  }

  return {
    server,
    start,
    stop,
  };
}

function launchBrowserApp(url) {
  const browserPath = fs.existsSync(CHROME_PATH)
    ? CHROME_PATH
    : (fs.existsSync(EDGE_PATH) ? EDGE_PATH : null);
  if (!browserPath) {
    console.warn('[mobile-preview] Chrome/Edge executable not found; open URL manually:', url);
    return;
  }
  const child = spawn(browserPath, [`--app=${url}`, `--window-size=${MOBILE_WINDOW_SIZE}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

if (require.main === module) {
  const preview = createMobilePreviewServer();
  const handleShutdown = () => {
    preview.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', handleShutdown);
  process.once('SIGTERM', handleShutdown);

  preview.start().then((info) => {
    const modeLabel = info.mock
      ? '[MOCK モード]'
      : (info.freshAuth ? '[FRESH-AUTH 実験モード]' : '[LIVE]');
    console.log(`[mobile-preview] Mode:           ${modeLabel}`);
    console.log(`[mobile-preview] Mobile UI:      ${info.url}/`);
    console.log(`[mobile-preview] Widget Preview: ${info.widgetPreviewUrl}`);
    if (info.freshAuth && info.cookieFile) {
      console.log(`[mobile-preview] Temp Cookie:    ${info.cookieFile}`);
    }
    if (process.argv.includes('--app')) {
      launchBrowserApp(`${info.url}/`);
    }
  }).catch((err) => {
    console.error('[mobile-preview] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  createMobilePreviewServer,
};
