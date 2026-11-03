import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeCalendar, loadGas, type Shift } from "./gas-fakes.ts";

const NOW = new Date("2026-11-01T00:00:00Z");

function shift(id: string, over: Record<string, unknown> = {}): Shift {
  return {
    id,
    published_shift_details: {
      team_member_id: "tm1",
      location_id: "loc1",
      job_id: "job1",
      start_at: "2026-11-02T09:00:00+09:00",
      end_at: "2026-11-02T17:00:00+09:00",
      timezone: "Asia/Tokyo",
      notes: "レジ担当",
      ...over,
    },
  };
}

/** setup 済み・トークン設定済みの状態を作る */
function ready() {
  const env = loadGas();
  const { gas, ss, square, calendar } = env;
  square.members = [
    { id: "tm1", family_name: "山田", given_name: "花子", email_address: "hanako@gmail.com", status: "ACTIVE" },
    { id: "tm2", family_name: "佐藤", given_name: "太郎", email_address: "taro@gmail.com", status: "ACTIVE" },
    { id: "tm3", family_name: "鈴木", given_name: "次郎", email_address: null, status: "ACTIVE" },
  ];
  square.locations = [
    { id: "loc1", name: "渋谷店" },
    { id: "loc2", name: "新宿店" },
  ];
  square.jobs = [{ id: "job1", title: "ホール" }];
  const shibuya = calendar.add(new FakeCalendar("shibuya@group.calendar.google.com", "渋谷店シフト", true));
  const shinjuku = calendar.add(new FakeCalendar("shinjuku@group.calendar.google.com", "新宿店シフト", true));

  gas.setup();
  ss.setSetting("Squareアクセストークン", square.token);
  gas.handleEdit({ range: ss.sheet("設定").getRange(2, 2) });

  const sync = (now = NOW) => {
    gas.ownedCalendarsCache_ = null;
    return gas.runSync_(ss, "テスト", now) as string;
  };
  const setStoreCalendar = (locId: string, label: string) => {
    const sh = ss.sheet("店舗");
    for (let r = 2; r <= sh.getLastRow(); r++) if (sh.get(r, 1) === locId) return sh.set(r, 3, label);
    throw new Error("no store " + locId);
  };
  const staffRow = (tmId: string) => ss.sheet("スタッフ").rows().find((r) => r["チームメンバーID"] === tmId)!;
  return { ...env, shibuya, shinjuku, sync, setStoreCalendar, staffRow };
}

test("setup: シート・トリガーを作り、トークンはシートから隠して保存", () => {
  const { ss, props, triggers, setStoreCalendar } = ready();
  for (const name of ["設定", "店舗", "スタッフ", "同期ログ", "_同期記録"]) assert.ok(ss.getSheetByName(name), name);
  assert.equal(ss.sheet("_同期記録").hidden, true);
  assert.equal(props.get("SQUARE_ACCESS_TOKEN"), "EAAA-token");
  assert.match(String(ss.setting("Squareアクセストークン")), /設定済み/);
  assert.deepEqual(triggers.map((t) => t.handler).sort(), ["handleEdit", "syncShifts"]);

  // トークン設定時にスタッフ・店舗を読み込み、本人カレンダーはSquareのメールが初期値
  assert.equal(ss.sheet("店舗").rows().length, 2);
  setStoreCalendar("loc1", "渋谷店シフト");
  const staff = ss.sheet("スタッフ").rows();
  assert.equal(staff.length, 3);
  assert.equal(staff[0]["氏名"], "山田 花子");
  assert.equal(staff[0]["本人カレンダー（Gmail）"], "hanako@gmail.com");
});

test("setup をやり直しても、トリガーが二重にならない", () => {
  const { gas, triggers } = ready();
  gas.setup();
  assert.equal(triggers.length, 2);
});

test("共有済みスタッフ: 本人カレンダーと店舗カレンダーの両方に「【出勤】氏名」で入る", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square, staffRow } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];

  const msg = sync();
  assert.match(msg, /新規2/);

  const mine = hanako.list();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "【出勤】山田 花子");
  assert.equal(mine[0].start.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(mine[0].location, "渋谷店");
  assert.match(mine[0].description, /メモ: レジ担当/);
  assert.deepEqual(mine[0].guests, []);

  const shop = shibuya.list();
  assert.equal(shop.length, 1);
  assert.equal(shop[0].title, "【出勤】山田 花子");
  assert.deepEqual(shop[0].guests, []); // 本人に直接入るので招待しない
  assert.equal(shop[0].tags.squareShiftId, "s1");

  assert.match(String(staffRow("tm1")["状態"]), /直接書き込み/);
});

