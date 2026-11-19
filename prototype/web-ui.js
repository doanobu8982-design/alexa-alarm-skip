#!/usr/bin/env node
/**
 * web-ui.js — 全 Echo デバイス対応 アラーム管理＆スキップ・復活 Web アプリ。
 *
 * 機能:
 * - 直近24時間以内に鳴動する全 Echo デバイスの ON アラームを昇順タイムライン表示
 * - 個別スキップ＆最上段ボタン連続クリックによる連続スキップ
 * - スキップ済みアラームの「元に戻す」（OFF -> 500ms待機 -> ON トグル再スケジュール）
 *
 * 環境変数:
 *   ALEXA_COOKIE_FILE  Cookie JSON のパス（既定: ./alexa-cookie.json）
 *   ALEXA_WEB_PORT     待ち受けポート番号（既定: 0 = OS 空きポート自動割当）
 */
'use strict';

require('../src/core/proxy-patch').applyProxyPatch();

const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  buildV2Recurrence,
  computeExpectedNextMs,
  formatRecurring,
  formatTimeParts,
  getRecurrenceRule,
  nextTriggerMs,
  resolveRestoreDateTime,
} = require('../src/core/alarm-time');
const {
  AuthRequiredError,
  createAlexaAuthManager,
  getFreePort,
  isAuthError,
} = require('../src/core/alexa-auth');
const {
  buildWidgetSummary,
  classifyNotifications,
  createAlarmService,
} = require('../src/core/alarm-service');
const {
  HEARTBEAT_STALE_TIMEOUT_MS,
  createWindowManager,
  focusAppWindow,
  openExternalBrowser,
} = require('../src/desktop/window-manager');

const APP_MODE = process.argv.includes('--app');
const DESKTOP_HOST_MODE = process.argv.includes('--desktop-host');
const DESKTOP_HOST_READY_PREFIX = '__ALEXA_HOST_READY__ ';
const ENV_WEB_PORT = Number(process.env.ALEXA_WEB_PORT);
const DEFAULT_PORT = process.env.ALEXA_WEB_PORT && Number.isInteger(ENV_WEB_PORT) && ENV_WEB_PORT >= 0
  ? ENV_WEB_PORT
  : 0;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const ICON_DIR = path.join(__dirname, '..', 'assets', 'icons');
const FAVICON_ICO_PATH = path.join(ICON_DIR, 'app.ico');
const ICON_32_PATH = path.join(ICON_DIR, 'app-32.png');
const ICON_48_PATH = path.join(ICON_DIR, 'app-48.png');
const ICON_192_PATH = path.join(ICON_DIR, 'app-192.png');
const ICON_256_PATH = path.join(ICON_DIR, 'app-256.png');
const SPINNER_SVG_PATH = path.join(__dirname, '..', 'www', 'assets', 'spinner-90-ring.svg');
const SPINNER_90_RING_SVG = fs.readFileSync(SPINNER_SVG_PATH, 'utf8').trim();
const STATIC_ICON_ROUTES = {
  '/favicon.ico': { filePath: FAVICON_ICO_PATH, contentType: 'image/x-icon' },
  '/icon-32.png': { filePath: ICON_32_PATH, contentType: 'image/png' },
  '/icon-48.png': { filePath: ICON_48_PATH, contentType: 'image/png' },
  '/icon-192.png': { filePath: ICON_192_PATH, contentType: 'image/png' },
  '/icon-256.png': { filePath: ICON_256_PATH, contentType: 'image/png' },
};
const WEB_MANIFEST = JSON.stringify({
  name: 'Alexa アラーム管理',
  short_name: 'Alexaアラーム',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: '/icon-48.png', sizes: '48x48', type: 'image/png', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
  ],
});

