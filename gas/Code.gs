/**
 * Squareシフト → Googleカレンダー連携（Google Apps Script 版・無料）
 *
 * Googleスプレッドシートに貼り付けて使います。サーバーは不要です。
 *   1. スプレッドシートの「拡張機能」→「Apps Script」にこのファイルの中身をすべて貼り付けて保存
 *   2. 上の関数選択で「setup」を選んで「実行」→ 権限を許可
 *   3. 「設定」シートに Square のアクセストークンを貼り付け
 * 以降は10分ごとに自動で同期します。詳しくは gas/README.md を参照。
 */

// ===================== 定数 =====================

var SQUARE_VERSION = '2026-09-16';
var SYNC_EVERY_MINUTES = 10;
var NONE_LABEL = '（書き込まない）';
var MAIN_LABEL_SUFFIX = '（メイン）';

var SHEETS = {
  settings: '設定',
  stores: '店舗',
  staff: 'スタッフ',
  log: '同期ログ',
  records: '_同期記録',
};

/** 設定シートの行：[キー, 項目名, 初期値, 説明] */
var SETTING_ROWS = [
  ['token', 'Squareアクセストークン', '', 'Square Developer Dashboard の「本番」アクセストークンを貼り付け。保存すると自動で隠されます'],
  ['env', 'Square環境', '本番', '本番 / サンドボックス'],
  ['days', '同期する日数', 30, '今日から何日先までのシフトをカレンダーに入れるか'],
  ['title', '予定タイトル', '【出勤】{name}', '{name}=氏名 {location}=店舗名 {job}=職種'],
  ['defaultCal', '既定の店舗カレンダー', '', '「店舗」シートで指定が無い店舗の書き込み先。空欄＝このアカウントのメインカレンダー'],
  ['syncNow', '今すぐ同期', false, 'チェックを入れると同期を実行します'],
  ['reload', 'スタッフ・店舗を読み込み', false, 'チェックを入れるとSquareから最新のスタッフ・店舗を読み込みます'],
  ['status', '最終同期', '', ''],
];

var RECORD_HEADER = ['キー', 'シフトID', '対象', 'カレンダーID', '予定ID', 'ハッシュ', '状態', '開始', 'スタッフID', '招待先', 'メモ', '更新', '店舗ID', '終了'];
var TOKEN_SAVED = '設定済み（変更するときは新しいトークンを貼り付け）';

// ===================== 最初に1回だけ実行 =====================

/** 初期設定：シートの作成と自動実行の登録。何度実行しても大丈夫です */
function setup() {
  var ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  formatSheets_(ss);
  installTriggers_(ss);
  refreshCalendarChoices_(ss);
  moveTokenFromSheet_(ss);
  if (getToken_()) {
    loadMasters_(ss);
    ss.toast('初期設定が完了しました。「店舗」「スタッフ」シートを確認してください。', 'シフト連携', 10);
  } else {
    ss.toast('初期設定が完了しました。「設定」シートに Square のアクセストークンを貼り付けてください。', 'シフト連携', 10);
  }
}

// ===================== メニュー・操作 =====================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('シフト連携')
    .addItem('今すぐ同期', 'syncNowFromMenu')
    .addItem('スタッフ・店舗を読み込み', 'loadMastersFromMenu')
    .addSeparator()
    .addItem('初期設定（やり直し）', 'setup')
    .addToUi();
}

function syncNowFromMenu() {
  var msg = syncShifts('手動');
  SpreadsheetApp.getActive().toast(msg, 'シフト連携', 10);
}

function loadMastersFromMenu() {
  var ss = SpreadsheetApp.getActive();
  loadMasters_(ss);
  ss.toast('スタッフと店舗を読み込みました', 'シフト連携', 5);
}

/** 編集時（インストール型トリガー）。スマホアプリのチェックボックス操作でも動きます */
function handleEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SHEETS.settings || e.range.getColumn() !== 2) return;
  var label = sheet.getRange(e.range.getRow(), 1).getValue();
  var ss = sheet.getParent();

  if (label === settingLabel_('token')) {
    moveTokenFromSheet_(ss);
    if (getToken_()) loadMasters_(ss);
  } else if (label === settingLabel_('syncNow') && isChecked_(e.range.getValue())) {
    e.range.setValue(false);
    syncShifts('手動');
  } else if (label === settingLabel_('reload') && isChecked_(e.range.getValue())) {
    e.range.setValue(false);
    loadMasters_(ss);
  }
}

// ===================== 同期 =====================

/** 定期実行・手動実行の入口 */
function syncShifts(trigger) {
  trigger = typeof trigger === 'string' ? trigger : '自動';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return '別の同期が実行中です';
  try {
    return runSync_(SpreadsheetApp.getActive(), trigger, new Date());
  } finally {
    lock.releaseLock();
  }
}