test("2回目は変更なし、時間変更は同じ予定を更新", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];
  sync();
  const firstId = hanako.list()[0].id;

  assert.match(sync(), /変更なし2/);

  square.shifts = [shift("s1", { end_at: "2026-11-02T18:00:00+09:00" })];
  assert.match(sync(), /更新2/);
  assert.equal(hanako.list().length, 1);
  assert.equal(hanako.list()[0].id, firstId);
  assert.equal(hanako.list()[0].end.toISOString(), "2026-11-02T09:00:00.000Z");
  assert.equal(shibuya.list()[0].end.toISOString(), "2026-11-02T09:00:00.000Z");
});

test("共有されていないスタッフ: 店舗カレンダーの予定から招待メールを送る", () => {
  const { sync, setStoreCalendar, shibuya, square, staffRow } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  square.shifts = [shift("s1", { team_member_id: "tm2" })];
  sync();
  const ev = shibuya.list()[0];
  assert.deepEqual(ev.guests, ["taro@gmail.com"]);
  assert.equal(ev.invitesSent, true);
  assert.match(String(staffRow("tm2")["状態"]), /共有が未設定/);
});

test("閲覧のみで共有されている: 招待に切り替え、エラーにはしない", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square, staffRow } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  calendar.share("hanako@gmail.com", "read");
  square.shifts = [shift("s1")];
  const msg = sync();
  assert.match(msg, /エラー0/);
  assert.deepEqual(shibuya.list()[0].guests, ["hanako@gmail.com"]);
  assert.match(String(staffRow("tm1")["状態"]), /予定の変更/);
});

test("あとから共有されると、招待をやめて本人カレンダーへ直接書き込みに切り替わる", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  square.shifts = [shift("s1")];
  sync();
  assert.deepEqual(shibuya.list()[0].guests, ["hanako@gmail.com"]);

  const hanako = calendar.share("hanako@gmail.com");
  sync();
  assert.deepEqual(shibuya.list()[0].guests, []);
  assert.equal(hanako.list().length, 1);
});

test("シフト削除・検索結果から消えたシフトは、両方の予定を削除", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1"), shift("s2", { start_at: "2026-11-03T09:00:00+09:00", end_at: "2026-11-03T17:00:00+09:00" })];
  sync();
  assert.equal(hanako.list().length, 2);

  square.shifts = [shift("s1", { is_deleted: true })]; // s1 は削除フラグ、s2 は消滅
  const msg = sync();
  assert.match(msg, /削除4/);
  assert.equal(hanako.list().length, 0);
  assert.equal(shibuya.list().length, 0);
});

