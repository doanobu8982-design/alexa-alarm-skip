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
    const userDataDir = path.join(os.homedir(), '.alexa-alarm-app-chrome');
    const appUrl = `http://127.0.0.1:${port}/`;
    const cmd = `start "" chrome --app=${appUrl} --user-data-dir="${userDataDir}" --new-window --window-size=440,660 --no-first-run --no-default-browser-check`;
    childProcess.exec(cmd, (err) => {
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
  DEFAULT_LOCK_FILE,
  HEARTBEAT_CHECK_INTERVAL_MS,
  HEARTBEAT_INITIAL_TIMEOUT_MS,
  HEARTBEAT_STALE_TIMEOUT_MS,
  MAX_SHUTDOWN_DRAIN_MS,
  createWindowManager,
  focusAppWindow,
  isPidAlive,
  openExternalBrowser,
  probeExistingInstance,
  requestFocusExistingInstance,
};
