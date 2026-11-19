'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

require('./proxy-patch').applyProxyPatch();

const LOOPBACK_HOST = '127.0.0.1';
const COOKIE_REFRESH_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000;

class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
    this.statusCode = 401;
  }
}

const TRANSIENT_ERROR_PATTERNS = [
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'socket hang up',
  '502',
  '503',
  '504',
];

const AUTH_ERROR_PATTERNS = [
  '401',
  'Unauthorized',
  'Cookie was set, but authentication invalid',
  'AUTH_REQUIRED',
  'ログイン情報がありません',
  'Cookie ファイルが読めません',
  'No cookie',
  "reading 'refreshToken'",
];

function isAuthError(errOrMessage) {
  if (!errOrMessage) return false;
  const isObj = typeof errOrMessage === 'object';
  const msg = typeof errOrMessage === 'string'
    ? errOrMessage
    : (errOrMessage.message ? String(errOrMessage.message) : String(errOrMessage));
  const code = isObj && errOrMessage.code ? String(errOrMessage.code) : '';
  const combined = `${code} ${msg}`;

  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => combined.includes(pattern))) {
    return false;
  }
  if (isObj && (errOrMessage.statusCode === 401 || errOrMessage.code === 'AUTH_REQUIRED')) {
    return true;
  }
  return AUTH_ERROR_PATTERNS.some((pattern) => combined.includes(pattern));
}

