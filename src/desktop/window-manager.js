'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HEARTBEAT_CHECK_INTERVAL_MS = 1000;
const HEARTBEAT_INITIAL_TIMEOUT_MS = 20000;
const HEARTBEAT_STALE_TIMEOUT_MS = 60000;
const MAX_SHUTDOWN_DRAIN_MS = 30000;
const DRAIN_POLL_INTERVAL_MS = 100;
const DEFAULT_LOCK_FILE = path.join(os.tmpdir(), 'alexa-alarm-app.lock.json');
const DEFAULT_APP_WINDOW_WIDTH = 420;
const DEFAULT_APP_WINDOW_HEIGHT = 720;
const DEFAULT_WINDOW_LEFT = 80;
const DEFAULT_WINDOW_TOP = 80;
const MIN_VALID_COORDINATE = -10000;
const SESSION_FILE_PATTERN = /^(Apps|Tabs|Session)_/i;

function parsePositiveInt(raw, fallback) {
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function resolveAppWindowSize() {
  return {
    width: parsePositiveInt(process.env.ALEXA_WINDOW_WIDTH, DEFAULT_APP_WINDOW_WIDTH),
    height: parsePositiveInt(process.env.ALEXA_WINDOW_HEIGHT, DEFAULT_APP_WINDOW_HEIGHT),
  };
}

function isPlacementLeaf(obj) {
  return obj !== null
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && Number.isFinite(obj.left)
    && Number.isFinite(obj.top);
}

function collectPlacementLeaves(node, pathKeys, results) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, val] of Object.entries(node)) {
    const nextPath = pathKeys.concat(key);
    if (isPlacementLeaf(val)) {
      results.push({ path: nextPath.join('.'), value: val });
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      collectPlacementLeaves(val, nextPath, results);
    }
  }
}

function extractAppPlacementLeaf(node, pathKeys = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (isPlacementLeaf(node)) return node;
  const leaves = [];
  collectPlacementLeaves(node, pathKeys, leaves);
  if (leaves.length === 0) return null;
  const localHit = leaves.find((entry) => entry.path.includes('127'));
  return (localHit || leaves[0]).value;
}

function extractWorkArea(placement) {
  if (!placement || typeof placement !== 'object') return null;
  const { work_area_left, work_area_top, work_area_right, work_area_bottom } = placement;
  if (
    !Number.isFinite(work_area_left)
    || !Number.isFinite(work_area_top)
    || !Number.isFinite(work_area_right)
    || !Number.isFinite(work_area_bottom)
  ) {
    return null;
  }
  if (work_area_right <= work_area_left || work_area_bottom <= work_area_top) {
    return null;
  }
  return { work_area_left, work_area_top, work_area_right, work_area_bottom };
}

function clampWindowPosition(rawLeft, rawTop, width, height, workArea) {
  let left = Number.isFinite(rawLeft) && rawLeft >= MIN_VALID_COORDINATE ? rawLeft : DEFAULT_WINDOW_LEFT;
  let top = Number.isFinite(rawTop) && rawTop >= MIN_VALID_COORDINATE ? rawTop : DEFAULT_WINDOW_TOP;

  if (workArea) {
    const maxLeft = Math.max(workArea.work_area_left, workArea.work_area_right - width);
    const maxTop = Math.max(workArea.work_area_top, workArea.work_area_bottom - height);
    left = Math.round(Math.min(Math.max(left, workArea.work_area_left), maxLeft));
    top = Math.round(Math.min(Math.max(top, workArea.work_area_top), maxTop));
    return { left, top };
  }

  return { left: Math.round(left), top: Math.round(top) };
}

function clearChromeSessionFiles(userDataDir) {
  if (!userDataDir) return;
  const sessionsDir = path.join(userDataDir, 'Default', 'Sessions');
  if (!fs.existsSync(sessionsDir)) return;
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!SESSION_FILE_PATTERN.test(name)) continue;
    try {
      fs.rmSync(path.join(sessionsDir, name), { force: true });
    } catch {
      // ロック中のファイルがあっても他のセッション掃除を続行
    }
  }
}

function updateAllPlacementLeaves(node, normalizedPlacement) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  let count = 0;
  for (const [key, val] of Object.entries(node)) {
    if (isPlacementLeaf(val)) {
      node[key] = { ...val, ...normalizedPlacement };
      count += 1;
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      count += updateAllPlacementLeaves(val, normalizedPlacement);
    }
  }
  return count;
}