const authManager = createAlexaAuthManager({
  onLoginUrl: (loginUrl) => {
    openExternalBrowser(loginUrl);
  },
});
const alarmService = createAlarmService(authManager);

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
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const PAGE = `<!DOCTYPE html>
<html lang="ja" data-desktop-host="${DESKTOP_HOST_MODE ? '1' : '0'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alexa アラーム管理</title>
<link rel="icon" type="image/png" sizes="256x256" href="/icon-256.png">
<link rel="icon" type="image/png" sizes="48x48" href="/icon-48.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root {
    --bg: #0b0f17;
    --surface: rgba(30, 41, 59, 0.72);
    --surface-hover: rgba(30, 41, 59, 0.92);
    --border: rgba(148, 163, 184, 0.16);
    --text: #eef2f8;
    --muted: #8f9bb3;
    --accent: #38bdf8;
    --danger: #ef4444;
    --danger-hover: #dc2626;
    --restore: #10b981;
    --restore-hover: #059669;
  }
  * { box-sizing: border-box; }
  button:focus,
  [tabindex]:focus {
    outline: none;
  }
  button:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid rgba(56, 189, 248, 0.55);
    outline-offset: 2px;
  }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: "Segoe UI", "Yu Gothic UI", "Meiryo", sans-serif;
    font-size: 13px;
    line-height: 1.4;
  }
  .app {
    width: 100%;
    max-width: 420px;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    margin: 0 auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header, .tabs, .skipped-actions, .status-bar {
    flex-shrink: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .title-wrap {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  h1 {
    font-size: 16px;
    font-weight: 700;
    margin: 0;
    letter-spacing: 0.02em;
  }
  .subtitle {
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
  }
  .btn-icon {
    background: rgba(30, 41, 59, 0.85);
    color: var(--text);
    border: none;
    border-radius: 12px;
    width: 36px;
    height: 36px;
    font-size: 15px;
    cursor: pointer;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease;
  }
  .btn-icon:hover:not(:disabled) { background: rgba(51, 65, 85, 0.95); }
  .btn-icon:disabled { opacity: 0.5; cursor: not-allowed; }
  .icon {
    display: block;
    flex-shrink: 0;
  }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    scrollbar-gutter: stable;
    overscroll-behavior-y: contain;
    -webkit-overflow-scrolling: touch;
    padding-right: 2px;
  }
  .list::-webkit-scrollbar {
    width: 5px;
  }
  .list::-webkit-scrollbar-track {
    background: transparent;
  }
  .list::-webkit-scrollbar-thumb {
    background: rgba(148, 163, 184, 0.38);
    border-radius: 999px;
  }
  .list::-webkit-scrollbar-thumb:hover {
    background: rgba(148, 163, 184, 0.58);
  }
  .date-divider {
    min-height: 32px;
    padding: 6px 4px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: #94a3b8;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    user-select: none;
    pointer-events: none;
  }
  .date-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(148, 163, 184, 0.22);
  }
  .date-divider:not(:first-child) {
    margin-top: 4px;
  }
  .empty-group {
    min-height: 38px;
    padding: 9px 10px;
    border: none;
    border-radius: 14px;
    background: rgba(30, 41, 59, 0.42);
    color: var(--muted, #94a3b8);
    font-size: 11px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    user-select: none;
    pointer-events: none;
  }
  .row {
    flex-shrink: 0;
    background: rgba(30, 41, 59, 0.85);
    border: none;
    border-radius: 14px;
    padding: 9px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .top-line {
    display: flex;
    align-items: baseline;
    gap: 7px;
    flex-wrap: wrap;
  }
  .time {
    font-size: 20px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
  .day-tag {
    font-size: 11px;
    color: var(--accent);
    font-weight: 600;
  }
  .alarm-label {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 150px;
  }
  .meta-line {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .device-badge {
    font-size: 11px;
    background: rgba(56, 189, 248, 0.14);
    color: #7dd3fc;
    border: 1px solid rgba(56, 189, 248, 0.28);
    padding: 1px 7px;
    border-radius: 999px;
    max-width: 165px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recur {
    font-size: 11px;
    color: var(--muted);
  }
  .btn-skip, .btn-restore {
    border: none;
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    flex-shrink: 0;
    min-width: 86px;
    text-align: center;
  }
  .btn-skip { background: var(--danger); }
  .btn-skip:hover:not(:disabled) { background: var(--danger-hover); }
  .btn-restore { background: var(--restore); }
  .btn-restore:hover:not(:disabled) { background: var(--restore-hover); }
  .btn-skip:disabled, .btn-restore:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .empty {
    background: var(--surface);
    border: 1px dashed var(--border);
    border-radius: 10px;
    padding: 14px 10px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
  }
  .tabs {
    display: flex;
    gap: 0;
    background: transparent;
    padding: 0;
    border-radius: 0;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  }
  .tab-btn {
    position: relative;
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: transparent;
    color: var(--muted);
    border: none;
    border-radius: 0;
    padding: 10px 8px 11px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    text-align: center;
    transition: color 0.12s ease;
  }
  .tab-btn > span {
    display: inline-flex;
    align-items: center;
    line-height: 1;
  }
  .tab-btn:hover { background: transparent; color: var(--text); }
  .tab-btn.active {
    background: transparent;
    color: #38bdf8;
    font-weight: 700;
    box-shadow: none;
  }
  .tab-btn.active::after {
    content: '';
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 0;
    height: 3px;
    border-radius: 3px 3px 0 0;
    background: #38bdf8;
  }
  .tab-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }
  .tab-panel[hidden] {
    display: none;
  }
  .skipped-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }
  .btn-restore-all {
    width: 100%;
    background: rgba(16, 185, 129, 0.18);
    color: #6ee7b7;
    border: none;
    border-radius: 12px;
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    text-align: center;
    transition: background 0.12s ease;
  }
  .btn-restore-all:hover:not(:disabled) {
    background: rgba(16, 185, 129, 0.28);
  }
  .btn-restore-all:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .row-skipped {
    background: rgba(30, 41, 59, 0.48);
    border: none;
  }
  .row-skipped .time {
    font-size: 16px;
    color: var(--muted);
    text-decoration: line-through;
  }
  .status-bar {
    display: block;
    box-sizing: border-box;
    flex-shrink: 0;
    margin-top: auto;
    padding-top: 6px;
    height: 22px;
    min-height: 22px;
    line-height: 16px;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid rgba(148, 163, 184, 0.14);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-bar.error { color: #fca5a5; }
  .login-panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-panel[hidden] {
    display: none;
  }
  .login-card {
    width: 100%;
    background: var(--surface);
    border: 1px solid rgba(56, 189, 248, 0.35);
    border-radius: 12px;
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    text-align: center;
  }
  .login-card h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--text);
  }
  .login-desc {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .btn-login {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--accent);
    color: #0b1120;
    border: none;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }
  .btn-login > span {
    display: inline-flex;
    align-items: center;
    line-height: 1;
  }
  .btn-login:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .btn-login:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .login-wait {
    font-size: 11px;
    color: var(--muted);
  }
  .loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(14, 17, 23, 0.72);
    backdrop-filter: blur(2px);
  }
  .loading-overlay.hidden {
    display: none;
  }
  .loading-overlay svg {
    width: 44px;
    height: 44px;
    color: #60a5fa;
  }
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="title-wrap">
      <h1>Alexa アラーム管理</h1>
      <div class="subtitle" id="metaText">読み込み中...</div>
    </div>
    <button class="btn-icon" id="refreshBtn" title="一覧を更新" aria-label="一覧を更新"><svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>
  </header>

  <section class="login-panel" id="loginPanel" hidden>
    <div class="login-card">
      <h2>Amazon への再ログインが必要です</h2>
      <p class="login-desc">セッションの有効期限が切れているか、未ログイン状態です。開いたログイン画面で Amazon アカウントにログインしてください。</p>
      <button class="btn-login" id="openLoginBtn" type="button"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg><span>Amazon ログイン画面を開く</span></button>
      <div class="login-wait" id="loginWaitText">ログイン完了を待機しています...（完了すると自動で一覧に戻ります）</div>
    </div>
  </section>

  <nav class="tabs" id="tabsNav" role="tablist" aria-label="表示切り替え">
    <button class="tab-btn active" id="tabActiveBtn" type="button" role="tab" aria-selected="true" data-tab="active"><svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span>直近のアラーム (<span id="countText">0</span>)</span></button>
    <button class="tab-btn" id="tabSkippedBtn" type="button" role="tab" aria-selected="false" data-tab="skipped"><svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg><span>スキップ済み (<span id="skippedCountText">0</span>)</span></button>
  </nav>

  <main class="tab-panel" id="panelActive" role="tabpanel">
    <div class="list" id="timelineList"></div>
  </main>

  <section class="tab-panel" id="panelSkipped" role="tabpanel" hidden>
    <div class="skipped-actions">
      <button class="btn-restore-all" id="restoreAllBtn" type="button">すべて元に戻す</button>
    </div>
    <div class="list" id="skippedList"></div>
  </section>

  <div class="status-bar" id="statusBar">準備中...</div>
</div>

<div id="loadingOverlay" class="loading-overlay hidden" aria-hidden="true" aria-busy="true">
  ${SPINNER_90_RING_SVG}
</div>

<script>
(function () {
  const DESKTOP_HOST_MODE = Boolean(
    typeof document !== 'undefined' &&
    document.documentElement &&
    document.documentElement.getAttribute &&
    document.documentElement.getAttribute('data-desktop-host') === '1'
  );
  var AUTO_REFRESH_INTERVAL_MS = 60000;
  var state = {
    activeTab: 'active',
    active: [],
    skipped: [],
    loading: false,
    todayGroupMeta: null,
    pendingCount: 0,
    hadMutationError: false,
    pendingSkips: {},
    pendingRestores: {},
    needsLogin: false,
    loginUrl: null,
    authPollTimer: null,
    autoRefreshTimer: null,
    mutationQueue: Promise.resolve()
  };

  function enqueueMutation(taskFn) {
    state.pendingCount += 1;
    var released = false;
    function releasePending() {
      if (released) return;
      released = true;
      state.pendingCount = Math.max(0, state.pendingCount - 1);
    }
    state.mutationQueue = state.mutationQueue
      .catch(function () {})
      .then(async function () {
        try {
          await taskFn(releasePending);
        } finally {
          releasePending();
        }
      });
    return state.mutationQueue;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(text, isError) {
    var el = document.getElementById('statusBar');
    el.textContent = text;
    el.title = text || '';
    el.className = isError ? 'status-bar error' : 'status-bar';
  }

  function setLoadingOverlay(visible) {
    var overlay = document.getElementById('loadingOverlay');
    if (!overlay || !overlay.classList) return;
    if (visible) {
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
    } else {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  function renderAlarmRow(item, idx, options) {
    var opts = typeof options === 'boolean' ? { isSkippedRow: options } : (options || {});
    var isSkippedRow = Boolean(opts.isSkippedRow);
    var hideDayTag = Boolean(opts.hideDayTag);
    var dayTagHtml = hideDayTag
      ? ''
      : '<span class="day-tag">' + escapeHtml(item.dayBadge || '') + '</span>';
    var labelHtml = item.label
      ? '<span class="alarm-label">' + escapeHtml(item.label) + '</span>'
      : '';
    var rowClass = isSkippedRow
      ? 'row row-skipped'
      : (idx === 0 ? 'row row-next' : 'row');
    var btnHtml = isSkippedRow
      ? '<button class="btn-restore" data-action="restore" data-idx="' + idx + '">元に戻す</button>'
      : '<button class="btn-skip" data-action="skip" data-idx="' + idx + '">スキップ</button>';

    return '<div class="' + rowClass + '">'
      + '<div class="info">'
      +   '<div class="top-line">'
      +     '<span class="time">' + escapeHtml(item.timeText) + '</span>'
      +     dayTagHtml
      +     labelHtml
      +   '</div>'
      +   '<div class="meta-line">'
      +     '<span class="device-badge" title="' + escapeHtml(item.deviceName) + '">' + escapeHtml(item.deviceName) + '</span>'
      +     '<span class="recur">' + escapeHtml(item.recurringText) + '</span>'
      +   '</div>'
      + '</div>'
      + btnHtml
      + '</div>';
  }

  function isTodayAlarmItem(item) {
    var text = String((item && (item.dateLabel || item.dayBadge)) || '');
    return text.indexOf('今日') === 0;
  }

  function renderActiveTimeline(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return '<div class="empty">直近のアラームはありません</div>';
    }
    var parts = [];
    var currentDateKey = null;

    var todayItem = items.find(isTodayAlarmItem);
    if (todayItem) {
      state.todayGroupMeta = {
        dateKey: todayItem.dateKey || todayItem.originalDate || '',
        dateLabel: todayItem.dateLabel || '今日'
      };
    } else if (state.todayGroupMeta && state.todayGroupMeta.dateLabel) {
      parts.push('<div class="date-divider" role="heading" aria-level="2">' + escapeHtml(state.todayGroupMeta.dateLabel) + '</div>');
      parts.push('<div class="empty-group">今日のアラームはありません</div>');
      currentDateKey = state.todayGroupMeta.dateKey || '__today_empty__';
    }

    items.forEach(function (item, idx) {
      var key = item.dateKey || item.originalDate || '';
      var headingText = item.dateLabel || item.dayBadge || key;
      if (key !== currentDateKey && headingText) {
        parts.push('<div class="date-divider" role="heading" aria-level="2">' + escapeHtml(headingText) + '</div>');
        currentDateKey = key;
      }
      parts.push(renderAlarmRow(item, idx, { hideDayTag: true }));
    });
    return parts.join('');
  }

  function render() {
    var refreshBtn = document.getElementById('refreshBtn');
    refreshBtn.disabled = state.loading;

    document.getElementById('countText').textContent = String(state.active.length);
    document.getElementById('skippedCountText').textContent = String(state.skipped.length);

    var loginPanel = document.getElementById('loginPanel');
    var tabsNav = document.getElementById('tabsNav');
    var panelActive = document.getElementById('panelActive');
    var panelSkipped = document.getElementById('panelSkipped');
    var isActiveTab = state.activeTab !== 'skipped';

    loginPanel.hidden = !state.needsLogin;
    tabsNav.hidden = state.needsLogin;

    var tabActiveBtn = document.getElementById('tabActiveBtn');
    var tabSkippedBtn = document.getElementById('tabSkippedBtn');
    tabActiveBtn.className = isActiveTab ? 'tab-btn active' : 'tab-btn';
    tabActiveBtn.setAttribute('aria-selected', isActiveTab ? 'true' : 'false');
    tabSkippedBtn.className = isActiveTab ? 'tab-btn' : 'tab-btn active';
    tabSkippedBtn.setAttribute('aria-selected', isActiveTab ? 'false' : 'true');

    panelActive.hidden = state.needsLogin || !isActiveTab;
    panelSkipped.hidden = state.needsLogin || isActiveTab;

    var openLoginBtn = document.getElementById('openLoginBtn');
    if (openLoginBtn) {
      openLoginBtn.disabled = false;
    }

    var restoreAllBtn = document.getElementById('restoreAllBtn');
    restoreAllBtn.disabled = state.skipped.length === 0;

    var timelineEl = document.getElementById('timelineList');
    timelineEl.innerHTML = renderActiveTimeline(state.active);

    var skippedEl = document.getElementById('skippedList');
    if (state.skipped.length === 0) {
      skippedEl.innerHTML = '<div class="empty">スキップ中のアラームはありません</div>';
    } else {
      skippedEl.innerHTML = state.skipped.map(function (item, idx) {
        return renderAlarmRow(item, idx, { isSkippedRow: true });
      }).join('');
    }
  }

  function switchTab(tabName) {
    state.activeTab = tabName === 'skipped' ? 'skipped' : 'active';
    render();
  }

  async function requestJson(url, options) {
    var res = await fetch(url, options);
    var data = await res.json();
    if (!res.ok) {
      var err = new Error(data.error || ('HTTP ' + res.status));
      if (res.status === 401 && data.needsLogin === true) {
        err.needsLogin = true;
        err.loginUrl = data.loginUrl || null;
        err.authStatus = data.status || 'login_required';
      } else {
        err.needsLogin = false;
      }
      throw err;
    }
    return data;
  }

  function stopAuthPolling() {
    if (state.authPollTimer) {
      clearInterval(state.authPollTimer);
      state.authPollTimer = null;
    }
  }

  function startAuthPolling() {
    if (state.authPollTimer) return;
    state.authPollTimer = setInterval(async function () {
      try {
        var auth = await requestJson('/api/auth/status');
        if (auth.loginUrl) {
          state.loginUrl = auth.loginUrl;
        }
        if (auth.status === 'ready') {
          stopAuthPolling();
          state.needsLogin = false;
          state.loginUrl = null;
          render();
          loadAlarms();
        }
      } catch {}
    }, 1500);
  }

  function enterLoginMode(loginUrl) {
    state.needsLogin = true;
    if (loginUrl) {
      state.loginUrl = loginUrl;
    }
    render();
    setStatus('Amazon への再ログインが必要です', true);
    startAuthPolling();
  }

  function sortByWhenMs(items) {
    return items.slice().sort(function (a, b) {
      return (a.whenMs || 0) - (b.whenMs || 0);
    });
  }

  function applyPayload(data) {
    var serverActive = Array.isArray(data.active) ? data.active : [];
    var serverSkipped = Array.isArray(data.skipped) ? data.skipped : [];

    var nextActive = serverActive.filter(function (item) {
      return !state.pendingSkips[item.id];
    });
    var skippedSeen = {};
    var nextSkipped = [];
    serverSkipped.forEach(function (item) {
      if (state.pendingRestores[item.id]) return;
      skippedSeen[item.id] = true;
      nextSkipped.push(item);
    });
    Object.keys(state.pendingSkips).forEach(function (id) {
      if (!skippedSeen[id] && !state.pendingRestores[id]) {
        nextSkipped.push(state.pendingSkips[id]);
      }
    });
    Object.keys(state.pendingRestores).forEach(function (id) {
      var restoringItem = state.pendingRestores[id];
      var exists = nextActive.some(function (a) { return a.id === id; });
      if (!exists && restoringItem) {
        nextActive.push(restoringItem);
      }
    });

    state.active = sortByWhenMs(nextActive);
    state.skipped = sortByWhenMs(nextSkipped);

    var todayItem = state.active.find(isTodayAlarmItem);
    if (todayItem) {
      state.todayGroupMeta = {
        dateKey: todayItem.dateKey || todayItem.originalDate || '',
        dateLabel: todayItem.dateLabel || '今日'
      };
    }

    var devCount = typeof data.deviceCount === 'number' ? data.deviceCount : 0;
    document.getElementById('metaText').textContent =
      '接続端末 ' + devCount + '台 / 更新 ' + (data.checkedAt || '');
  }

  function isBusyForAutoRefresh() {
    return Boolean(
      state.loading
      || state.needsLogin
      || state.pendingCount > 0
      || Object.keys(state.pendingSkips).length > 0
      || Object.keys(state.pendingRestores).length > 0
      || document.visibilityState === 'hidden'
    );
  }

  function stopAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (document.visibilityState === 'hidden') return;
    state.autoRefreshTimer = setInterval(function () {
      if (isBusyForAutoRefresh()) return;
      loadAlarms({ silent: true });
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  async function loadAlarms(options) {
    if (state.loading) return;
    var silent = Boolean(options && options.silent);
    var manual = Boolean(options && options.manual);
    if (manual && Object.keys(state.pendingSkips).length === 0) {
      state.todayGroupMeta = null;
    }
    state.loading = true;
    render();
    if (!silent) {
      setLoadingOverlay(true);
    }
    setStatus('アラーム一覧を取得中...', false);
    try {
      var data = await requestJson('/api/alarms');
      stopAuthPolling();
      state.needsLogin = false;
      state.loginUrl = null;
      applyPayload(data);
      setStatus('最新の一覧を表示しています', false);
    } catch (e) {
      if (e && e.needsLogin === true) {
        enterLoginMode(e.loginUrl);
      } else {
        setStatus('取得エラー: ' + e.message, true);
      }
    } finally {
      state.loading = false;
      setLoadingOverlay(false);
      render();
    }
  }

  async function syncFromServerAfterError() {
    if (state.pendingCount !== 0) return;
    try {
      var latest = await requestJson('/api/alarms');
      applyPayload(latest);
    } catch {}
  }

  function handleSkip(index) {
    var target = state.active[index];
    if (!target) return;

    if (isTodayAlarmItem(target)) {
      state.todayGroupMeta = {
        dateKey: target.dateKey || target.originalDate || '',
        dateLabel: target.dateLabel || '今日'
      };
    }

    if (state.pendingCount === 0) {
      state.hadMutationError = false;
    }

    var optimisticSkipped = Object.assign({}, target, { isSkipped: true });
    state.active = state.active.filter(function (_, i) { return i !== index; });
    state.pendingSkips[target.id] = optimisticSkipped;
    delete state.pendingRestores[target.id];
    state.skipped = sortByWhenMs(
      state.skipped.filter(function (s) { return s.id !== target.id; }).concat([optimisticSkipped])
    );
    render();
    setStatus(target.timeText + ' (' + target.deviceName + ') をスキップ中...', false);

    enqueueMutation(async function (releasePending) {
      try {
        var data = await requestJson('/api/alarms/skip', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: target.id,
            notificationIndex: target.notificationIndex,
            notification: target.notification
          })
        });
        delete state.pendingSkips[target.id];
        releasePending();
        applyPayload(data);
        render();
        if (state.pendingCount === 0 && !state.hadMutationError) {
          setStatus(target.timeText + ' の次回分をスキップしました', false);
        }
      } catch (e) {
        state.hadMutationError = true;
        delete state.pendingSkips[target.id];
        releasePending();
        if (e && e.needsLogin === true) {
          enterLoginMode(e.loginUrl);
          return;
        }
        setStatus('スキップエラー: ' + e.message, true);
        await syncFromServerAfterError();
        render();
      }
    });
  }

  function enqueueRestores(targets, doneMessage) {
    if (!Array.isArray(targets) || targets.length === 0) return;

    if (state.pendingCount === 0) {
      state.hadMutationError = false;
    }

    var removeIds = {};
    var addedActives = [];
    targets.forEach(function (target) {
      removeIds[target.id] = true;
      var optimisticActive = Object.assign({}, target, { isSkipped: false });
      state.pendingRestores[target.id] = optimisticActive;
      delete state.pendingSkips[target.id];
      addedActives.push(optimisticActive);
    });

    state.skipped = state.skipped.filter(function (s) { return !removeIds[s.id]; });
    state.active = sortByWhenMs(
      state.active.filter(function (a) { return !removeIds[a.id]; }).concat(addedActives)
    );
    render();

    if (targets.length === 1) {
      setStatus(targets[0].timeText + ' (' + targets[0].deviceName + ') を元に戻しています...', false);
    } else {
      setStatus(targets.length + '件のアラームを順次元に戻しています...', false);
    }

    targets.forEach(function (target) {
      enqueueMutation(async function (releasePending) {
        try {
          var data = await requestJson('/api/alarms/restore', {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: target.id,
              notificationIndex: target.notificationIndex,
              originalDate: target.originalDate,
              originalTime: target.originalTime,
              notification: target.notification
            })
          });
          delete state.pendingRestores[target.id];
          releasePending();
          applyPayload(data);
          render();
          if (state.pendingCount === 0 && !state.hadMutationError) {
            setStatus(doneMessage, false);
          }
        } catch (e) {
          state.hadMutationError = true;
          delete state.pendingRestores[target.id];
          releasePending();
          if (e && e.needsLogin === true) {
            enterLoginMode(e.loginUrl);
            return;
          }
          setStatus('復活エラー: ' + e.message, true);
          await syncFromServerAfterError();
          render();
        }
      });
    });
  }

  function handleRestore(index) {
    var target = state.skipped[index];
    if (!target) return;
    enqueueRestores([target], target.timeText + ' をタイムラインへ復活しました');
  }

  function handleRestoreAll() {
    var targets = state.skipped.slice();
    if (targets.length === 0) return;
    enqueueRestores(targets, targets.length + '件のアラームをすべてタイムラインへ復活しました');
  }

  document.getElementById('refreshBtn').addEventListener('click', function () {
    loadAlarms({ silent: false, manual: true });
  });
  document.getElementById('openLoginBtn').addEventListener('click', async function () {
    if (state.loginUrl) {
      window.open(state.loginUrl, '_blank', 'noopener');
      return;
    }
    try {
      var auth = await requestJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openBrowser: true })
      });
      if (auth.loginUrl) {
        state.loginUrl = auth.loginUrl;
        window.open(auth.loginUrl, '_blank', 'noopener');
      }
      startAuthPolling();
    } catch (e) {
      setStatus('ログイン画面の起動に失敗しました: ' + e.message, true);
    }
  });
  document.getElementById('tabActiveBtn').addEventListener('click', function () {
    switchTab('active');
  });
  document.getElementById('tabSkippedBtn').addEventListener('click', function () {
    switchTab('skipped');
  });
  document.getElementById('restoreAllBtn').addEventListener('click', handleRestoreAll);
  document.getElementById('timelineList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-action="skip"]');
    if (!btn) return;
    handleSkip(Number(btn.getAttribute('data-idx')));
  });
  document.getElementById('skippedList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-action="restore"]');
    if (!btn) return;
    handleRestore(Number(btn.getAttribute('data-idx')));
  });
  document.addEventListener('click', function (event) {
    if (event.detail <= 0) return;
    var target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (target && typeof target.blur === 'function') {
      target.blur();
    }
  });

  function sendHeartbeat() {
    fetch('/api/heartbeat').catch(function () {});
  }
  sendHeartbeat();
  setInterval(sendHeartbeat, 1000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      stopAutoRefresh();
      return;
    }
    if (document.visibilityState === 'visible') {
      startAutoRefresh();
      if (!isBusyForAutoRefresh()) {
        loadAlarms({ silent: true });
      }
    }
  });

  var shutdownBeaconSent = false;
  function sendShutdownBeacon() {
    if (shutdownBeaconSent) return;
    shutdownBeaconSent = true;
    stopAutoRefresh();
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon('/api/shutdown');
    }
  }

  if (!DESKTOP_HOST_MODE) {
    window.addEventListener('keydown', function (e) {
      if (e.altKey && e.key === 'F4') {
        sendShutdownBeacon();
      }
    });
    window.addEventListener('pagehide', sendShutdownBeacon);
    window.addEventListener('beforeunload', sendShutdownBeacon);
  }

  loadAlarms({ silent: false });
  startAutoRefresh();
})();
</script>
</body>
</html>
`;