function runSync_(ss, trigger, now) {
  ensureSheets_(ss);
  moveTokenFromSheet_(ss);
  var token = getToken_();
  if (!token) {
    var m = 'Squareのアクセストークンが未設定です（「設定」シート）';
    writeLog_(ss, trigger, m);
    return m;
  }
  var cfg = readConfig_(ss);
  var api = squareApi_(token, cfg.env);
  var summary = { shifts: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, noDest: 0, error: 0, errors: [] };

  try {
    var from = new Date(now.getTime() - 24 * 3600 * 1000);
    var to = new Date(now.getTime() + cfg.days * 24 * 3600 * 1000);
    var members = api.listTeamMembers();
    var locations = api.listLocations();
    var jobs = api.listJobs();
    upsertMasterSheets_(ss, members, locations);

    var ctx = {
      cfg: cfg,
      members: indexBy_(members, 'id'),
      locations: locations,
      jobs: jobs,
      staffCalendars: readStaffCalendars_(ss),
      storeCalendars: readStoreCalendars_(ss),
      records: loadRecords_(ss),
      calCache: {},
      denied: loadDenied_(),
      summary: summary,
    };

    removeMeetFromExisting_(ctx.records);

    var shifts = api.searchPublishedShifts(from, to);
    var seen = {};
    shifts.forEach(function (s) {
      seen[s.id] = true;
      syncShift_(s.id, s, ctx);
    });
    // 以前カレンダーに入れたのに、今回の検索に出てこないシフト（削除など）を個別に確認
    liveShiftIdsBetween_(ctx.records, from, to).forEach(function (id) {
      if (seen[id]) return;
      syncShift_(id, api.getScheduledShift(id), ctx);
    });

    saveRecords_(ss, ctx.records, now);
    writeStaffStatus_(ss, ctx);
    saveDenied_(ctx.denied);
  } catch (err) {
    summary.error++;
    summary.errors.unshift(errorText_(err));
  }

  var text = formatSummary_(summary);
  writeLog_(ss, trigger, text);
  setSetting_(ss, 'status', Utilities.formatDate(now, ss.getSpreadsheetTimeZone(), 'M/d HH:mm') + '  ' + text.split('\n')[0]);
  return text;
}

/** 1つのシフトを、本人カレンダー・店舗カレンダーの「あるべき姿」に合わせる */
function syncShift_(shiftId, shift, ctx) {
  var d = shift && shift.published_shift_details;
  var active = !!(d && !d.is_deleted && d.team_member_id && d.start_at && d.end_at);
  ctx.summary.shifts++;
  var reason = !shift ? 'Squareにシフトが存在しません' : !active ? 'シフトが削除または担当者なし' : '';

  if (!active) {
    reconcileTarget_(shiftId, 'staff', null, d, reason || '書き込み先なし', ctx);
    reconcileTarget_(shiftId, 'store', null, d, reason || '書き込み先なし', ctx);
    return;
  }

  var tmId = d.team_member_id;
  var info = staffInfo_(tmId, ctx);
  var evc = eventContent_(shift, info.member, ctx);

  // 本人カレンダー（先に処理し、権限が無ければ店舗カレンダーからの招待に切り替える）
  var staffWant = info.calendarWritable ? { calId: info.calendarId, content: evc, guests: [] } : null;
  var r = reconcileTarget_(shiftId, 'staff', staffWant, d, '本人カレンダーに書き込めないため', ctx);
  if (r === 'denied') r = reconcileTarget_(shiftId, 'staff', null, d, '本人カレンダーの共有権限が「予定の変更」ではありません', ctx);
  var staffOk = !!staffWant && r !== 'error' && !ctx.denied[info.calendarId];

  // 店舗カレンダー
  var storeCalId = storeCalendarFor_(d.location_id, ctx);
  var invite = !staffOk && info.email ? info.email : null;
  var storeWant = storeCalId ? { calId: storeCalId, content: evc, guests: invite ? [invite] : [] } : null;
  reconcileTarget_(shiftId, 'store', storeWant, d, '店舗カレンダーの書き込み先なし', ctx);

  if (!staffOk && !(storeWant && invite)) ctx.summary.noDest++;
}

