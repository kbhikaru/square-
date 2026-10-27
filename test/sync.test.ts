import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANY, Store, staffKey, type AccountKey } from "../src/db.ts";
import { GoogleAccountUnavailableError, type CalendarEvent, type CalendarGateway } from "../src/google.ts";
import type { ScheduledShift, TeamMember } from "../src/square.ts";
import { SyncService, buildStaffEvent, buildStoreEvent, eventIdForShift } from "../src/sync.ts";

const settings = {
  daysAhead: 30,
  defaultTimezone: "Asia/Tokyo",
  titleTemplate: "【出勤】{name}",
  locationIds: [],
  defaultStoreCalendarId: "default-store@group.calendar.google.com",
};

const tokens = { refreshToken: "r", accessToken: "a", expiresAt: Date.now() + 3600_000 };

function shift(id: string, over: Partial<NonNullable<ScheduledShift["published_shift_details"]>> = {}): ScheduledShift {
  return {
    id,
    published_shift_details: {
      team_member_id: "tm1",
      location_id: "loc1",
      job_id: "job1",
      start_at: "2026-11-01T09:00:00+09:00",
      end_at: "2026-11-01T17:00:00+09:00",
      timezone: "Asia/Tokyo",
      notes: "レジ担当",
      ...over,
    },
  };
}

type Call = { op: "upsert" | "delete"; account: AccountKey; calendarId: string; id: string; event?: CalendarEvent };

/** Googleカレンダーの代わり。アカウント×カレンダーごとに予定を持つ */
class FakeCalendar implements CalendarGateway {
  calls: Call[] = [];
  events = new Map<string, CalendarEvent>(); // key: account|calendar|eventId
  unavailable = new Set<AccountKey>();
  failNext: Error | null = null;

  async upsertEvent(account: AccountKey, calendarId: string, event: CalendarEvent) {
    if (this.unavailable.has(account)) throw new GoogleAccountUnavailableError(account, "revoked");
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.calls.push({ op: "upsert", account, calendarId, id: event.id, event });
    this.events.set(`${account}|${calendarId}|${event.id}`, event);
  }
  async deleteEvent(account: AccountKey, calendarId: string, id: string) {
    if (this.unavailable.has(account)) throw new GoogleAccountUnavailableError(account, "revoked");
    this.calls.push({ op: "delete", account, calendarId, id });
    this.events.delete(`${account}|${calendarId}|${id}`);
  }
  in(account: AccountKey, calendarId: string): CalendarEvent[] {
    const prefix = `${account}|${calendarId}|`;
    return [...this.events].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }
}

function setup(opts: { shifts?: ScheduledShift[]; members?: TeamMember[]; company?: boolean } = {}) {
  const store = new Store(":memory:");
  if (opts.company !== false) store.saveGoogleAccount(COMPANY, { email: "shop@example.com", ...tokens });
  const state = {
    shifts: opts.shifts ?? [],
    members: opts.members ?? [
      { id: "tm1", given_name: "花子", family_name: "山田", email_address: "hanako@example.com" },
      { id: "tm2", given_name: "太郎", family_name: "佐藤", email_address: null },
    ],
  };
  const cal = new FakeCalendar();
  const square = {
    searchPublishedShifts: async () => state.shifts,
    getScheduledShift: async (id: string) => state.shifts.find((s) => s.id === id) ?? null,
    listTeamMembers: async () => state.members,
    listLocations: async () => new Map([["loc1", "渋谷店"], ["loc2", "新宿店"]]),
    listJobs: async () => new Map([["job1", "ホール"]]),
  };
  const sync = new SyncService({ store, square, calendar: cal, settings });
  const linkStaff = (tmId: string, email = `${tmId}@gmail.com`) => store.saveGoogleAccount(staffKey(tmId), { email, ...tokens });
  return { store, state, cal, sync, linkStaff };
}

const STORE_CAL = settings.defaultStoreCalendarId;

// ---------------- 予定の中身 ----------------

test("予定IDはGoogleで使える文字だけで、店舗用と本人用で別になる", () => {
  const a = eventIdForShift("SHIFT_abc-123", "store");
  const b = eventIdForShift("SHIFT_abc-123", "staff");
  assert.match(a, /^[a-v0-9]{5,1024}$/);
  assert.match(b, /^[a-v0-9]{5,1024}$/);
  assert.notEqual(a, b);
  assert.equal(a, eventIdForShift("SHIFT_abc-123", "store"));
});

test("タイトルは本人用・店舗用とも「【出勤】氏名」", () => {
  const ctx = {
    shift: shift("s1"),
    member: { id: "tm1", given_name: "花子", family_name: "山田" },
    locationName: "渋谷店",
    jobTitle: "ホール",
    settings,
  };
  const staff = buildStaffEvent(ctx);
  assert.equal(staff.summary, "【出勤】山田 花子");
  assert.equal(staff.location, "渋谷店");
  assert.equal(staff.attendees, undefined);
  assert.deepEqual(staff.start, { dateTime: "2026-11-01T09:00:00+09:00", timeZone: "Asia/Tokyo" });
  assert.match(staff.description!, /メモ: レジ担当/);

  const store = buildStoreEvent({ ...ctx, inviteEmail: null });
  assert.equal(store.summary, "【出勤】山田 花子");
  assert.deepEqual(store.attendees, []);
  assert.deepEqual(buildStoreEvent({ ...ctx, inviteEmail: "x@example.com" }).attendees, [{ email: "x@example.com", displayName: "山田 花子" }]);
});

