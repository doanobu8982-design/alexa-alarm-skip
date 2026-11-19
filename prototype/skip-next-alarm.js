#!/usr/bin/env node
/**
 * skip-next-alarm.js — Echo Show の「次のアラーム1件の次回分だけ」を
 * スマホ（Termux）から対話なしでスキップするスクリプト。
 *
 * 仕組み（2026-11-08 の調査で確認済みの前提）
 * - alexa-remote2 の通知オブジェクトには cancel() があり、繰り返し
 *   アラームの「次回だけ」をキャンセルする（nextOccurrence/cancel 相当）。
 *   シリーズ自体は残るので、翌日は普通に鳴り、戻し作業は不要。
 * - アラームが何個あっても、次回発火が一番近い ON のものを自動で選ぶ。
 *   個別指定・個別設定は不要。1回の実行で落とすのは1件だけ。同時刻に
 *   複数ある場合も1件ずつで、続けて実行すれば次の1件を落とせる。
 * - 音声を一切使わないので、聞き返しも Alexa+ の解釈ブレも関係ない。
 *
 * 使い方（Termux）
 *   pkg install nodejs
 *   npm install alexa-remote2
 *   node skip-next-alarm.js --login     # 初回だけ：ブラウザで Amazon にログインして Cookie を保存
 *   node skip-next-alarm.js --list      # Echo Show のアラーム一覧を確認（何も消さない）
 *   node skip-next-alarm.js             # 次のアラーム1件の次回分だけスキップ
 *   node skip-next-alarm.js --selftest  # 選択ロジックだけをダミーデータで検証（通信しない）
 *
 * 環境変数
 *   ALEXA_COOKIE_FILE  Cookie の保存先（既定: ./alexa-cookie.json）
 *   ECHO_NAME          対象デバイス名の一部（既定: Echo Show）
 *   ECHO_SERIAL        対象デバイスのシリアル（指定すれば名前より優先）
 *   ALEXA_EMAIL / ALEXA_PASSWORD  初回ログイン用。スクリプト内に直書きしないこと。
 *   ALEXA_PROXY_PORT   初回ログイン用プロキシのポート（既定: 3456）
 */
'use strict';

require('../src/core/proxy-patch').applyProxyPatch();

const { delay, nextTriggerMs } = require('../src/core/alarm-time');
const { createAlexaAuthManager } = require('../src/core/alexa-auth');
const { createAlarmService } = require('../src/core/alarm-service');

const ECHO_NAME = process.env.ECHO_NAME || 'Echo Show';
const ECHO_SERIAL = process.env.ECHO_SERIAL || '';
const DEFAULT_CLI_PROXY_PORT = Number(process.env.ALEXA_PROXY_PORT || '3456');

const args = process.argv.slice(2);
const MODE_LIST = args.includes('--list');
const MODE_LOGIN = args.includes('--login');
const MODE_SELFTEST = args.includes('--selftest');

/* ------------------------------------------------------------------ */
/* 選択ロジック（純粋関数：通信しないので --selftest で検証できる）      */
/* ------------------------------------------------------------------ */

/**
 * 通知一覧から「次に鳴るアラーム」を選ぶ。
 * @param {Array} notifications getNotifications() が返す notifications 配列
 * @param {string} targetSerial 対象デバイスのシリアル（空なら全デバイス対象）
 * @param {number} nowMs 基準時刻（既定: Date.now()）
 * @returns {{ picked: Array, skipped: Array, reason: string }}
 */
function pickNextAlarm(notifications, targetSerial, nowMs) {
  const now = nowMs || Date.now();
  const candidates = [];
  const skipped = [];

  for (const n of notifications || []) {
    const type = n.type || '';
    if (type !== 'Alarm' && type !== 'MusicAlarm') {
      skipped.push({ notification: n, reason: 'Reminder / Timer は対象外' });
      continue;
    }
    if (targetSerial && n.deviceSerialNumber && n.deviceSerialNumber !== targetSerial) {
      skipped.push({ notification: n, reason: '他のデバイスのアラームのため対象外' });
      continue;
    }
    if (n.status !== 'ON') {
      skipped.push({ notification: n, reason: 'OFF のため対象外' });
      continue;
    }
    const when = nextTriggerMs(n);
    if (!when) {
      skipped.push({ notification: n, reason: '次回発火時刻が読めないため対象外' });
      continue;
    }
    if (when <= now - 60 * 1000) {
      skipped.push({ notification: n, reason: '次回発火時刻が過去のため対象外' });
      continue;
    }
    candidates.push({ notification: n, when });
  }

  if (candidates.length === 0) {
    return { picked: [], skipped, reason: 'ON のアラームが見つかりませんでした' };
  }
  candidates.sort((a, b) => a.when - b.when);
  const picked = [candidates[0].notification];
  const rest = candidates.slice(1);
  for (const c of rest) {
    skipped.push({ notification: c.notification, reason: 'もっと早いアラームがあるため今回は対象外' });
  }
  return { picked, skipped, reason: '' };
}