/** 1か所の予定を合わせる。戻り値: created / updated / unchanged / deleted / error / denied / null */
function reconcileTarget_(shiftId, target, want, d, removalReason, ctx) {
  var key = shiftId + '|' + target;
  var rec = ctx.records[key];
  var live = !!(rec && rec.eventId && (rec.status === 'synced' || rec.status === 'error'));
  var samePlace = live && want && rec.calId === want.calId;
  var base = {
    key: key, shiftId: shiftId, target: target,
    start: d && d.start_at ? d.start_at : rec ? rec.start : '',
    end: d && d.end_at ? d.end_at : rec ? rec.end : '',
    teamMemberId: d && d.team_member_id ? d.team_member_id : rec ? rec.teamMemberId : '',
    locationId: d && d.location_id ? d.location_id : rec ? rec.locationId : '',
  };

  try {
    if (live && !samePlace) {
      deleteEvent_(rec.calId, rec.eventId, ctx);
      if (!want) {
        ctx.records[key] = merge_(rec, { status: 'deleted', hash: '', note: removalReason });
        ctx.summary.deleted++;
        return 'deleted';
      }
    }
    if (!want) {
      if (rec && rec.status !== 'deleted') ctx.records[key] = merge_(rec, { status: 'deleted', hash: '', note: removalReason });
      return null;
    }

    var hash = hash_([want.content, want.guests]);
    if (samePlace && rec.status === 'synced' && rec.hash === hash) {
      ctx.summary.unchanged++;
      return 'unchanged';
    }

    var cal = calendar_(want.calId, ctx);
    if (!cal) throw new Error('カレンダーにアクセスできません: ' + want.calId);
    var ev = samePlace ? cal.getEventById(rec.eventId) : null;
    var updated = !!ev;
    if (ev) {
      updateEvent_(ev, want);
    } else {
      ev = createEvent_(cal, want, shiftId);
    }
    ctx.records[key] = merge_(base, {
      calId: want.calId, eventId: ev.getId(), hash: hash, status: 'synced',
      guests: want.guests.join(','), note: '',
    });
    var result = updated ? 'updated' : 'created';
    ctx.summary[result]++;
    return result;
  } catch (err) {
    var msg = errorText_(err);
    if (target === 'staff' && want && /permission|権限|forbidden|denied/i.test(msg)) {
      // 閲覧のみで共有されている → 6時間は試さず、店舗カレンダーからの招待に切り替える
      ctx.denied[want.calId] = Date.now();
      return 'denied';
    }
    ctx.records[key] = merge_(rec || base, merge_(base, {
      calId: live && !samePlace ? '' : (rec && rec.calId) || (want ? want.calId : ''),
      eventId: live && !samePlace ? '' : (rec && rec.eventId) || '',
      hash: '', status: 'error', note: msg,
    }));
    ctx.summary.error++;
    ctx.summary.errors.push(shiftId + '(' + (target === 'store' ? '店舗' : '本人') + '): ' + msg);
    return 'error';
  }
}

function createEvent_(cal, want, shiftId) {
  var c = want.content;
  var opts = { description: c.description, location: c.location };
  if (want.guests.length) {
    opts.guests = want.guests.join(',');
    opts.sendInvites = true;
  }
  var ev = cal.createEvent(c.title, new Date(c.start), new Date(c.end), opts);
  ev.setTag('squareShiftId', shiftId);
  removeMeet_(cal.getId(), ev.getId());
  return ev;
}

/**
 * Google Meet を外す。Workspace の「予定に Meet を自動で追加」設定で、
 * スクリプトが作った予定にも Meet が付いてしまうため。
 */
function removeMeet_(calId, eventId) {
  var id = String(eventId).replace(/@google\.com$/, '');
  try {
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) +
        '/events/' + encodeURIComponent(id) + '?conferenceDataVersion=1&sendUpdates=none',
      {
        method: 'patch',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ conferenceData: null }),
        muteHttpExceptions: true,
      });
    return res.getResponseCode() < 300;
  } catch (e) {
    return false;
  }
}

/** 以前に作った予定から、一度だけ Meet を外す */
function removeMeetFromExisting_(records) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('MEET_REMOVED_V1')) return;
  Object.keys(records).forEach(function (k) {
    var r = records[k];
    if (r.eventId && r.calId && r.status === 'synced') removeMeet_(r.calId, r.eventId);
  });
  props.setProperty('MEET_REMOVED_V1', String(Date.now()));
}

function updateEvent_(ev, want) {
  var c = want.content;
  ev.setTitle(c.title);
  ev.setTime(new Date(c.start), new Date(c.end));
  ev.setDescription(c.description);
  ev.setLocation(c.location);
  var current = ev.getGuestList().map(function (g) { return g.getEmail().toLowerCase(); });
  var wanted = want.guests.map(function (g) { return g.toLowerCase(); });
  current.forEach(function (g) { if (wanted.indexOf(g) < 0) ev.removeGuest(g); });
  wanted.forEach(function (g) { if (current.indexOf(g) < 0) ev.addGuest(g); });
}

function deleteEvent_(calId, eventId, ctx) {
  var cal = calendar_(calId, ctx);
  if (!cal) return; // 共有が解除された等でアクセスできない場合はあきらめる
  var ev = cal.getEventById(eventId);
  if (ev) ev.deleteEvent();
}