test("タイトルのひな形で店舗名・職種も入れられる（空の項目は詰める）", () => {
  const ctx = { shift: shift("s1"), member: { id: "tm1", given_name: "花子", family_name: "山田" }, locationName: "渋谷店", jobTitle: undefined };
  assert.equal(buildStaffEvent({ ...ctx, settings: { ...settings, titleTemplate: "【出勤】{name} {location}" } }).summary, "【出勤】山田 花子 渋谷店");
  assert.equal(buildStaffEvent({ ...ctx, settings: { ...settings, titleTemplate: "【出勤】{name} / {job}" } }).summary, "【出勤】山田 花子");
});

// ---------------- 書き込み先 ----------------

test("連携済みスタッフ: 本人のカレンダーと店舗カレンダーの両方に書き込み、招待は送らない", async () => {
  const { sync, cal, linkStaff, store } = setup({ shifts: [shift("s1")] });
  linkStaff("tm1");
  const r = await sync.syncRange("test");
  assert.equal(r.created, 2);

  const mine = cal.in(staffKey("tm1"), "primary");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].summary, "【出勤】山田 花子");

  const shop = cal.in(COMPANY, STORE_CAL);
  assert.equal(shop.length, 1);
  assert.deepEqual(shop[0].attendees, []); // 本人に直接入るので招待は不要

  assert.equal(store.getShiftEvent("s1", "staff")?.status, "synced");
  assert.equal(store.getShiftEvent("s1", "store")?.status, "synced");
});

test("未連携スタッフ: 店舗カレンダーの予定から、メールアドレスに招待を送る", async () => {
  const { sync, cal } = setup({ shifts: [shift("s1")] });
  const r = await sync.syncRange("test");
  assert.equal(r.created, 1);
  assert.equal(cal.in(staffKey("tm1"), "primary").length, 0);
  assert.deepEqual(cal.in(COMPANY, STORE_CAL)[0].attendees?.map((a) => a.email), ["hanako@example.com"]);
});

test("店舗ごとに書き込み先カレンダーを分けられる／書き込まない設定もできる", async () => {
  const { sync, cal, store, state } = setup({ shifts: [shift("s1"), shift("s2", { location_id: "loc2" })] });
  store.setLocationCalendar("loc1", "shibuya@group.calendar.google.com");
  store.setLocationCalendar("loc2", "");
  await sync.syncRange("test");
  assert.equal(cal.in(COMPANY, "shibuya@group.calendar.google.com").length, 1);
  assert.equal(cal.in(COMPANY, STORE_CAL).length, 0);

  // 店舗を変更 → 古いカレンダーから消えて新しい方に入る
  store.setLocationCalendar("loc2", "shinjuku@group.calendar.google.com");
  state.shifts = [shift("s1", { location_id: "loc2" }), shift("s2", { location_id: "loc2" })];
  await sync.syncRange("test");
  assert.equal(cal.in(COMPANY, "shibuya@group.calendar.google.com").length, 0);
  assert.equal(cal.in(COMPANY, "shinjuku@group.calendar.google.com").length, 2);
});

test("会社アカウント未連携でも、連携済みスタッフ本人のカレンダーには入る", async () => {
  const { sync, cal, linkStaff } = setup({ shifts: [shift("s1")], company: false });
  linkStaff("tm1");
  const r = await sync.syncRange("test");
  assert.equal(r.created, 1);
  assert.equal(cal.in(staffKey("tm1"), "primary").length, 1);
});

// ---------------- 変更・削除 ----------------

test("2回目は変更なし、時間変更は両方とも同じ予定IDで更新", async () => {
  const { sync, cal, state, linkStaff } = setup({ shifts: [shift("s1")] });
  linkStaff("tm1");
  await sync.syncRange("test");
  assert.equal((await sync.syncRange("test")).unchanged, 2);

  state.shifts = [shift("s1", { end_at: "2026-11-01T18:00:00+09:00" })];
  const r = await sync.syncRange("test");
  assert.equal(r.updated, 2);
  assert.equal(cal.in(staffKey("tm1"), "primary")[0].end.dateTime, "2026-11-01T18:00:00+09:00");
  assert.equal(cal.in(COMPANY, STORE_CAL)[0].end.dateTime, "2026-11-01T18:00:00+09:00");
});

test("シフト削除で両方の予定が消える（検索結果から消えた場合も）", async () => {
  const { sync, cal, state, linkStaff } = setup({ shifts: [shift("s1")] });
  linkStaff("tm1");
  const now = new Date("2026-10-30T00:00:00Z");
  await sync.syncRange("test", now);
  state.shifts = [];
  const r = await sync.syncRange("test", now);
  assert.equal(r.deleted, 2);
  assert.equal(cal.events.size, 0);
});