/** 一覧表示用の1行を作る。 */
function describe(n) {
  const when = nextTriggerMs(n);
  const whenStr = when ? new Date(when).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '時刻不明';
  const label = n.alarmLabel || n.reminderLabel || n.timerLabel || n.label || '(ラベルなし)';
  return `[${n.type || '?'} ${n.status || '?'}] ${whenStr}  ${label}  `
    + `(index=${n.notificationIndex || n.id || '?'}, serial=${n.deviceSerialNumber || '?'})`;
}

/* ------------------------------------------------------------------ */
/* --selftest：選択ロジックだけをダミーデータで検証する                */
/* ------------------------------------------------------------------ */
function runSelftest() {
  const base = Date.parse('2026-11-09T08:00:00+09:00');
  const sample = [
    { type: 'Alarm', status: 'ON', deviceSerialNumber: 'SHOW1', notificationIndex: '1',
      trigger: { scheduledTime: '2026-11-09T08:05:00+09:00' }, alarmLabel: '起床1' },
    { type: 'Alarm', status: 'ON', deviceSerialNumber: 'SHOW1', notificationIndex: '2',
      trigger: { scheduledTime: '2026-11-09T08:30:00+09:00' }, alarmLabel: '起床2' },
    { type: 'Alarm', status: 'OFF', deviceSerialNumber: 'SHOW1', notificationIndex: '3',
      trigger: { scheduledTime: '2026-11-09T08:01:00+09:00' }, alarmLabel: 'OFFのアラーム' },
    { type: 'Alarm', status: 'ON', deviceSerialNumber: 'DOT9', notificationIndex: '4',
      trigger: { scheduledTime: '2026-11-09T08:02:00+09:00' }, alarmLabel: '別デバイス' },
    { type: 'Reminder', status: 'ON', deviceSerialNumber: 'SHOW1', notificationIndex: '5',
      trigger: { scheduledTime: '2026-11-09T08:03:00+09:00' }, reminderLabel: 'リマインダー' },
    { type: 'MusicAlarm', status: 'ON', deviceSerialNumber: 'SHOW1', notificationIndex: '6',
      trigger: { scheduledTime: '2026-11-09T09:00:00+09:00' }, alarmLabel: '音楽アラーム' },
  ];
  const result = pickNextAlarm(sample, 'SHOW1', base);
  const okPicked = result.picked.length === 1 && result.picked[0].notificationIndex === '1';
  const okSkipped = result.skipped.length === 5;

  const tieSample = sample.concat([
    { type: 'Alarm', status: 'ON', deviceSerialNumber: 'SHOW1', notificationIndex: '7',
      trigger: { scheduledTime: '2026-11-09T08:05:00+09:00' }, alarmLabel: '同時刻アラーム' },
  ]);
  const tie = pickNextAlarm(tieSample, 'SHOW1', base);
  const okTie = tie.picked.length === 1;

  console.log('selftest: 一番近い ON アラームだけを選ぶ …', okPicked ? 'OK' : 'NG');
  console.log('selftest: 対象外が5件になる …', okSkipped ? 'OK' : 'NG');
  console.log('selftest: 同時刻でも1件だけ選ぶ …', okTie ? 'OK' : 'NG');
  if (!okPicked || !okSkipped || !okTie) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log('selftest: すべて OK（通信はしていません）');
}