/** 予定の中身（タイトル・時間・説明） */
function eventContent_(shift, member, ctx) {
  var d = shift.published_shift_details;
  var name = memberName_(member) || 'スタッフ';
  var location = d.location_id ? ctx.locations[d.location_id] || '' : '';
  var job = d.job_id ? ctx.jobs[d.job_id] || '' : '';
  var title = ctx.cfg.title
    .replace(/\{name\}/g, name)
    .replace(/\{location\}/g, location)
    .replace(/\{job\}/g, job)
    .replace(/[\s\/／・]+$/, '')
    .trim() || name;
  var lines = ['スタッフ: ' + name];
  if (location) lines.push('店舗: ' + location);
  if (job) lines.push('職種: ' + job);
  if (d.notes) lines.push('メモ: ' + d.notes);
  lines.push('', '※ Squareのシフトから自動作成された予定です。変更はSquare側で行ってください。');
  return { title: title, start: d.start_at, end: d.end_at, location: location, description: lines.join('\n') };
}

/** スタッフの書き込み先（本人カレンダー）と招待先 */
function staffInfo_(tmId, ctx) {
  var member = ctx.members[tmId];
  var email = (ctx.staffCalendars[tmId] || (member && member.email_address) || '').trim();
  var cal = email && !ctx.denied[email] ? calendar_(email, ctx) : null;
  var writable = !!cal && !ctx.denied[email];
  return { member: member, email: email, calendarId: email, calendarWritable: writable };
}

/** カレンダーを取得（共有されていて未登録なら自動で登録する）。アクセスできなければ null */
function calendar_(id, ctx) {
  if (Object.prototype.hasOwnProperty.call(ctx.calCache, id)) return ctx.calCache[id];
  var cal = null;
  try {
    cal = CalendarApp.getCalendarById(id);
    if (!cal) cal = CalendarApp.subscribeToCalendar(id, { hidden: false, selected: false });
  } catch (e) {
    cal = null;
  }
  ctx.calCache[id] = cal;
  return cal;
}

function storeCalendarFor_(locationId, ctx) {
  var v = locationId && Object.prototype.hasOwnProperty.call(ctx.storeCalendars, locationId) ? ctx.storeCalendars[locationId] : null;
  if (v === null || v === undefined) v = ctx.cfg.defaultCalId;
  return v; // '' = 書き込まない
}

function liveShiftIdsBetween_(records, from, to) {
  var ids = {};
  Object.keys(records).forEach(function (k) {
    var r = records[k];
    if (!r.eventId || (r.status !== 'synced' && r.status !== 'error')) return;
    var t = new Date(r.start).getTime();
    if (t >= from.getTime() && t < to.getTime()) ids[r.shiftId] = true;
  });
  return Object.keys(ids);
}

function formatSummary_(s) {
  var t = 'シフト' + s.shifts + '件 / 新規' + s.created + ' / 更新' + s.updated + ' / 変更なし' + s.unchanged +
    ' / 削除' + s.deleted + ' / 送信先なし' + s.noDest + ' / エラー' + s.error;
  return s.errors.length ? t + '\n' + s.errors.slice(0, 5).join('\n') : t;
}

