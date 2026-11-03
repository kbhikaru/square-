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
