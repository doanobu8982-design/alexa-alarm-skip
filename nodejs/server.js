'use strict';

const http = require('http');
const path = require('path');

function requireCore(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(path.join(__dirname, 'src', 'core', name));
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(path.join(__dirname, '..', 'src', 'core', name));
    }
    throw e;
  }
}

requireCore('proxy-patch').applyProxyPatch();

const { createAlexaAuthManager, isAuthError } = requireCore('alexa-auth');
const { buildWidgetSummary, createAlarmService } = requireCore('alarm-service');

const MAX_BODY_BYTES = 1024 * 1024;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('リクエストボディが大きすぎます。'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`JSON の解析に失敗しました: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(data));
}

function createMobileServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port !== undefined ? options.port : 0;
  const authManager = options.authManager || createAlexaAuthManager({
    cookieFile: options.cookieFile,
  });
  const alarmService = options.alarmService || createAlarmService(authManager);

  async function runApiRoute(res, handler) {
    try {
      const data = await handler();
      if (!res.headersSent) {
        sendJson(res, 200, data);
      }
    } catch (err) {
      console.error('[MobileAPI Error]', err && err.stack ? err.stack : err);
      if (!res.headersSent) {
        if (isAuthError(err)) {
          try {
            await authManager.startProxyLogin({ notify: false });
          } catch (loginErr) {
            console.error('[MobileAuth] Failed to start proxy login:', loginErr && loginErr.stack ? loginErr.stack : loginErr);
          }
          const authState = authManager.getAuthState();
          sendJson(res, 401, {
            error: err && err.message ? err.message : String(err),
            needsLogin: true,
            status: authState.status,
            loginUrl: authState.loginUrl,
          });
          return;
        }
        sendJson(res, 500, {
          error: err && err.message ? err.message : String(err),
          needsLogin: false,
        });
      }
    }
  }

  function handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    try {
      const reqPath = (req.url || '/').split('?')[0];

      if (reqPath === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (reqPath === '/api/auth/status' && req.method === 'GET') {
        const authState = authManager.getAuthState();
        sendJson(res, 200, {
          ok: true,
          status: authState.status,
          loginUrl: authState.loginUrl,
          error: authState.error,
        });
        return;
      }

      if (reqPath === '/api/auth/login' && req.method === 'POST') {
        runApiRoute(res, async () => {
          await authManager.startProxyLogin({ notify: false });
          const authState = authManager.getAuthState();
          return {
            ok: true,
            status: authState.status,
            loginUrl: authState.loginUrl,
            error: authState.error,
          };
        });
        return;
      }

      if (reqPath === '/api/alarms' && req.method === 'GET') {
        runApiRoute(res, async () => {
          const payload = await alarmService.buildAlarmsPayload();
          return {
            ...payload,
            widgetSummary: buildWidgetSummary(payload),
          };
        });
        return;
      }

      if (reqPath === '/api/alarms/skip' && req.method === 'POST') {
        runApiRoute(res, async () => {
          const body = await readJsonBody(req);
          const result = await alarmService.skipAlarm(body);
          return {
            ...result,
            widgetSummary: buildWidgetSummary(result),
          };
        });
        return;
      }

      if (reqPath === '/api/alarms/restore' && req.method === 'POST') {
        runApiRoute(res, async () => {
          const body = await readJsonBody(req);
          const result = await alarmService.restoreAlarm(body);
          return {
            ...result,
            widgetSummary: buildWidgetSummary(result),
          };
        });
        return;
      }

      if (reqPath === '/api/widget/summary' && req.method === 'GET') {
        runApiRoute(res, () => alarmService.getWidgetSummary());
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[MobileRequest Error]', err && err.stack ? err.stack : err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
      }
    }
  }

  const server = http.createServer(handleRequest);

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        resolve({
          port: addr && typeof addr === 'object' ? addr.port : port,
          cookieFile: authManager.getCookieFile(),
        });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close(() => resolve());
    });
  }

  return {
    server,
    authManager,
    alarmService,
    handleRequest,
    start,
    stop,
  };
}

module.exports = {
  CORS_HEADERS,
  createMobileServer,
};