// ===================== ダッシュボード（Webアプリ） =====================
// 「デプロイ」→「ウェブアプリ」で公開すると、Dashboard.html を管理画面として使えます。
// 下の dashboard〜 関数は画面から呼ばれます（アクセスできるのは「自分のみ」にしてください）。

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('シフト連携ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 画面に必要な情報をまとめて返す */
function dashboardData() {
  var ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();

  var calendarOptions = ownedCalendars_().map(calendarLabel_);
  calendarOptions.push(NONE_LABEL);

  var stores = rowsOf_(ss.getSheetByName(SHEETS.stores), 3).map(function (r) {
    return { id: String(r[0]), name: String(r[1] || r[0]), calendar: String(r[2] || '') };
  });
  var storeNames = {};
  stores.forEach(function (st) { storeNames[st.id] = st.name; });

  var staff = rowsOf_(ss.getSheetByName(SHEETS.staff), 5).map(function (r) {
    var status = String(r[4] || '');
    return {
      id: String(r[0]), name: String(r[1] || r[0]), squareEmail: String(r[2] || ''), calendar: String(r[3] || ''),
      status: status,
      level: status.indexOf('✓') === 0 ? 'ok' : status.indexOf('✗') === 0 ? 'error' : status ? 'warn' : 'unknown',
    };
  });
  var staffNames = {};
  staff.forEach(function (m) { staffNames[m.id] = m.name; });

  // 今後のシフト（同期記録から、シフトごとに 店舗 / 本人 をまとめる）
  var records = loadRecords_(ss);
  var byShift = {};
  Object.keys(records).forEach(function (k) {
    var r = records[k];
    var start = new Date(r.start);
    if (isNaN(start.getTime()) || start.getTime() < now.getTime() - 12 * 3600 * 1000) return;
    var item = byShift[r.shiftId] || (byShift[r.shiftId] = {
      id: r.shiftId, start: r.start, end: r.end || '', teamMemberId: r.teamMemberId,
      name: staffNames[r.teamMemberId] || r.teamMemberId || '', location: storeNames[r.locationId] || '',
    });
    if (r.end) item.end = r.end;
    if (r.locationId && storeNames[r.locationId]) item.location = storeNames[r.locationId];
    item[r.target] = { status: r.status, note: r.note || '', guests: r.guests || '' };
  });
  var shifts = Object.keys(byShift).map(function (k) { return byShift[k]; })
    .filter(function (x) { return !(isDeletedOnly_(x)); })
    .sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; })
    .slice(0, 300);

  var logSheet = ss.getSheetByName(SHEETS.log);
  var logs = rowsOf_(logSheet, 3).slice(0, 30).map(function (r) {
    return {
      at: r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'M/d HH:mm') : String(r[0]),
      trigger: String(r[1] || ''),
      text: String(r[2] || ''),
      error: /エラー[1-9]|エラー\d{2,}|正しくありません|未設定/.test(String(r[2] || '')),
    };
  });

  var autoSync = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncShifts'; });
  var cfgDefault = String(getSetting_(ss, 'defaultCal') || '');
  var errors = shifts.filter(function (x) {
    return (x.store && x.store.status === 'error') || (x.staff && x.staff.status === 'error');
  }).length;

  return {
    timeZone: tz,
    generatedAt: Utilities.formatDate(now, tz, 'M/d HH:mm'),
    spreadsheetUrl: ss.getUrl ? ss.getUrl() : '',
    settings: {
      tokenSet: !!getToken_(),
      env: String(getSetting_(ss, 'env') || '本番'),
      days: Number(getSetting_(ss, 'days')) || 30,
      title: String(getSetting_(ss, 'title') || '【出勤】{name}'),
      defaultCal: cfgDefault,
      lastSync: String(getSetting_(ss, 'status') || ''),
      autoSync: autoSync,
      everyMinutes: SYNC_EVERY_MINUTES,
    },
    calendarOptions: calendarOptions,
    stores: stores,
    staff: staff,
    shifts: shifts,
    logs: logs,
    stats: {
      upcoming: shifts.length,
      staffTotal: staff.length,
      staffDirect: staff.filter(function (m) { return m.level === 'ok'; }).length,
      staffInvite: staff.filter(function (m) { return m.level === 'warn'; }).length,
      staffNone: staff.filter(function (m) { return m.level === 'error'; }).length,
      storesUnset: stores.filter(function (st) { return !st.calendar; }).length,
      errors: errors,
    },
  };
}

function dashboardSync() {
  var message = syncShifts('ダッシュボード');
  return { message: message, data: dashboardData() };
}

function dashboardReload() {
  var ss = SpreadsheetApp.getActive();
  if (!getToken_()) throw new Error('先に「設定」でSquareのアクセストークンを登録してください');
  loadMasters_(ss);
  return dashboardData();
}

/** 設定の保存。token は入力された時だけ上書き */
function dashboardSaveSettings(input) {
  var ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  input = input || {};
  var token = String(input.token || '').trim();
  if (token) {
    PropertiesService.getScriptProperties().setProperty('SQUARE_ACCESS_TOKEN', token);
    setSetting_(ss, 'token', TOKEN_SAVED);
  }
  if (input.env === '本番' || input.env === 'サンドボックス') setSetting_(ss, 'env', input.env);
  if (input.days !== undefined) {
    var days = Math.round(Number(input.days));
    if (!(days >= 1 && days <= 180)) throw new Error('同期する日数は1〜180で入力してください');
    setSetting_(ss, 'days', days);
  }
  if (input.title !== undefined) {
    var title = String(input.title).trim();
    if (!title) throw new Error('予定タイトルを入力してください');
    setSetting_(ss, 'title', title);
  }
  if (input.defaultCal !== undefined) setSetting_(ss, 'defaultCal', String(input.defaultCal));
  if (token) loadMasters_(ss);
  return dashboardData();
}

function dashboardSaveStore(locationId, calendarLabel) {
  var ss = SpreadsheetApp.getActive();
  setCellById_(ss.getSheetByName(SHEETS.stores), locationId, 3, String(calendarLabel || ''));
  return dashboardData();
}

function dashboardSaveStaff(teamMemberId, email) {
  email = String(email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません: ' + email);
  var ss = SpreadsheetApp.getActive();
  setCellById_(ss.getSheetByName(SHEETS.staff), teamMemberId, 4, email);
  return dashboardData();
}

function setCellById_(sh, id, col, value) {
  var last = sh.getLastRow();
  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        sh.getRange(i + 2, col).setValue(value);
        return;
      }
    }
  }
  throw new Error('見つかりません: ' + id);
}

function rowsOf_(sh, width) {
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues().filter(function (r) { return r[0] !== '' && r[0] !== null; });
}

function isDeletedOnly_(x) {
  var targets = [x.store, x.staff].filter(function (t) { return t; });
  return targets.length > 0 && targets.every(function (t) { return t.status === 'deleted'; });
}

