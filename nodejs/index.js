'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const bridge = require('bridge');
const { channel } = bridge;
const { createMobileServer } = require('./server');

const FALLBACK_DELAY_MS = 1500;
let startPromise = null;
let serverInfo = null;

function resolveDataDir(explicitDir) {
  if (explicitDir && typeof explicitDir === 'string' && explicitDir.trim()) {
    return explicitDir.trim();
  }
  const datadirFn = (bridge.app && typeof bridge.app.datadir === 'function')
    ? () => bridge.app.datadir()
    : (typeof bridge.datadir === 'function' ? () => bridge.datadir() : null);
  if (datadirFn) {
    try {
      const appDataDir = datadirFn();
      if (appDataDir && typeof appDataDir === 'string' && appDataDir.trim()) {
        return appDataDir.trim();
      }
    } catch {
      // Fallback to os.homedir()
    }
  }
  return os.homedir();
}

function postToWebView(eventName, payload) {
  if (typeof channel.post === 'function') {
    channel.post(eventName, payload);
    return;
  }
  channel.send(eventName, payload);
}

async function startOnce(dataDir) {
  if (serverInfo) {
    postToWebView('serverReady', serverInfo);
    return serverInfo;
  }
  if (startPromise) {
    return startPromise.then((info) => {
      postToWebView('serverReady', info);
      return info;
    });
  }

  startPromise = (async () => {
    try {
      const targetDir = resolveDataDir(dataDir);
      fs.mkdirSync(targetDir, { recursive: true });
      const cookieFile = path.join(targetDir, 'alexa-cookie.json');

      const mobileServer = createMobileServer({ cookieFile });
      const info = await mobileServer.start();
      serverInfo = {
        port: info.port,
        cookieFile: info.cookieFile,
      };
      postToWebView('serverReady', serverInfo);
      return serverInfo;
    } catch (err) {
      startPromise = null;
      const errMsg = err && err.message ? err.message : String(err);
      postToWebView('serverError', { message: errMsg });
      throw err;
    }
  })();

  return startPromise;
}

channel.addListener('initServer', (payload) => {
  const dataDir = payload && payload.dataDir ? payload.dataDir : '';
  startOnce(dataDir).catch((err) => {
    console.error('[NodeJS] Failed to start mobile server:', err && err.stack ? err.stack : err);
  });
});

channel.addListener('getServerInfo', (payload) => {
  const dataDir = payload && payload.dataDir ? payload.dataDir : '';
  startOnce(dataDir).catch((err) => {
    console.error('[NodeJS] Failed to get server info:', err && err.stack ? err.stack : err);
  });
});

const fallbackTimer = setTimeout(() => {
  if (!startPromise) {
    startOnce('').catch((err) => {
      console.error('[NodeJS] Fallback start failed:', err && err.stack ? err.stack : err);
    });
  }
}, FALLBACK_DELAY_MS);
fallbackTimer.unref();