test("担当者・店舗の変更で、前のカレンダーから消えて新しいカレンダーに入る", () => {
  const { calendar, sync, setStoreCalendar, shibuya, shinjuku, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  setStoreCalendar("loc2", "新宿店シフト");
  const hanako = calendar.share("hanako@gmail.com");
  const taro = calendar.share("taro@gmail.com");
  square.shifts = [shift("s1")];
  sync();

  square.shifts = [shift("s1", { team_member_id: "tm2", location_id: "loc2" })];
  sync();
  assert.equal(hanako.list().length, 0);
  assert.equal(taro.list().length, 1);
  assert.equal(taro.list()[0].title, "【出勤】佐藤 太郎");
  assert.equal(shibuya.list().length, 0);
  assert.equal(shinjuku.list().length, 1);
});

test("店舗の指定が無ければ既定（メイン）カレンダー、「書き込まない」なら店舗側は作らない", () => {
  const { calendar, ss, sync, setStoreCalendar, square } = ready();
  square.shifts = [shift("s1", { team_member_id: "tm2" }), shift("s2", { team_member_id: "tm2", location_id: "loc2" })];
  setStoreCalendar("loc2", "（書き込まない）");
  const msg = sync();
  assert.equal(calendar.main.list().length, 1);
  assert.match(msg, /送信先なし1/); // s2 は本人未共有・店舗なし → どこにも届かない

  ss.setSetting("既定の店舗カレンダー", "渋谷店シフト");
  sync();
  assert.equal(calendar.main.list().length, 0);
});

test("メール未登録で本人カレンダーも空のスタッフは「送信先なし」", () => {
  const { sync, setStoreCalendar, shibuya, square, staffRow } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  square.shifts = [shift("s1", { team_member_id: "tm3" })];
  assert.match(sync(), /送信先なし1/);
  assert.deepEqual(shibuya.list()[0].guests, []);
  assert.match(String(staffRow("tm3")["状態"]), /送信先なし/);
});

test("本人カレンダー欄を書き換えると、そのGmailに書き込む", () => {
  const { calendar, ss, sync, square } = ready();
  const other = calendar.share("hanako.work@gmail.com");
  const sh = ss.sheet("スタッフ");
  for (let r = 2; r <= sh.getLastRow(); r++) if (sh.get(r, 1) === "tm1") sh.set(r, 4, "hanako.work@gmail.com");
  square.shifts = [shift("s1")];
  sync();
  assert.equal(other.list().length, 1);
});

test("タイトルのひな形を変えられる", () => {
  const { calendar, ss, sync, square } = ready();
  const hanako = calendar.share("hanako@gmail.com");
  ss.setSetting("予定タイトル", "【出勤】{name} {location}");
  square.shifts = [shift("s1")];
  sync();
  assert.equal(hanako.list()[0].title, "【出勤】山田 花子 渋谷店");
});

test("トークン未設定・誤りはログに記録して止まる", () => {
  const { ss, sync, square } = ready();
  square.token = "other";
  const msg = sync();
  assert.match(msg, /アクセストークンが正しくありません/);
  assert.match(String(ss.sheet("同期ログ").rows()[0]["結果"]), /アクセストークン/);
});

test("スマホでチェックボックスを入れると同期が走り、チェックは外れる", () => {
  const { gas, ss, calendar, square } = ready();
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];
  ss.setSetting("今すぐ同期", true);
  const sh = ss.sheet("設定");
  let row = 0;
  for (let r = 2; r <= sh.getLastRow(); r++) if (sh.get(r, 1) === "今すぐ同期") row = r;
  gas.ownedCalendarsCache_ = null;
  gas.handleEdit({ range: sh.getRange(row, 2) });
  assert.equal(hanako.list().length, 1);
  assert.equal(ss.setting("今すぐ同期"), false);
  assert.match(String(ss.setting("最終同期")), /新規/);
});

test("共有が解除されたスタッフ: 本人側は消せないが、店舗側の招待に切り替わる", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];
  sync();
  calendar.unshare("hanako@gmail.com");
  const msg = sync();
  assert.match(msg, /エラー0/);
  assert.deepEqual(shibuya.list()[0].guests, ["hanako@gmail.com"]);
});

// ---------------- ダッシュボード ----------------