function resetChromeWindowPlacement(profileDir, width = DEFAULT_APP_WINDOW_WIDTH, height = DEFAULT_APP_WINDOW_HEIGHT) {
  const fallbackPos = { left: DEFAULT_WINDOW_LEFT, top: DEFAULT_WINDOW_TOP };
  if (!profileDir) return fallbackPos;
  clearChromeSessionFiles(profileDir);

  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return fallbackPos;

  let prefs;
  try {
    const raw = fs.readFileSync(prefsPath, 'utf8');
    prefs = JSON.parse(raw);
  } catch (err) {
    console.warn('[Window] Failed to reset Chrome window_placement:', err.message);
    return fallbackPos;
  }
  if (!prefs || typeof prefs !== 'object') return fallbackPos;

  if (!prefs.browser || typeof prefs.browser !== 'object') {
    prefs.browser = {};
  }

  const appLeaf = extractAppPlacementLeaf(prefs.browser.app_window_placement);
  const winLeaf = isPlacementLeaf(prefs.browser.window_placement) ? prefs.browser.window_placement : null;
  const sourcePlacement = appLeaf || winLeaf;
  const workArea = extractWorkArea(sourcePlacement);
  const { left, top } = clampWindowPosition(
    sourcePlacement ? sourcePlacement.left : undefined,
    sourcePlacement ? sourcePlacement.top : undefined,
    width,
    height,
    workArea
  );

  const normalizedPlacement = {
    ...(workArea || {}),
    left,
    top,
    right: left + width,
    bottom: top + height,
    maximized: false,
  };

  prefs.browser.window_placement = {
    ...(winLeaf || {}),
    ...normalizedPlacement,
  };

  const updatedLeaves = updateAllPlacementLeaves(prefs.browser.app_window_placement, normalizedPlacement);
  if (updatedLeaves === 0) {
    prefs.browser.app_window_placement = {
      127: { 0: { 0: { '1_/': { ...normalizedPlacement } } } },
    };
  }

  try {
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
  } catch (err) {
    console.warn('[Window] Failed to write Chrome window_placement:', err.message);
  }
  return { left, top };
}