function getFreePort(preferredPort) {
  const numericPreferred = Number(preferredPort);
  if (preferredPort !== undefined && preferredPort !== null && preferredPort !== ''
    && Number.isInteger(numericPreferred) && numericPreferred > 0 && numericPreferred <= 65535) {
    return Promise.resolve(numericPreferred);
  }
  const envProxyPort = Number(process.env.ALEXA_PROXY_PORT);
  if (preferredPort === undefined && process.env.ALEXA_PROXY_PORT
    && Number.isInteger(envProxyPort) && envProxyPort > 0 && envProxyPort <= 65535) {
    return Promise.resolve(envProxyPort);
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, LOOPBACK_HOST, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

function resolveDefaultCookieFile() {
  return process.env.ALEXA_COOKIE_FILE
    ? path.resolve(process.env.ALEXA_COOKIE_FILE)
    : path.resolve(process.cwd(), 'alexa-cookie.json');
}

function resolveAlexaRemoteClass(customClass) {
  if (customClass) return customClass;
  // eslint-disable-next-line global-require
  return require('alexa-remote2');
}

function prepareCookieForAlexaRemote(cookieData) {
  if (!cookieData || typeof cookieData !== 'object') {
    return cookieData;
  }
  if (cookieData.refreshToken || cookieData.localCookie) {
    const copy = { ...cookieData };
    if (!copy.localCookie && typeof copy.cookie === 'string') {
      copy.localCookie = copy.cookie;
    }
    if (typeof copy.cookie === 'string') {
      delete copy.cookie;
    }
    return copy;
  }
  return cookieData;
}

/**
 * Creates an OS-independent Alexa authentication and connection manager.
 * @param {object} [options]
 */
function createAlexaAuthManager(options = {}) {
  const cookieFile = options.cookieFile
    ? path.resolve(options.cookieFile)
    : resolveDefaultCookieFile();
  const preferredProxyPort = options.proxyPort !== undefined
    ? options.proxyPort
    : (process.env.ALEXA_PROXY_PORT ? Number(process.env.ALEXA_PROXY_PORT) : undefined);
  const onLoginUrl = typeof options.onLoginUrl === 'function' ? options.onLoginUrl : null;
  const customAlexaClass = options.AlexaRemoteClass || null;

  let alexa = null;
  let alexaReady = null;
  let loadedCookieSignature = null;
  let activeLoginClient = null;
  let authState = {
    status: 'ready',
    loginUrl: null,
    error: null,
  };
  let loginPromise = null;
  let lastNotifiedLoginUrl = null;

  function notifyLoginUrl(loginUrl, force = false) {
    if (!loginUrl || !onLoginUrl) return;
    if (!force && lastNotifiedLoginUrl === loginUrl) return;
    lastNotifiedLoginUrl = loginUrl;
    onLoginUrl(loginUrl, { force: Boolean(force) });
  }

  function getCookieFile() {
    return cookieFile;
  }

  function loadSavedCookie() {
    if (!fs.existsSync(cookieFile)) return null;
    const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    if (raw && typeof raw === 'object' && (raw.localCookie || raw.refreshToken)) {
      return raw;
    }
    return raw.cookie || raw;
  }

  function backupCookieFile() {
    try {
      if (!fs.existsSync(cookieFile)) return false;
      fs.copyFileSync(cookieFile, `${cookieFile}.bak`);
      return true;
    } catch (e) {
      console.warn(`[Auth] Cookie バックアップに失敗しました: ${e.message}`);
      return false;
    }
  }

  function saveCookieData(client, cookie) {
    try {
      let data = (client && client.cookieData) || (typeof cookie === 'string' ? { cookie } : cookie);
      if (data && typeof data === 'object' && !data.refreshToken && !data.localCookie && fs.existsSync(cookieFile)) {
        try {
          const existing = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
          if (existing && typeof existing === 'object' && (existing.refreshToken || existing.localCookie)) {
            data = { ...existing, ...data };
          }
        } catch {}
      }
      fs.writeFileSync(cookieFile, JSON.stringify(data, null, 2));
      loadedCookieSignature = getCookieFileSignature();
    } catch (e) {
      console.error(`Cookie の保存に失敗しました: ${e.message}`);
    }
  }

  function cleanupClient(client) {
    if (client && typeof client.removeAllListeners === 'function') {
      client.removeAllListeners();
    }
  }

  function resetConnection() {
    const old = alexa;
    alexa = null;
    alexaReady = null;
    loadedCookieSignature = null;
    cleanupClient(old);
  }

  function getCookieFileSignature() {
    try {
      if (!fs.existsSync(cookieFile)) return null;
      const stat = fs.statSync(cookieFile);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  function normalizeAlexaError(err) {
    if (isAuthError(err)) {
      resetConnection();
      return err instanceof AuthRequiredError
        ? err
        : new AuthRequiredError(err && err.message ? err.message : String(err));
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  function getAuthState() {
    return { ...authState };
  }

  async function startProxyLogin({ notify = false, forceNotify = false } = {}) {
    if (authState.status === 'logging_in' && authState.loginUrl) {
      if (notify) {
        notifyLoginUrl(authState.loginUrl, forceNotify);
      }
      return getAuthState();
    }
    if (loginPromise) {
      const state = await loginPromise;
      if (notify && state.loginUrl) {
        notifyLoginUrl(state.loginUrl, forceNotify);
      }
      return state;
    }

    loginPromise = (async () => {
      backupCookieFile();
      resetConnection();
      lastNotifiedLoginUrl = null;
      authState = {
        status: 'logging_in',
        loginUrl: null,
        error: null,
      };

      let AlexaRemote;
      try {
        AlexaRemote = resolveAlexaRemoteClass(customAlexaClass);
      } catch (e) {
        authState = {
          status: 'login_required',
          loginUrl: null,
          error: 'alexa-remote2 が見つかりません。`npm install` を実行してください。',
        };
        loginPromise = null;
        return getAuthState();
      }

      let proxyPort;
      try {
        proxyPort = await getFreePort(preferredProxyPort);
      } catch (e) {
        authState = {
          status: 'login_required',
          loginUrl: null,
          error: `プロキシ用空きポートの取得に失敗しました: ${e.message}`,
        };
        loginPromise = null;
        return getAuthState();
      }

      return new Promise((resolve) => {
        let proxyReadySettled = false;
        const resolveOnce = () => {
          if (proxyReadySettled) return;
          proxyReadySettled = true;
          resolve(getAuthState());
        };

        cleanupClient(activeLoginClient);
        const loginClient = new AlexaRemote();
        activeLoginClient = loginClient;
        loginClient.on('cookie', (cookie) => {
          saveCookieData(loginClient, cookie);
        });
        loginClient.on('error', (err) => {
          console.error(`Alexa 接続エラー: ${err && err.message ? err.message : err}`);
        });

        const opts = {
          amazonPage: 'amazon.co.jp',
          baseAmazonPage: 'amazon.co.jp',
          acceptLanguage: 'ja-JP',
          amazonPageProxyLanguage: 'ja_JP',
          proxyLanguage: 'ja_JP',
          bluetooth: false,
          cookieRefreshInterval: COOKIE_REFRESH_INTERVAL_MS,
          proxyOwnIp: LOOPBACK_HOST,
          proxyListenBind: LOOPBACK_HOST,
          proxyPort,
          setupProxy: true,
          proxyOnly: true,
          logger: (msg) => {
            if (typeof msg !== 'string') return;
            if (msg.includes('EADDRINUSE')) {
              console.error(`ポート衝突エラー (EADDRINUSE): port=${proxyPort}`);
            }
          },
        };

        loginClient.init(opts, (err) => {
          if (!err) {
            alexa = loginClient;
            activeLoginClient = null;
            alexaReady = Promise.resolve(alexa);
            authState = {
              status: 'ready',
              loginUrl: null,
              error: null,
            };
            loginPromise = null;
            lastNotifiedLoginUrl = null;
            resolveOnce();
            return;
          }

          const msg = err && err.message ? err.message : String(err);
          if (msg.includes('Please open http://')) {
            const match = msg.match(/https?:\/\/[^\s/]+(?::\d+)?\/?/);
            const loginUrl = match ? match[0] : `http://${LOOPBACK_HOST}:${proxyPort}/`;
            authState = {
              status: 'logging_in',
              loginUrl,
              error: null,
            };
            if (notify) {
              notifyLoginUrl(loginUrl, forceNotify);
            }
            resolveOnce();
            return;
          }

          cleanupClient(loginClient);
          if (activeLoginClient === loginClient) {
            activeLoginClient = null;
          }
          authState = {
            status: 'login_required',
            loginUrl: null,
            error: msg,
          };
          loginPromise = null;
          resolveOnce();
        });
      });
    })();

    return loginPromise;
  }

  function connectAlexa() {
    if (authState.status === 'logging_in') {
      return Promise.reject(new AuthRequiredError('Amazon へのログイン完了を待機しています。'));
    }
    if (alexaReady) {
      const currentSig = getCookieFileSignature();
      if (currentSig && loadedCookieSignature && currentSig !== loadedCookieSignature) {
        resetConnection();
      } else {
        return alexaReady;
      }
    }
    alexaReady = new Promise((resolve, reject) => {
      let settled = false;
      const failOnce = (err) => {
        if (settled) return;
        settled = true;
        resetConnection();
        reject(err);
      };

      let AlexaRemote;
      try {
        AlexaRemote = resolveAlexaRemoteClass(customAlexaClass);
      } catch (e) {
        failOnce(new Error('alexa-remote2 が見つかりません。`npm install` を実行してください。'));
        return;
      }

      let savedCookie;
      try {
        savedCookie = loadSavedCookie();
      } catch (e) {
        failOnce(new AuthRequiredError(`Cookie ファイルが読めません (${cookieFile}): ${e.message}`));
        return;
      }
      if (!savedCookie) {
        failOnce(new AuthRequiredError('ログイン情報がありません。Amazon アカウントへのログインが必要です。'));
        return;
      }
      loadedCookieSignature = getCookieFileSignature();

      const client = new AlexaRemote();
      alexa = client;
      client.on('cookie', (cookie) => {
        saveCookieData(client, cookie);
      });
      client.on('error', (err) => {
        console.error(`Alexa 接続エラー: ${err && err.message ? err.message : err}`);
      });

      const opts = {
        amazonPage: 'amazon.co.jp',
        baseAmazonPage: 'amazon.co.jp',
        acceptLanguage: 'ja-JP',
        amazonPageProxyLanguage: 'ja_JP',
        proxyLanguage: 'ja_JP',
        bluetooth: false,
        cookie: prepareCookieForAlexaRemote(savedCookie),
        macDms: (savedCookie && savedCookie.macDms) || {},
        formerRegistrationData: (savedCookie && savedCookie.refreshToken) ? savedCookie : undefined,
        cookieRefreshInterval: COOKIE_REFRESH_INTERVAL_MS,
        logger: (msg) => {
          if (typeof msg !== 'string') return;
          if (msg.includes('401 Unauthorized') || msg.includes('Cookie was set, but authentication invalid')) {
            failOnce(new AuthRequiredError('保存済み Cookie が無効または期限切れです (401 Unauthorized)。'));
          }
        },
      };

      client.init(opts, (err) => {
        if (settled) return;
        if (err) {
          failOnce(normalizeAlexaError(err));
          return;
        }
        if (savedCookie && typeof savedCookie === 'object' && savedCookie.refreshToken && !client.cookieData) {
          client.cookieData = { ...savedCookie };
        }
        loadedCookieSignature = getCookieFileSignature();
        settled = true;
        authState = {
          status: 'ready',
          loginUrl: null,
          error: null,
        };
        resolve(client);
      });
    });
    return alexaReady;
  }

  async function runWithAuthRetry(operation) {
    try {
      return await operation();
    } catch (err) {
      if (!isAuthError(err) || authState.status === 'logging_in') {
        throw err;
      }
      let diskCookie = null;
      try {
        diskCookie = loadSavedCookie();
      } catch {
        diskCookie = null;
      }
      if (!diskCookie) {
        throw err;
      }
      resetConnection();
      return operation();
    }
  }

  return {
    getCookieFile,
    loadSavedCookie,
    backupCookieFile,
    saveCookieData,
    normalizeAlexaError,
    getAuthState,
    startProxyLogin,
    connectAlexa,
    resetConnection,
    runWithAuthRetry,
  };
}

module.exports = {
  AUTH_ERROR_PATTERNS,
  AuthRequiredError,
  TRANSIENT_ERROR_PATTERNS,
  createAlexaAuthManager,
  getFreePort,
  isAuthError,
  prepareCookieForAlexaRemote,
};