// ===================== Square API =====================

function squareApi_(token, env) {
  var base = env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

  function call(method, path, body) {
    var res = UrlFetchApp.fetch(base + path, {
      method: method,
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'Square-Version': SQUARE_VERSION },
      payload: body ? JSON.stringify(body) : undefined,
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var json = {};
    try { json = JSON.parse(res.getContentText() || '{}'); } catch (e) { json = {}; }
    if (code === 404) return null;
    if (code >= 300) {
      var detail = json.errors && json.errors[0] ? json.errors[0].code + ' ' + (json.errors[0].detail || '') : res.getContentText();
      if (code === 401) detail = 'アクセストークンが正しくありません（' + detail + '）';
      throw new Error('Square API ' + code + ': ' + detail);
    }
    return json;
  }

  return {
    searchPublishedShifts: function (from, to) {
      var out = [];
      var cursor = null;
      do {
        var body = {
          query: {
            filter: {
              start: { start_at: from.toISOString(), end_at: to.toISOString() },
              scheduled_shift_statuses: ['PUBLISHED'],
            },
            sort: { field: 'START_AT', order: 'ASC' },
          },
          limit: 50,
        };
        if (cursor) body.cursor = cursor;
        var res = call('post', '/v2/labor/scheduled-shifts/search', body);
        out = out.concat(res.scheduled_shifts || []);
        cursor = res.cursor;
      } while (cursor);
      return out;
    },
    getScheduledShift: function (id) {
      var res = call('get', '/v2/labor/scheduled-shifts/' + encodeURIComponent(id));
      return res ? res.scheduled_shift || null : null;
    },
    listTeamMembers: function () {
      var out = [];
      var cursor = null;
      do {
        var body = { limit: 200 };
        if (cursor) body.cursor = cursor;
        var res = call('post', '/v2/team-members/search', body);
        out = out.concat(res.team_members || []);
        cursor = res.cursor;
      } while (cursor);
      return out;
    },
    listLocations: function () {
      var res = call('get', '/v2/locations');
      var map = {};
      (res.locations || []).forEach(function (l) { map[l.id] = l.name || l.id; });
      return map;
    },
    listJobs: function () {
      var map = {};
      var cursor = null;
      do {
        var res = call('get', '/v2/team-members/jobs' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
        ((res && res.jobs) || []).forEach(function (j) { map[j.id] = j.title || ''; });
        cursor = res && res.cursor;
      } while (cursor);
      return map;
    },
  };
}

// ===================== シート =====================

function ensureSheets_(ss) {
  var settings = sheet_(ss, SHEETS.settings, ['項目', '値', '説明']);
  var labels = settings.getLastRow() > 1 ? settings.getRange(2, 1, settings.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  SETTING_ROWS.forEach(function (row) {
    if (labels.indexOf(row[1]) >= 0) return;
    settings.appendRow([row[1], row[2], row[3]]);
    labels.push(row[1]);
  });
  sheet_(ss, SHEETS.stores, ['ロケーションID', '店舗名', '書き込み先カレンダー（空欄＝既定）']);
  sheet_(ss, SHEETS.staff, ['チームメンバーID', '氏名', 'Squareのメール', '本人カレンダー（Gmail）', '状態']);
  sheet_(ss, SHEETS.log, ['日時', '種類', '結果']);
  var rec = sheet_(ss, SHEETS.records, RECORD_HEADER);
  rec.getRange(1, 1, 1, RECORD_HEADER.length).setValues([RECORD_HEADER]); // 列が増えた場合に備えて見出しを更新
  if (!rec.isSheetHidden()) rec.hideSheet();
}

/** 見た目と入力補助（初期設定のときだけ） */
function formatSheets_(ss) {
  settingCell_(ss, 'env').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['本番', 'サンドボックス'], true).build());
  ['syncNow', 'reload'].forEach(function (k) {
    var c = settingCell_(ss, k);
    c.insertCheckboxes();
    if (!isChecked_(c.getValue())) c.setValue(false);
  });
  var settings = ss.getSheetByName(SHEETS.settings);
  settings.setColumnWidth(1, 180);
  settings.setColumnWidth(2, 260);
  settings.setColumnWidth(3, 420);
  ss.getSheetByName(SHEETS.staff).setColumnWidth(4, 220).setColumnWidth(5, 320);
  ss.getSheetByName(SHEETS.stores).setColumnWidth(3, 260);
  ss.getSheetByName(SHEETS.log).setColumnWidth(3, 480);
}

function sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function settingLabel_(key) {
  for (var i = 0; i < SETTING_ROWS.length; i++) if (SETTING_ROWS[i][0] === key) return SETTING_ROWS[i][1];
  throw new Error('unknown setting ' + key);
}

function settingCell_(ss, key) {
  var sh = ss.getSheetByName(SHEETS.settings);
  var label = settingLabel_(key);
  var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < values.length; i++) if (values[i][0] === label) return sh.getRange(i + 1, 2);
  throw new Error('設定「' + label + '」が見つかりません。setup を実行してください');
}