let activeApiRequests = 0;
let serverMutationQueue = Promise.resolve();
let pendingServerMutations = 0;
const server = http.createServer(handleRequest);
let ipv6Server = null;

const windowManager = createWindowManager({
  getServers: () => [ipv6Server, server],
  isBusy: () => pendingServerMutations > 0 || activeApiRequests > 0 || authManager.getAuthState().status === 'logging_in',
  hasPendingWork: () => pendingServerMutations > 0 || activeApiRequests > 0,
});

function enqueueServerMutation(fn) {
  pendingServerMutations += 1;
  windowManager.touchActivity();
  const next = serverMutationQueue.then(fn, fn);
  serverMutationQueue = next.catch(() => {});
  return next.finally(() => {
    pendingServerMutations = Math.max(0, pendingServerMutations - 1);
    windowManager.touchActivity();
  });
}

async function runApiRoute(res, handler) {
  activeApiRequests += 1;
  windowManager.touchActivity();
  try {
    const data = await handler();
    if (!res.headersSent) {
      sendJson(res, 200, data);
    }
  } catch (err) {
    console.error('[API Error]', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      if (isAuthError(err)) {
        try {
          await authManager.startProxyLogin({ notify: APP_MODE || DESKTOP_HOST_MODE });
        } catch (loginErr) {
          console.error('[Auth] Failed to start proxy login:', loginErr && loginErr.stack ? loginErr.stack : loginErr);
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
  } finally {
    activeApiRequests = Math.max(0, activeApiRequests - 1);
    windowManager.touchActivity();
  }
}

function handleRequest(req, res) {
  try {
    const reqPath = (req.url || '/').split('?')[0];

    if (reqPath === '/' || reqPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_ICON_ROUTES, reqPath)) {
      const route = STATIC_ICON_ROUTES[reqPath];
      sendStaticFile(res, route.filePath, route.contentType);
      return;
    }

    if (reqPath === '/manifest.webmanifest' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(WEB_MANIFEST);
      return;
    }

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
        const body = await readJsonBody(req);
        const openBrowser = body && typeof body.openBrowser === 'boolean' ? body.openBrowser : true;
        await authManager.startProxyLogin({ notify: openBrowser, forceNotify: openBrowser });
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

    if (reqPath === '/api/heartbeat' && req.method === 'GET') {
      windowManager.recordHeartbeat();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (reqPath === '/api/shutdown' && req.method === 'POST') {
      res.on('finish', () => windowManager.shutdownServer('beforeunload'));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (reqPath === '/api/focus' && req.method === 'POST') {
      focusAppWindow();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (reqPath === '/api/alarms' && req.method === 'GET') {
      runApiRoute(res, () => alarmService.buildAlarmsPayload());
      return;
    }

    if (reqPath === '/api/widget/summary' && req.method === 'GET') {
      runApiRoute(res, () => alarmService.getWidgetSummary());
      return;
    }

    if (reqPath === '/api/alarms/skip' && req.method === 'POST') {
      runApiRoute(res, async () => {
        const body = await readJsonBody(req);
        return enqueueServerMutation(() => alarmService.skipAlarm(body));
      });
      return;
    }

    if (reqPath === '/api/alarms/restore' && req.method === 'POST') {
      runApiRoute(res, async () => {
        const body = await readJsonBody(req);
        return enqueueServerMutation(() => alarmService.restoreAlarm(body));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    console.error('[Request Error]', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
    }
  }
}

function listenIpv6Loopback(port) {
  ipv6Server = http.createServer(handleRequest);
  ipv6Server.on('error', () => {
    // IPv6 ループバックが無効な環境でも IPv4 側で継続できるよう無視する
  });
  ipv6Server.listen(port, '::1');
}

function listenServer(port) {
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && port === DEFAULT_PORT && !process.env.ALEXA_WEB_PORT) {
      console.warn(`ポート ${port} が使用中のため、空きポートで起動します...`);
      listenServer(0);
      return;
    }
    console.error(`サーバー起動エラー: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const actualPort = server.address().port;
    if (!DESKTOP_HOST_MODE) {
      windowManager.writeSingleInstanceLock(actualPort);
    }
    listenIpv6Loopback(actualPort);
    if (DESKTOP_HOST_MODE) {
      process.stdout.write(`${DESKTOP_HOST_READY_PREFIX}${JSON.stringify({ port: actualPort })}\n`);
      windowManager.startHeartbeatWatchdog();
      return;
    }
    console.log(`Alexa アラーム管理アプリが起動しました: http://localhost:${actualPort}/`);
    if (APP_MODE) {
      console.log('アプリウィンドウ（Google Chrome）を起動しています。ウィンドウを閉じるとサーバーも終了します。');
      windowManager.launchAppBrowser(actualPort);
    } else {
      console.log('終了するときは Ctrl+C を押してください。');
    }
  });
}

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error('[FatalGuard] uncaughtException:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FatalGuard] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
  });
  process.on('SIGINT', () => windowManager.shutdownServer('SIGINT'));
  process.on('SIGTERM', () => windowManager.shutdownServer('SIGTERM'));
  if (DESKTOP_HOST_MODE) {
    listenServer(DEFAULT_PORT);
  } else {
    process.on('exit', windowManager.releaseSingleInstanceLock);
    windowManager.acquireSingleInstanceLock()
      .then((acquired) => {
        if (!acquired) {
          console.log('すでに Alexa アラーム管理アプリが起動しています。既存ウィンドウを表示します。');
          process.exit(0);
        }
        listenServer(DEFAULT_PORT);
      })
      .catch((err) => {
        console.error('起動ロック確認エラー:', err && err.message ? err.message : err);
        listenServer(DEFAULT_PORT);
      });
  }
}

module.exports = {
  AuthRequiredError,
  HEARTBEAT_STALE_TIMEOUT_MS,
  backupCookieFile: authManager.backupCookieFile,
  buildAlarmsPayload: alarmService.buildAlarmsPayload,
  buildV2Recurrence,
  buildWidgetSummary,
  classifyNotifications,
  computeExpectedNextMs,
  formatRecurring,
  formatTimeParts,
  getFreePort,
  getRecurrenceRule,
  getWidgetSummary: alarmService.getWidgetSummary,
  handleRequest,
  isAuthError,
  launchAppBrowser: windowManager.launchAppBrowser,
  listenServer,
  nextTriggerMs,
  resolveRestoreDateTime,
  restoreAlarm: alarmService.restoreAlarm,
  server,
  shutdownServer: windowManager.shutdownServer,
  skipAlarm: alarmService.skipAlarm,
  startHeartbeatWatchdog: windowManager.startHeartbeatWatchdog,
};