test("担当者が変わると、前の人のカレンダーから消えて新しい人のカレンダーに入る", async () => {
  const { sync, cal, state, linkStaff } = setup({
    shifts: [shift("s1")],
    members: [
      { id: "tm1", email_address: "a@example.com" },
      { id: "tm3", email_address: "b@example.com" },
    ],
  });
  linkStaff("tm1");
  linkStaff("tm3");
  await sync.syncRange("test");
  state.shifts = [shift("s1", { team_member_id: "tm3" })];
  await sync.syncRange("test");
  assert.equal(cal.in(staffKey("tm1"), "primary").length, 0);
  assert.equal(cal.in(staffKey("tm3"), "primary").length, 1);
  assert.equal(cal.in(COMPANY, STORE_CAL).length, 1);
});

test("あとから本人が連携すると、招待方式から直接書き込みに切り替わる", async () => {
  const { sync, cal, linkStaff } = setup({ shifts: [shift("s1")] });
  await sync.syncRange("test");
  assert.equal(cal.in(COMPANY, STORE_CAL)[0].attendees?.length, 1);

  linkStaff("tm1");
  await sync.syncRange("test");
  assert.deepEqual(cal.in(COMPANY, STORE_CAL)[0].attendees, []);
  assert.equal(cal.in(staffKey("tm1"), "primary").length, 1);
});

test("連携解除: 本人のカレンダーから今後の予定を消し、店舗側は招待方式に戻る", async () => {
  const { sync, cal, store, linkStaff } = setup({ shifts: [shift("s1")] });
  linkStaff("tm1");
  await sync.syncRange("test");

  const removed = await sync.removeStaffEvents("tm1", new Date("2026-10-01T00:00:00Z"));
  assert.equal(removed, 1);
  assert.equal(cal.in(staffKey("tm1"), "primary").length, 0);
  store.deleteGoogleAccount(staffKey("tm1"));

  await sync.syncRange("test");
  assert.deepEqual(cal.in(COMPANY, STORE_CAL)[0].attendees?.map((a) => a.email), ["hanako@example.com"]);
});

test("本人がGoogle側で連携を取り消していても、同期全体は止まらない", async () => {
  const { sync, cal, store, linkStaff, state } = setup({ shifts: [shift("s1")] });
  linkStaff("tm1");
  await sync.syncRange("test");
  cal.unavailable.add(staffKey("tm1"));
  store.markGoogleAccountInvalid(staffKey("tm1")); // getAccessToken が invalid_grant で行う処理
  state.shifts = [shift("s1", { notes: "変更" })];
  const r = await sync.syncRange("test");
  assert.equal(r.error, 0);
  // 店舗側は招待方式に切り替わる
  assert.deepEqual(cal.in(COMPANY, STORE_CAL)[0].attendees?.map((a) => a.email), ["hanako@example.com"]);
});

test("未連携かつメール未登録は『送信先なし』として記録、店舗カレンダーには入る", async () => {
  const { sync, cal, store } = setup({ shifts: [shift("s1", { team_member_id: "tm2" })] });
  const r = await sync.syncRange("test");
  assert.equal(r.no_email, 1);
  assert.equal(store.getShiftEvent("s1", "staff")?.status, "no_email");
  assert.deepEqual(cal.in(COMPANY, STORE_CAL)[0].attendees, []);
});

test("管理画面で設定した招待先がSquareのメールより優先される", async () => {
  const { sync, cal, store } = setup({ shifts: [shift("s1", { team_member_id: "tm2" })] });
  store.setEmailOverride("tm2", "taro@gmail.com");
  await sync.syncRange("test");
  assert.deepEqual(cal.in(COMPANY, STORE_CAL)[0].attendees?.map((a) => a.email), ["taro@gmail.com"]);
});

test("Googleのエラーは記録され、次回の同期で再試行される", async () => {
  const { sync, cal, store } = setup({ shifts: [shift("s1")] });
  cal.failNext = new Error("boom");
  const r1 = await sync.syncRange("test");
  assert.equal(r1.error, 1);
  assert.match(r1.errors[0], /boom/);
  assert.equal(store.getShiftEvent("s1", "store")?.status, "error");

  const r2 = await sync.syncRange("test");
  assert.equal(r2.error, 0);
  assert.equal(store.getShiftEvent("s1", "store")?.status, "synced");
});

test("Webhook用の1件同期: 削除イベントで両方の予定が消える", async () => {
  const { sync, cal, linkStaff } = setup({ shifts: [shift("s1")] });
  linkStaff("tm1");
  assert.deepEqual(await sync.syncShiftById("s1"), { store: "created", staff: "created" });
  assert.deepEqual(await sync.syncShiftById("s1", null), { store: "deleted", staff: "deleted" });
  assert.equal(cal.events.size, 0);
});