function getSetting_(ss, key) {
  return settingCell_(ss, key).getValue();
}

function setSetting_(ss, key, value) {
  settingCell_(ss, key).setValue(value);
}

function readConfig_(ss) {
  var days = Number(getSetting_(ss, 'days')) || 30;
  var title = String(getSetting_(ss, 'title') || '【出勤】{name}');
  var defaultCalId = resolveCalendarName_(String(getSetting_(ss, 'defaultCal') || ''));
  if (defaultCalId === null) defaultCalId = CalendarApp.getDefaultCalendar().getId();
  return {
    env: getSetting_(ss, 'env') === 'サンドボックス' ? 'sandbox' : 'production',
    days: Math.min(Math.max(days, 1), 180),
    title: title,
    defaultCalId: defaultCalId,
  };
}

/** 表示名 → カレンダーID。空欄 = null（既定）、「書き込まない」= '' */
function resolveCalendarName_(name) {
  name = String(name || '').trim();
  if (!name) return null;
  if (name === NONE_LABEL) return '';
  var cals = ownedCalendars_();
  for (var i = 0; i < cals.length; i++) {
    if (calendarLabel_(cals[i]) === name || cals[i].getName() === name || cals[i].getId() === name) return cals[i].getId();
  }
  return name; // IDを直接書いた場合
}

var ownedCalendarsCache_ = null;
var defaultCalendarIdCache_ = null;
function ownedCalendars_() {
  if (!ownedCalendarsCache_) ownedCalendarsCache_ = CalendarApp.getAllOwnedCalendars();
  return ownedCalendarsCache_;
}

function calendarLabel_(cal) {
  if (!defaultCalendarIdCache_) defaultCalendarIdCache_ = CalendarApp.getDefaultCalendar().getId();
  var isMain = cal.getId() === defaultCalendarIdCache_;
  return cal.getName() + (isMain ? MAIN_LABEL_SUFFIX : '');
}

/** 店舗カレンダーの選択肢（このアカウントが持っているカレンダー）をプルダウンに設定 */
function refreshCalendarChoices_(ss) {
  var labels = ownedCalendars_().map(calendarLabel_);
  labels.push(NONE_LABEL);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(labels, true).setAllowInvalid(true).build();
  settingCell_(ss, 'defaultCal').setDataValidation(rule);
  var stores = ss.getSheetByName(SHEETS.stores);
  stores.getRange(2, 3, Math.max(stores.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

/** Squareのスタッフ・店舗をシートに反映（手入力した列は残す） */
function loadMasters_(ss) {
  ensureSheets_(ss);
  var api = squareApi_(getToken_(), readConfig_(ss).env);
  upsertMasterSheets_(ss, api.listTeamMembers(), api.listLocations());
  refreshCalendarChoices_(ss);
}

function upsertMasterSheets_(ss, members, locations) {
  var stores = ss.getSheetByName(SHEETS.stores);
  upsertRows_(stores, Object.keys(locations).map(function (id) { return [id, locations[id]]; }), 2);

  var staff = ss.getSheetByName(SHEETS.staff);
  var active = members.filter(function (m) { return m.status !== 'INACTIVE'; });
  upsertRows_(staff, active.map(function (m) { return [m.id, memberName_(m), m.email_address || '']; }), 3, function (row) {
    // 本人カレンダーが空なら、Squareのメールを初期値にする
    if (!row[3] && row[2]) row[3] = row[2];
    return row;
  });
}

/** 1列目のIDで照合し、先頭 n 列だけを更新。新しいIDは末尾に追加 */
function upsertRows_(sh, rows, n, fill) {
  var width = sh.getLastColumn();
  var last = sh.getLastRow();
  var existing = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  var index = {};
  existing.forEach(function (r, i) { index[r[0]] = i; });
  rows.forEach(function (r) {
    var i = index[r[0]];
    if (i === undefined) {
      var row = r.slice();
      while (row.length < width) row.push('');
      existing.push(fill ? fill(row) : row);
      index[r[0]] = existing.length - 1;
    } else {
      for (var c = 0; c < n; c++) existing[i][c] = r[c];
      if (fill) existing[i] = fill(existing[i]);
    }
  });
  if (existing.length) sh.getRange(2, 1, existing.length, width).setValues(existing);
}

function readStaffCalendars_(ss) {
  var sh = ss.getSheetByName(SHEETS.staff);
  var map = {};
  if (sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
    if (r[0]) map[r[0]] = String(r[3] || '').trim();
  });
  return map;
}

function readStoreCalendars_(ss) {
  var sh = ss.getSheetByName(SHEETS.stores);
  var map = {};
  if (sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    if (!r[0]) return;
    var id = resolveCalendarName_(r[2]);
    if (id !== null) map[r[0]] = id;
  });
  return map;
}

function writeStaffStatus_(ss, ctx) {
  var sh = ss.getSheetByName(SHEETS.staff);
  if (sh.getLastRow() < 2) return;
  var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var statuses = ids.map(function (r) {
    if (!r[0]) return [''];
    var info = staffInfo_(r[0], ctx);
    if (info.calendarWritable) return ['✓ 本人カレンダーに直接書き込み'];
    if (info.email && ctx.denied[info.email]) return ['△ 共有の権限が「予定の変更」ではありません（招待メールで送信）'];
    if (info.email) return ['△ カレンダー共有が未設定（招待メールで送信）'];
    return ['✗ 送信先なし（本人カレンダーのGmailを入力してください）'];
  });
  sh.getRange(2, 5, statuses.length, 1).setValues(statuses);
}

function writeLog_(ss, trigger, text) {
  var sh = ss.getSheetByName(SHEETS.log);
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 3).setValues([[new Date(), trigger, text]]);
  var max = 300;
  if (sh.getLastRow() > max + 1) sh.deleteRows(max + 2, sh.getLastRow() - max - 1);
}