test("ダッシュボード: 集計・シフト一覧・スタッフ状態を返す", () => {
  const { gas, calendar, sync, setStoreCalendar, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  calendar.share("hanako@gmail.com");
  const base = Date.now();
  const at = (h: number) => new Date(base + h * 3600_000).toISOString();
  square.shifts = [
    shift("s1", { start_at: at(24), end_at: at(32) }),
    shift("s2", { team_member_id: "tm2", start_at: at(48), end_at: at(53) }),
  ];
  sync(new Date());
  const d = JSON.parse(JSON.stringify(gas.dashboardData()));

  assert.equal(d.settings.tokenSet, true);
  assert.equal(d.settings.autoSync, true);
  assert.equal(d.settings.title, "【出勤】{name}");
  assert.ok(d.calendarOptions.includes("渋谷店シフト"));
  assert.ok(d.calendarOptions.includes("（書き込まない）"));
  assert.equal(d.stores.length, 2);

  assert.equal(d.shifts.length, 2);
  const [a, b] = d.shifts;
  assert.equal(a.name, "山田 花子");
  assert.equal(a.location, "渋谷店");
  assert.equal(a.end, at(32));
  assert.equal(a.staff.status, "synced");
  assert.equal(b.store.guests, "taro@gmail.com");

  assert.equal(d.stats.upcoming, 2);
  assert.equal(d.stats.staffTotal, 3);
  assert.equal(d.stats.staffDirect, 1);
  assert.equal(d.stats.staffInvite, 1);
  assert.equal(d.stats.staffNone, 1);
  assert.equal(d.stats.storesUnset, 1);
  assert.equal(d.logs.length, 1);
});

test("ダッシュボード: 設定・店舗・スタッフの保存", () => {
  const { gas, ss, props, square } = ready();
  square.token = "NEW-TOKEN";
  gas.dashboardSaveSettings({ token: "NEW-TOKEN", env: "サンドボックス", days: "45", title: "【出勤】{name} {location}", defaultCal: "渋谷店シフト" });
  assert.equal(props.get("SQUARE_ACCESS_TOKEN"), "NEW-TOKEN");
  assert.equal(ss.setting("Square環境"), "サンドボックス");
  assert.equal(ss.setting("同期する日数"), 45);
  assert.equal(ss.setting("予定タイトル"), "【出勤】{name} {location}");
  assert.equal(ss.setting("既定の店舗カレンダー"), "渋谷店シフト");

  // トークン空欄なら変更しない
  gas.dashboardSaveSettings({ token: "", days: 30 });
  assert.equal(props.get("SQUARE_ACCESS_TOKEN"), "NEW-TOKEN");
  assert.throws(() => gas.dashboardSaveSettings({ days: 0 }), /1〜180/);
  assert.throws(() => gas.dashboardSaveSettings({ title: " " }), /タイトル/);

  const d1 = gas.dashboardSaveStore("loc2", "新宿店シフト");
  assert.equal(d1.stores.find((x: any) => x.id === "loc2").calendar, "新宿店シフト");

  const d2 = gas.dashboardSaveStaff("tm3", "jiro@gmail.com");
  assert.equal(d2.staff.find((x: any) => x.id === "tm3").calendar, "jiro@gmail.com");
  assert.throws(() => gas.dashboardSaveStaff("tm3", "not-an-email"), /形式/);
  assert.throws(() => gas.dashboardSaveStaff("nobody", "a@b.co"), /見つかりません/);
});

test("ダッシュボード: 今すぐ同期で結果と最新データを返す", () => {
  const { gas, calendar, square } = ready();
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1", { start_at: new Date(Date.now() + 86400000).toISOString(), end_at: new Date(Date.now() + 90000000).toISOString() })];
  gas.ownedCalendarsCache_ = null;
  const res = gas.dashboardSync();
  assert.match(res.message, /新規2/);
  assert.equal(res.data.shifts.length, 1);
  assert.equal(hanako.list().length, 1);
});

// ---------------- Google Meet ----------------

test("作成した予定から Google Meet を外す（本人・店舗とも）", () => {
  const { calendar, sync, setStoreCalendar, shibuya, square } = ready();
  setStoreCalendar("loc1", "渋谷店シフト");
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1"), shift("s2", { team_member_id: "tm2" })];
  sync();
  const all = [...hanako.list(), ...shibuya.list()];
  assert.equal(all.length, 3);
  assert.ok(all.every((e) => e.meet === false));
});

test("以前に作った予定の Meet も外し、外し終わったら確認をやめる", () => {
  const { calendar, sync, square, calendarApi, meetCalls } = ready();
  const hanako = calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];

  // Calendar API が無効な状態で作られた（Meet が残った）
  calendarApi.disabled = true;
  const first = sync();
  assert.equal(hanako.list()[0].meet, true);
  assert.match(first, /Meetの削除に失敗: Google Calendar API が無効です/);
  assert.match(first, /「サービス」の＋から「Google Calendar API」を追加/);

  // 有効になった次の同期でまとめて外れる
  calendarApi.disabled = false;
  const second = sync();
  assert.equal(hanako.list()[0].meet, false);
  assert.equal(calendar.main.list()[0].meet, false);
  assert.match(second, /Meet削除2/);
  assert.match(second, /エラー0/);

  // 全部外し終わったら、以降は既存の予定を確認しない
  const before = meetCalls.length;
  sync();
  assert.equal(meetCalls.length, before);
});

test("Meet が付いていない予定は上書きしない", () => {
  const { calendar, sync, square, meetCalls } = ready();
  calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];
  sync();
  const puts = meetCalls.filter((c) => c.startsWith("PUT")).length;
  assert.equal(puts, 2); // 新規作成の2件だけ
  meetCalls.length = 0;
  square.shifts = [shift("s1", { notes: "変更" })];
  sync();
  assert.equal(meetCalls.filter((c) => c.startsWith("PUT")).length, 0);
});

test("動作確認用の checkMeetRemoval が結果をログに出す", () => {
  const { gas, calendar, sync, square, calendarApi, logs } = ready();
  calendar.share("hanako@gmail.com");
  square.shifts = [shift("s1")];
  calendarApi.disabled = true;
  sync();
  gas.checkMeetRemoval();
  assert.match(logs.at(-1)!, /error[\s\S]*Google Calendar API が無効です/);
  calendarApi.disabled = false;
  gas.checkMeetRemoval();
  assert.match(logs.at(-1)!, /→ removed/);
});
