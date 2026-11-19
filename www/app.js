(function () {
  var AUTO_REFRESH_INTERVAL_MS = 60000;
  var state = {
    apiBaseUrl: '',
    activeTab: 'active',
    active: [],
    skipped: [],
    loading: false,
    hasRenderedData: false,
    deviceCount: 0,
    checkedAt: '',
    todayGroupMeta: null,
    pendingCount: 0,
    hadMutationError: false,
    pendingSkips: {},
    pendingRestores: {},
    needsLogin: false,
    loginUrl: null,
    authPollTimer: null,
    autoRefreshTimer: null,
    browserOpened: false
  };
  var mutationQueue = Promise.resolve();
  var mutationOpSeq = 0;

  function buildNativeMutationJob(action, target) {
    mutationOpSeq += 1;
    var notif = target && target.notification && typeof target.notification === 'object' ? target.notification : null;
    var soundId = notif && notif.sound && notif.sound.id ? notif.sound.id : '';
    var musicAlarmId = notif && notif.musicAlarmId ? notif.musicAlarmId : '';
    return {
      opId: action + '_' + Date.now() + '_' + mutationOpSeq,
      action: action,
      alarmId: (target && (target.id || target.notificationIndex)) || '',
      deviceSerialNumber: (target && target.deviceSerialNumber) || '',
      type: (target && target.type) || 'Alarm',
      originalDate: (target && target.originalDate) || '',
      originalTime: (target && target.originalTime) || '',
      label: sanitizeLabel(target && target.label),
      recurringPattern: (target && target.recurringPattern) || null,
      soundId: soundId,
      musicAlarmId: musicAlarmId,
      enqueuedAtMs: Date.now()
    };
  }

  async function enqueueNativeMutation(job) {
    if (!isNative() || !job || !job.opId) return;
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (!widgetPlugin || typeof widgetPlugin.enqueueMutation !== 'function') return;
    try {
      await widgetPlugin.enqueueMutation({ jobJson: JSON.stringify(job) });
    } catch (e) {
      console.warn('[NativeQueue] enqueueMutation failed:', e);
    }
  }

  async function completeNativeMutation(opId) {
    if (!isNative() || !opId) return;
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (!widgetPlugin || typeof widgetPlugin.completeMutation !== 'function') return;
    try {
      await widgetPlugin.completeMutation({ opId: opId });
    } catch (e) {
      console.warn('[NativeQueue] completeMutation failed:', e);
    }
  }

  async function releaseNativeInFlightMutation(opId) {
    if (!isNative() || !opId) return;
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (!widgetPlugin || typeof widgetPlugin.releaseInFlightMutation !== 'function') return;
    try {
      await widgetPlugin.releaseInFlightMutation({ opId: opId });
    } catch (e) {
      console.warn('[NativeQueue] releaseInFlightMutation failed:', e);
    }
  }

  function getCapacitorPlugin(name) {
    if (!window.Capacitor || !window.Capacitor.Plugins) return null;
    return window.Capacitor.Plugins[name] || null;
  }

  function getInAppBrowserPlugin() {
    return getCapacitorPlugin('CapgoInAppBrowser') || getCapacitorPlugin('InAppBrowser');
  }

  function isNative() {
    return Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }

  function sanitizeLabel(value) {
    if (value == null) return '';
    var trimmed = String(value).trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return '';
    return trimmed;
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
    var cleanLabel = sanitizeLabel(item && item.label);
    var labelHtml = cleanLabel
      ? '<span class="alarm-label">' + escapeHtml(cleanLabel) + '</span>'
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
    refreshBtn.disabled = state.loading || !state.apiBaseUrl;

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

  async function requestJson(apiPath, options) {
    var url = state.apiBaseUrl + apiPath;
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

  async function syncWidgetSummary(summary, fullPayload) {
    if (!summary) return;
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (!widgetPlugin || typeof widgetPlugin.updateWidgetSummary !== 'function') return;
    try {
      var payload = { summaryJson: JSON.stringify(summary) };
      if (fullPayload && typeof fullPayload === 'object') {
        payload.alarmsPayloadJson = JSON.stringify(fullPayload);
      }
      await widgetPlugin.updateWidgetSummary(payload);
    } catch (e) {
      console.warn('[Widget] updateWidgetSummary failed:', e);
    }
  }

  async function saveCookieFilePathToNative(cookieFile) {
    if (!cookieFile) return;
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (!widgetPlugin || typeof widgetPlugin.saveCookieFilePath !== 'function') return;
    try {
      await widgetPlugin.saveCookieFilePath({ cookieFile: cookieFile });
    } catch (e) {
      console.warn('[Widget] saveCookieFilePath failed:', e);
    }
  }

  async function openLoginWebView(url) {
    if (!url) return;
    var inAppBrowser = getInAppBrowserPlugin();
    if (inAppBrowser && typeof inAppBrowser.openWebView === 'function') {
      state.browserOpened = true;
      await inAppBrowser.openWebView({
        url: url,
        preventDeeplink: true,
        toolbarType: 'navigation',
        title: 'Amazon ログイン',
        activeNativeNavigationForWebview: true,
        disableGoBackOnNativeApplication: true
      });
      return;
    }
    if (isNative()) {
      setStatus('アプリ内ブラウザの起動に失敗しました（CapgoInAppBrowser 未検出）', true);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  async function closeLoginWebViewIfOpen() {
    if (!state.browserOpened) return;
    state.browserOpened = false;
    var inAppBrowser = getInAppBrowserPlugin();
    if (inAppBrowser && typeof inAppBrowser.close === 'function') {
      try {
        await inAppBrowser.close();
      } catch {}
    }
  }

  function stopAuthPolling() {
    if (state.authPollTimer) {
      clearInterval(state.authPollTimer);
      state.authPollTimer = null;
    }
  }

  async function pollAuthOnce() {
    try {
      var auth = await requestJson('/api/auth/status');
      if (auth.loginUrl) {
        state.loginUrl = auth.loginUrl;
      }
      if (auth.status === 'ready') {
        stopAuthPolling();
        state.needsLogin = false;
        state.loginUrl = null;
        await closeLoginWebViewIfOpen();
        render();
        loadAlarms();
      }
    } catch {}
  }

  function startAuthPolling() {
    if (state.authPollTimer) return;
    state.authPollTimer = setInterval(pollAuthOnce, 1500);
  }

  function enterLoginMode(loginUrl) {
    state.needsLogin = true;
    if (loginUrl) {
      state.loginUrl = loginUrl;
    }
    render();
    setStatus('Amazon へのログインが必要です', true);
    startAuthPolling();
  }

  function sortByWhenMs(items) {
    return items.slice().sort(function (a, b) {
      return (a.whenMs || 0) - (b.whenMs || 0);
    });
  }

  function applyPayload(data) {
    var serverActive = (Array.isArray(data.active) ? data.active : []).map(function (item) {
      return item && typeof item === 'object' ? Object.assign({}, item, { label: sanitizeLabel(item.label) }) : item;
    });
    var serverSkipped = (Array.isArray(data.skipped) ? data.skipped : []).map(function (item) {
      return item && typeof item === 'object' ? Object.assign({}, item, { label: sanitizeLabel(item.label) }) : item;
    });

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
    state.hasRenderedData = true;

    var todayItem = state.active.find(isTodayAlarmItem);
    if (todayItem) {
      state.todayGroupMeta = {
        dateKey: todayItem.dateKey || todayItem.originalDate || '',
        dateLabel: todayItem.dateLabel || '今日'
      };
    }

    var devCount = typeof data.deviceCount === 'number' ? data.deviceCount : 0;
    state.deviceCount = devCount;
    state.checkedAt = data.checkedAt || '';
    document.getElementById('metaText').textContent =
      '接続端末 ' + devCount + '台 / 更新 ' + state.checkedAt;

    if (data.widgetSummary) {
      syncWidgetSummary(data.widgetSummary, data);
    }
  }

  function buildOptimisticWidgetPayload() {
    var active = sortByWhenMs(state.active);
    var skipped = sortByWhenMs(state.skipped);
    var next = active.length > 0 ? active[0] : null;
    var widgetSummary = {
      hasAlarm: active.length > 0,
      nextAlarm: next ? {
        id: next.id,
        timeText: next.timeText,
        dayBadge: next.dayBadge,
        dateLabel: next.dateLabel,
        deviceName: next.deviceName,
        label: sanitizeLabel(next.label),
        whenMs: next.whenMs
      } : null,
      remainingCount: Math.max(0, active.length - 1),
      totalCount: active.length,
      checkedAt: state.checkedAt || ''
    };
    return {
      active: active,
      skipped: skipped,
      deviceCount: typeof state.deviceCount === 'number' ? state.deviceCount : 0,
      checkedAt: state.checkedAt || '',
      widgetSummary: widgetSummary
    };
  }

  function syncOptimisticWidgetState() {
    var optimisticPayload = buildOptimisticWidgetPayload();
    syncWidgetSummary(optimisticPayload.widgetSummary, optimisticPayload);
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
      if (!state.apiBaseUrl || isBusyForAutoRefresh()) return;
      loadAlarms({ silent: true });
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  async function loadAlarms(options) {
    if (state.loading || !state.apiBaseUrl) return;
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
    state.pendingCount += 1;
    render();
    syncOptimisticWidgetState();
    setStatus(target.timeText + ' (' + target.deviceName + ') をスキップ中...', false);

    var nativeJob = buildNativeMutationJob('skip', target);
    var enqueuePromise = enqueueNativeMutation(nativeJob);

    mutationQueue = mutationQueue.then(async function () {
      await enqueuePromise;
      try {
        var data = await requestJson('/api/alarms/skip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: target.id,
            notificationIndex: target.notificationIndex,
            notification: target.notification
          })
        });
        await completeNativeMutation(nativeJob.opId);
        delete state.pendingSkips[target.id];
        state.pendingCount = Math.max(0, state.pendingCount - 1);
        applyPayload(data);
        render();
        if (state.pendingCount === 0 && !state.hadMutationError) {
          setStatus(target.timeText + ' の次回分をスキップしました', false);
        }
      } catch (e) {
        state.hadMutationError = true;
        delete state.pendingSkips[target.id];
        state.pendingCount = Math.max(0, state.pendingCount - 1);
        if (e && e.needsLogin === true) {
          await completeNativeMutation(nativeJob.opId);
          enterLoginMode(e.loginUrl);
          return;
        }
        await releaseNativeInFlightMutation(nativeJob.opId);
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
    state.pendingCount += targets.length;
    render();
    syncOptimisticWidgetState();

    if (targets.length === 1) {
      setStatus(targets[0].timeText + ' (' + targets[0].deviceName + ') を元に戻しています...', false);
    } else {
      setStatus(targets.length + '件のアラームを順次元に戻しています...', false);
    }

    targets.forEach(function (target) {
      var nativeJob = buildNativeMutationJob('restore', target);
      var enqueuePromise = enqueueNativeMutation(nativeJob);
      mutationQueue = mutationQueue.then(async function () {
        await enqueuePromise;
        try {
          var data = await requestJson('/api/alarms/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: target.id,
              notificationIndex: target.notificationIndex,
              originalDate: target.originalDate,
              originalTime: target.originalTime,
              notification: target.notification
            })
          });
          await completeNativeMutation(nativeJob.opId);
          delete state.pendingRestores[target.id];
          state.pendingCount = Math.max(0, state.pendingCount - 1);
          applyPayload(data);
          render();
          if (state.pendingCount === 0 && !state.hadMutationError) {
            setStatus(doneMessage, false);
          }
        } catch (e) {
          state.hadMutationError = true;
          delete state.pendingRestores[target.id];
          state.pendingCount = Math.max(0, state.pendingCount - 1);
          if (e && e.needsLogin === true) {
            await completeNativeMutation(nativeJob.opId);
            enterLoginMode(e.loginUrl);
            return;
          }
          await releaseNativeInFlightMutation(nativeJob.opId);
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

  async function initNativeBackend() {
    var nodejsPlugin = getCapacitorPlugin('Nodejs');
    if (!nodejsPlugin) {
      throw new Error('Nodejs プラグインが利用できません');
    }

    var startedLoad = false;
    var pollTimer = null;
    var retries = 0;
    var MAX_RETRIES = 15;
    var RETRY_INTERVAL_MS = 2000;

    function stopPollTimer() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function onServerReady(payload) {
      if (!payload || !payload.port || startedLoad) return;
      startedLoad = true;
      stopPollTimer();
      if (payload.cookieFile) {
        saveCookieFilePathToNative(payload.cookieFile);
      }
      state.apiBaseUrl = 'http://127.0.0.1:' + payload.port;
      render();
      loadAlarms({ silent: state.hasRenderedData });
      startAutoRefresh();
    }

    await nodejsPlugin.addListener('message', function (event) {
      if (!event) return;
      if (event.eventName === 'serverReady' && Array.isArray(event.args) && event.args[0]) {
        onServerReady(event.args[0]);
      } else if (event.eventName === 'serverError') {
        stopPollTimer();
        var errPayload = Array.isArray(event.args) && event.args[0] ? event.args[0] : {};
        var errMsg = errPayload.message || '不明なエラー';
        setStatus('バックエンド起動エラー: ' + errMsg, true);
      }
    });

    async function sendInit(eventName) {
      try {
        await nodejsPlugin.send({
          eventName: eventName || 'initServer',
          args: [{ dataDir: '' }]
        });
      } catch (e) {
        var msg = e && e.message ? e.message : String(e);
        console.warn('[Nodejs] ' + (eventName || 'initServer') + ' send error:', e);
        if (!startedLoad) {
          setStatus('バックエンド通信エラー: ' + msg, true);
        }
      }
    }

    await nodejsPlugin.addListener('ready', function () {
      sendInit('initServer');
    });

    var readyRes = await nodejsPlugin.isReady();
    if (readyRes && readyRes.ready) {
      await sendInit('initServer');
    }

    pollTimer = setInterval(async function () {
      if (startedLoad) {
        stopPollTimer();
        return;
      }
      retries += 1;
      if (retries > MAX_RETRIES) {
        stopPollTimer();
        setStatus('バックエンド起動がタイムアウトしました。アプリを再起動してください。', true);
        return;
      }
      try {
        var res = await nodejsPlugin.isReady();
        if (res && res.ready) {
          await sendInit('getServerInfo');
        }
      } catch (e) {
        console.warn('[Nodejs] isReady poll error:', e);
      }
    }, RETRY_INTERVAL_MS);
  }

  async function resolveMockUrl() {
    var params = new URLSearchParams(window.location.search);
    var queryMockUrl = params.get('mockUrl');
    if (queryMockUrl) {
      return queryMockUrl;
    }
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (widgetPlugin && typeof widgetPlugin.getMockConfig === 'function') {
      try {
        var config = await widgetPlugin.getMockConfig();
        if (config && config.mockUrl) {
          return config.mockUrl;
        }
      } catch (e) {
        console.warn('[Mock] getMockConfig failed:', e);
      }
    }
    return null;
  }

  function registerInAppBrowserListeners() {
    var inAppBrowser = getInAppBrowserPlugin();
    if (!inAppBrowser || typeof inAppBrowser.addListener !== 'function') return;
    inAppBrowser.addListener('urlChangeEvent', function (event) {
      if (event && typeof event.url === 'string' && event.url.indexOf('/ap/maplanding') !== -1) {
        pollAuthOnce();
      }
    });
    inAppBrowser.addListener('closeEvent', function () {
      state.browserOpened = false;
      pollAuthOnce();
    });
  }

  function registerLifecycleListeners() {
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
          stopAutoRefresh();
          return;
        }
        if (document.visibilityState === 'visible') {
          startAutoRefresh();
          if (state.apiBaseUrl && !isBusyForAutoRefresh()) {
            loadAlarms({ silent: true });
          }
        }
      });
    }

    var appPlugin = getCapacitorPlugin('App');
    if (appPlugin && typeof appPlugin.addListener === 'function') {
      appPlugin.addListener('appStateChange', function (appState) {
        if (!appState || !appState.isActive) {
          stopAutoRefresh();
          return;
        }
        startAutoRefresh();
        if (state.apiBaseUrl && !isBusyForAutoRefresh()) {
          loadAlarms({ silent: true });
        }
      });
    }
  }

  async function tryRestoreCachedState() {
    if (!isNative()) return false;
    var widgetPlugin = getCapacitorPlugin('AlarmWidget');
    if (!widgetPlugin || typeof widgetPlugin.getCachedState !== 'function') return false;
    try {
      var cached = await widgetPlugin.getCachedState();
      if (!cached || !cached.hasCache || !cached.alarmsPayloadJson) return false;
      var parsed = JSON.parse(cached.alarmsPayloadJson);
      if (!parsed || !Array.isArray(parsed.active)) return false;
      applyPayload(parsed);
      render();
      setStatus('キャッシュを表示中（最新に同期しています）', false);
      return true;
    } catch (e) {
      console.warn('[Cache] getCachedState failed:', e);
      return false;
    }
  }

  async function bootstrap() {
    registerInAppBrowserListeners();
    registerLifecycleListeners();
    document.getElementById('refreshBtn').addEventListener('click', function () {
      loadAlarms({ silent: false, manual: true });
    });
    document.getElementById('openLoginBtn').addEventListener('click', async function () {
      if (state.loginUrl) {
        await openLoginWebView(state.loginUrl);
        return;
      }
      try {
        var auth = await requestJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (auth.loginUrl) {
          state.loginUrl = auth.loginUrl;
          await openLoginWebView(auth.loginUrl);
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

    var mockUrl = await resolveMockUrl();
    if (mockUrl) {
      state.apiBaseUrl = mockUrl.replace(/\/+$/, '');
      render();
      loadAlarms({ silent: false });
      startAutoRefresh();
      return;
    }

    if (isNative()) {
      var restored = await tryRestoreCachedState();
      if (!restored) {
        setLoadingOverlay(true);
      }
      setStatus('アプリ内バックエンドを起動中...', false);
      try {
        await initNativeBackend();
      } catch (e) {
        setLoadingOverlay(false);
        setStatus('バックエンド起動エラー: ' + e.message, true);
      }
      return;
    }

    // Browser fallback (e.g. local dev server)
    var params = new URLSearchParams(window.location.search);
    var portParam = params.get('apiPort');
    state.apiBaseUrl = portParam ? ('http://127.0.0.1:' + portParam) : window.location.origin;
    render();
    loadAlarms({ silent: false });
    startAutoRefresh();
  }

  bootstrap();
})();