// ---------- 同期記録（シフト ↔ 予定の対応表。非表示シート） ----------

function loadRecords_(ss) {
  var sh = ss.getSheetByName(SHEETS.records);
  var map = {};
  if (sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, RECORD_HEADER.length).getValues().forEach(function (r) {
    if (!r[0]) return;
    map[r[0]] = {
      key: r[0], shiftId: r[1], target: r[2], calId: r[3], eventId: r[4], hash: r[5], status: r[6],
      start: asIso_(r[7]), teamMemberId: r[8], guests: r[9], note: r[10], locationId: r[12] || '', end: asIso_(r[13]),
    };
  });
  return map;
}

function saveRecords_(ss, records, now) {
  var sh = ss.getSheetByName(SHEETS.records);
  var cutoff = now.getTime() - 60 * 24 * 3600 * 1000;
  var rows = Object.keys(records)
    .map(function (k) { return records[k]; })
    .filter(function (r) {
      var t = new Date(r.start).getTime();
      return !(t < cutoff || (r.status === 'deleted' && t < now.getTime()));
    })
    .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); })
    .map(function (r) {
      return [r.key, r.shiftId, r.target, r.calId || '', r.eventId || '', r.hash || '', r.status, "'" + (r.start || ''),
        r.teamMemberId || '', r.guests || '', r.note || '', new Date(), r.locationId || '', "'" + (r.end || '')];
    });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, RECORD_HEADER.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, RECORD_HEADER.length).setValues(rows);
}

// 閲覧のみ共有のカレンダーを覚えておく（6時間）
function loadDenied_() {
  try {
    var raw = CacheService.getScriptCache().get('denied');
    var map = raw ? JSON.parse(raw) : {};
    var out = {};
    Object.keys(map).forEach(function (k) { if (Date.now() - map[k] < 6 * 3600 * 1000) out[k] = map[k]; });
    return out;
  } catch (e) {
    return {};
  }
}

function saveDenied_(denied) {
  CacheService.getScriptCache().put('denied', JSON.stringify(denied), 6 * 3600);
}

// ===================== トークン・トリガー =====================

function getToken_() {
  return PropertiesService.getScriptProperties().getProperty('SQUARE_ACCESS_TOKEN') || '';
}

/** シートに貼られたトークンをスクリプトの保存領域へ移し、シートからは消す */
function moveTokenFromSheet_(ss) {
  var cell = settingCell_(ss, 'token');
  var v = String(cell.getValue() || '').trim();
  if (!v || v === TOKEN_SAVED) {
    if (!v && getToken_()) cell.setValue(TOKEN_SAVED);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('SQUARE_ACCESS_TOKEN', v);
  cell.setValue(TOKEN_SAVED);
}

function installTriggers_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'syncShifts' || f === 'handleEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncShifts').timeBased().everyMinutes(SYNC_EVERY_MINUTES).create();
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
}

// ===================== 小物 =====================

function memberName_(m) {
  if (!m) return '';
  return [m.family_name, m.given_name].filter(function (x) { return x; }).join(' ');
}

function indexBy_(list, key) {
  var map = {};
  list.forEach(function (x) { map[x[key]] = x; });
  return map;
}

function merge_(a, b) {
  var out = {};
  Object.keys(a || {}).forEach(function (k) { out[k] = a[k]; });
  Object.keys(b || {}).forEach(function (k) { out[k] = b[k]; });
  return out;
}

function hash_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function asIso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}

function isChecked_(v) {
  return v === true || v === 'TRUE';
}

function errorText_(err) {
  return String(err && err.message ? err.message : err).slice(0, 300);
}
