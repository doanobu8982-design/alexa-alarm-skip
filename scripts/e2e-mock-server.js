'use strict';

const http = require('node:http');
const { buildWidgetSummary } = require('../src/core/alarm-service');

const PORT = Number(process.env.E2E_MOCK_PORT || 3456);
const HOST = process.env.E2E_MOCK_HOST || '127.0.0.1';
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

function formatJstParts(ms) {
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  return {
    dateText: `${mm}/${dd}`,
    timeText: `${hh}:${min}`,
    originalDate: `${yyyy}-${mm}-${dd}`,
    originalTime: `${hh}:${min}:00.000`
  };
}

function createSeededAlarms() {
  const now = Date.now();
  const t1 = now + 2 * 60 * 60 * 1000;
  const t2 = now + 5 * 60 * 60 * 1000;
  const tOutOf24h = now + 30 * 60 * 60 * 1000;

  const p1 = formatJstParts(t1);
  const p2 = formatJstParts(t2);
  const p3 = formatJstParts(tOutOf24h);

  return [
    {
      id: 'mock-alarm-1',
      notificationIndex: 0,
      whenMs: t1,
      timeText: p1.timeText,
      dateText: p1.dateText,
      originalDate: p1.originalDate,
      originalTime: p1.originalTime,
      deviceName: 'Echo Show 5 (テスト)',
      label: '起床アラーム',
      recurrenceText: '毎日',
      isSkipped: false,
      notification: { id: 'mock-alarm-1', type: 'Alarm', status: 'ON' }
    },
    {
      id: 'mock-alarm-2',
      notificationIndex: 1,
      whenMs: t2,
      timeText: p2.timeText,
      dateText: p2.dateText,
      originalDate: p2.originalDate,
      originalTime: p2.originalTime,
      deviceName: 'Echo Dot (テスト)',
      label: '会議リマインド',
      recurrenceText: '平日',
      isSkipped: false,
      notification: { id: 'mock-alarm-2', type: 'Alarm', status: 'ON' }
    },
    {
      id: 'mock-alarm-30h',
      notificationIndex: 2,
      whenMs: tOutOf24h,
      timeText: p3.timeText,
      dateText: p3.dateText,
      originalDate: p3.originalDate,
      originalTime: p3.originalTime,
      deviceName: 'Echo Show 5 (テスト)',
      label: '24時間以降アラーム',
      recurrenceText: '毎日',
      isSkipped: false,
      notification: { id: 'mock-alarm-30h', type: 'Alarm', status: 'ON' }
    }
  ];
}

const state = {
  mode: 'seeded',
  authenticated: true,
  active: createSeededAlarms(),
  skipped: []
};

function resetState(mode) {
  const normalized = mode || 'seeded';
  state.mode = normalized;
  if (normalized === 'unauthenticated') {
    state.authenticated = false;
    state.active = createSeededAlarms();
    state.skipped = [];
    return;
  }
  if (normalized === 'empty') {
    state.authenticated = true;
    state.active = [];
    state.skipped = [];
    return;
  }
  state.authenticated = true;
  state.active = createSeededAlarms();
  state.skipped = [];
}

function getLoginUrl() {
  return `http://${HOST}:${PORT}/__test/mock-login`;
}

function getPayload() {
  const now = Date.now();
  const cutoff = now + WINDOW_24H_MS;
  const activeWithin24h = state.active
    .filter((item) => item.whenMs <= cutoff)
    .sort((a, b) => a.whenMs - b.whenMs);
  const skippedSorted = state.skipped
    .slice()
    .sort((a, b) => a.whenMs - b.whenMs);

  const nowParts = formatJstParts(now);
  const basePayload = {
    checkedAt: `${nowParts.dateText} ${nowParts.timeText}`,
    deviceCount: 2,
    active: activeWithin24h,
    skipped: skippedSorted
  };

  return {
    ...basePayload,
    widgetSummary: buildWidgetSummary(basePayload)
  };
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, body) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = reqUrl.pathname;

  try {
    if (req.method === 'POST' && pathname === '/__test/reset') {
      const body = await readJsonBody(req);
      resetState(body.mode);
      sendJson(res, 200, { ok: true, mode: state.mode, authenticated: state.authenticated });
      return;
    }

    if (req.method === 'GET' && pathname === '/__test/mock-login') {
      state.authenticated = true;
      setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>Mock Login</title><body style="font-family:sans-serif;padding:24px;"><h2>Mock Amazon Login Completed</h2><p>アプリに戻ってください。</p></body></html>');
      return;
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      sendJson(res, 200, {
        status: state.authenticated ? 'ready' : 'login_required',
        loginUrl: getLoginUrl()
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      sendJson(res, 200, {
        ok: true,
        status: state.authenticated ? 'ready' : 'login_required',
        loginUrl: getLoginUrl()
      });
      return;
    }

    if (!state.authenticated && pathname.startsWith('/api/')) {
      sendJson(res, 401, {
        error: 'Amazon へのログインが必要です',
        needsLogin: true,
        status: 'login_required',
        loginUrl: getLoginUrl()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/alarms') {
      sendJson(res, 200, getPayload());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/alarms/skip') {
      const body = await readJsonBody(req);
      const idx = state.active.findIndex((item) => item.id === body.id);
      if (idx >= 0) {
        const [item] = state.active.splice(idx, 1);
        state.skipped.push({ ...item, isSkipped: true });
      }
      sendJson(res, 200, getPayload());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/alarms/restore') {
      const body = await readJsonBody(req);
      const idx = state.skipped.findIndex((item) => item.id === body.id);
      if (idx >= 0) {
        const [item] = state.skipped.splice(idx, 1);
        state.active.push({ ...item, isSkipped: false });
      }
      sendJson(res, 200, getPayload());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/alarms/restore-all') {
      while (state.skipped.length > 0) {
        const item = state.skipped.shift();
        state.active.push({ ...item, isSkipped: false });
      }
      sendJson(res, 200, getPayload());
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e-mock-server] Listening on http://${HOST}:${PORT}`);
});