if (MODE_SELFTEST) {
  runSelftest();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 本体：src/core/* 経由で認証・一覧取得 → 選択 → cancel → 再確認     */
/* ------------------------------------------------------------------ */
const authManager = createAlexaAuthManager({
  proxyPort: DEFAULT_CLI_PROXY_PORT,
  onLoginUrl: (loginUrl) => {
    console.log(`\nログイン用プロキシが待機中です: ${loginUrl}`);
    console.log('この URL をブラウザで開いて Amazon アカウントでログインしてください。');
  },
});
const alarmService = createAlarmService(authManager);

function getDevicesRaw(client) {
  return new Promise((resolve, reject) => {
    if (!client || typeof client.getDevices !== 'function') {
      resolve([]);
      return;
    }
    client.getDevices((err, res) => {
      if (err) {
        reject(authManager.normalizeAlexaError(err));
        return;
      }
      const list = Array.isArray(res) ? res : (res && res.devices ? res.devices : []);
      resolve(list);
    });
  });
}

async function ensureCliClient() {
  let savedCookie = null;
  try {
    savedCookie = authManager.loadSavedCookie();
  } catch (e) {
    console.error(`Cookie ファイルが読めません (${authManager.getCookieFile()}): ${e.message}`);
  }

  if (savedCookie) {
    return authManager.connectAlexa();
  }

  console.log('プロキシサーバーを起動します。ブラウザから Amazon にログインしてください。');
  await authManager.startProxyLogin({ notify: true });

  while (true) {
    const state = authManager.getAuthState();
    if (state.status === 'ready') {
      return authManager.connectAlexa();
    }
    if (state.status === 'login_required') {
      throw new Error(state.error || 'ログインに失敗しました。');
    }
    await delay(500);
  }
}

async function main() {
  const client = await ensureCliClient();
  console.log('Alexa に接続しました。');

  let targetSerial = ECHO_SERIAL;
  if (!targetSerial) {
    const devices = await getDevicesRaw(client);
    const matches = devices.filter((d) => {
      const name = d.accountName || d.deviceName || '';
      return name.includes(ECHO_NAME) || (d.deviceType || '').includes('Echo Show');
    });
    if (matches.length === 0) {
      console.error(`「${ECHO_NAME}」に一致するデバイスが見つかりませんでした。`);
      console.error('デバイス一覧（accountName / deviceType / serialNumber）:');
      for (const d of devices) {
        console.error(`  - ${d.accountName || d.deviceName || '?'} / ${d.deviceType || '?'} / ${d.serialNumber || '?'}`);
      }
      console.error('ECHO_NAME または ECHO_SERIAL を指定して再実行してください。');
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error('対象デバイスが複数見つかりました。ECHO_SERIAL で1台に絞ってください：');
      for (const d of matches) {
        console.error(`  - ${d.accountName || d.deviceName || '?'} / ${d.deviceType || '?'} / ${d.serialNumber || '?'}`);
      }
      process.exit(1);
    }
    targetSerial = matches[0].serialNumber;
    console.log(`対象デバイス: ${matches[0].accountName || matches[0].deviceName} (${targetSerial})`);
  }

  const notifications = await alarmService.getNotifications();
  const alarms = notifications.filter((n) => (n.type === 'Alarm' || n.type === 'MusicAlarm')
    && (!targetSerial || n.deviceSerialNumber === targetSerial));

  if (MODE_LIST || MODE_LOGIN) {
    console.log(`\n--- ${ECHO_NAME} のアラーム一覧（${alarms.length}件）---`);
    if (alarms.length === 0) console.log('設定中のアラームは 0 件です');
    for (const n of alarms) console.log(describe(n));
    if (MODE_LOGIN) console.log('\nログインと一覧取得ができました。Cookie は保存済みです。');
    console.log('\n※ このモードでは何もキャンセルしていません。');
    process.exit(0);
  }

  const { picked, skipped, reason } = pickNextAlarm(notifications, targetSerial);
  if (picked.length === 0) {
    console.log(`スキップ対象がありません: ${reason}`);
    console.log('--- 現在のアラーム ---');
    for (const n of alarms) console.log(describe(n));
    process.exit(0);
  }

  console.log('\n--- スキップ対象（次に鳴るアラーム）---');
  for (const n of picked) console.log(describe(n));

  for (const n of picked) {
    await alarmService.cancelNotificationAsync(client, n);
    console.log(`キャンセルしました: ${describe(n)}`);
  }

  const after = await alarmService.getNotifications();
  const stillThere = after.filter((n) => picked.some((p) => p.notificationIndex === n.notificationIndex));
  console.log('\n--- キャンセル後の確認 ---');
  if (stillThere.length === 0) {
    console.log('対象アラームが一覧から消えています。');
    console.log('※ 繰り返しアラームの場合、次回分だけが消えてシリーズ自体は残るのが');
    console.log('  期待動作です。Echo Show の画面か Alexa アプリで、次回が翌日以降に');
    console.log('  なっていることを確認してください。');
  } else {
    for (const n of stillThere) console.log(describe(n));
    console.log('※ 上の一覧で次回時刻が翌日以降になっていれば成功です。');
    console.log('  変わっていなければ、Echo Show の画面 / Alexa アプリでも確認してください。');
  }
  if (skipped.length > 0) {
    console.log('\n--- 今回は触らなかったアラーム ---');
    for (const s of skipped) console.log(`${describe(s.notification)} （${s.reason}）`);
  }
  console.log('\n完了です。戻し作業は不要です。');
  process.exit(0);
}

main().catch((err) => {
  console.error(`失敗しました: ${err && err.message ? err.message : err}`);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