function openExternalBrowser(url) {
  if (!url) return;
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
  childProcess.exec(cmd, (err) => {
    if (err) {
      console.error('[Auth] Failed to open login browser:', err.message);
    }
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function probeExistingInstance(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/heartbeat`, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
  });
}

function requestFocusExistingInstance(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/focus',
      method: 'POST',
      timeout: 1500,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.on('error', () => {
      resolve();
    });
    req.end();
  });
}

function focusAppWindow() {
  if (process.platform !== 'win32') return;
  const psScript = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Focus { [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'",
    "$procs = Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Alexa アラーム管理*' }",
    "foreach ($p in $procs) { [Win32Focus]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; [Win32Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }",
  ].join('; ');
  childProcess.execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    { windowsHide: true },
    (err) => {
      if (err) {
        console.warn('[Focus] Failed to focus Chrome window:', err.message);
      }
    }
  );
}

function closeHttpServer(srv) {
  return new Promise((resolve) => {
    if (!srv || !srv.listening) {
      resolve();
      return;
    }
    if (typeof srv.closeAllConnections === 'function') {
      srv.closeAllConnections();
    }
    srv.close(() => resolve());
  });
}

function createWindowManager(options = {}) {
  const lockFile = options.lockFile || DEFAULT_LOCK_FILE;
  const userDataDirOption = options.userDataDir || null;
  const execFn = typeof options.exec === 'function' ? options.exec : childProcess.exec;
  const getServers = typeof options.getServers === 'function' ? options.getServers : () => [];
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
  const hasPendingWork = typeof options.hasPendingWork === 'function' ? options.hasPendingWork : isBusy;

  let shuttingDown = false;
  let drainPromise = null;
  let appStartedAt = 0;
  let lastHeartbeatAt = 0;
  let hasHeartbeat = false;
  let heartbeatTimer = null;

  function writeSingleInstanceLock(port) {
    try {
      const data = {
        pid: process.pid,
        port,
        startedAt: Date.now(),
      };
      fs.writeFileSync(lockFile, JSON.stringify(data), 'utf8');
    } catch (err) {
      console.warn('[Lock] Failed to write lock file:', err.message);
    }
  }

  function releaseSingleInstanceLock() {
    try {
      if (!fs.existsSync(lockFile)) return;
      const raw = fs.readFileSync(lockFile, 'utf8');
      const lock = JSON.parse(raw);
      if (lock && lock.pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // ロックファイルが存在しない・破損している場合は無視
    }
  }

  async function acquireSingleInstanceLock() {
    if (!fs.existsSync(lockFile)) {
      return true;
    }
    let lock;
    try {
      const raw = fs.readFileSync(lockFile, 'utf8');
      lock = JSON.parse(raw);
    } catch {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
      return true;
    }

    if (!lock || !isPidAlive(lock.pid)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
      return true;
    }

    const alive = await probeExistingInstance(lock.port);
    if (!alive) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
      return true;
    }

    await requestFocusExistingInstance(lock.port);
    focusAppWindow();
    return false;
  }

  function waitForPendingWorkDrain() {
    if (!hasPendingWork()) {
      return Promise.resolve();
    }
    const deadline = Date.now() + MAX_SHUTDOWN_DRAIN_MS;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!hasPendingWork() || Date.now() >= deadline) {
          clearInterval(timer);
          resolve();
        }
      }, DRAIN_POLL_INTERVAL_MS);
    });
  }

  function shutdownServer(reason) {
    if (shuttingDown && drainPromise) {
      return drainPromise;
    }
    shuttingDown = true;
    releaseSingleInstanceLock();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reason) {
      console.log(`サーバーを終了します (${reason})...`);
    }

    drainPromise = waitForPendingWorkDrain().then(() => {
      const forceExitTimer = setTimeout(() => process.exit(0), 500);
      forceExitTimer.unref();
      const servers = getServers().filter(Boolean);
      return Promise.all(servers.map(closeHttpServer)).then(() => {
        process.exit(0);
      });
    });
    return drainPromise;
  }

  function recordHeartbeat() {
    hasHeartbeat = true;
    lastHeartbeatAt = Date.now();
  }

  function touchActivity() {
    lastHeartbeatAt = Date.now();
  }

  function startHeartbeatWatchdog() {
    appStartedAt = Date.now();
    lastHeartbeatAt = 0;
    hasHeartbeat = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    heartbeatTimer = setInterval(() => {
      if (isBusy()) {
        lastHeartbeatAt = Date.now();
        return;
      }
      const now = Date.now();
      if (!hasHeartbeat) {
        if (now - appStartedAt >= HEARTBEAT_INITIAL_TIMEOUT_MS) {
          shutdownServer('heartbeat-initial-timeout');
        }
        return;
      }
      if (now - lastHeartbeatAt >= HEARTBEAT_STALE_TIMEOUT_MS) {
        shutdownServer('heartbeat-lost');
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  function launchAppBrowser(port) {
    const userDataDir = userDataDirOption || path.join(os.homedir(), '.alexa-alarm-app-chrome');
    const { width, height } = resolveAppWindowSize();
    const { left, top } = resetChromeWindowPlacement(userDataDir, width, height);
    const appUrl = `http://127.0.0.1:${port}/`;
    const commonFlags = `--app=${appUrl} --user-data-dir="${userDataDir}" --new-window --window-position=${left},${top} --window-size=${width},${height} --no-first-run --no-default-browser-check --disable-session-crashed-bubble`;
    const cmd = process.platform === 'win32'
      ? `start "" chrome ${commonFlags}`
      : `google-chrome ${commonFlags}`;
    execFn(cmd, (err) => {
      if (err) {
        console.error('[Launch] Failed to start Chrome:', err.message);
      }
    });
    startHeartbeatWatchdog();
  }

  return {
    writeSingleInstanceLock,
    releaseSingleInstanceLock,
    acquireSingleInstanceLock,
    shutdownServer,
    startHeartbeatWatchdog,
    recordHeartbeat,
    touchActivity,
    launchAppBrowser,
  };
}

module.exports = {
  DEFAULT_APP_WINDOW_HEIGHT,
  DEFAULT_APP_WINDOW_WIDTH,
  DEFAULT_LOCK_FILE,
  HEARTBEAT_CHECK_INTERVAL_MS,
  HEARTBEAT_INITIAL_TIMEOUT_MS,
  HEARTBEAT_STALE_TIMEOUT_MS,
  MAX_SHUTDOWN_DRAIN_MS,
  clampWindowPosition,
  clearChromeSessionFiles,
  createWindowManager,
  extractAppPlacementLeaf,
  focusAppWindow,
  isPidAlive,
  openExternalBrowser,
  probeExistingInstance,
  requestFocusExistingInstance,
  resetChromeWindowPlacement,
  resolveAppWindowSize,
};
