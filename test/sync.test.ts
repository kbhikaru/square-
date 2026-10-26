import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import type { CalendarApi, CalendarEvent } from "../src/google.ts";
import type { ScheduledShift, TeamMember } from "../src/square.ts";
import { SyncService, buildEvent, eventIdForShift } from "../src/sync.ts";

const settings = { daysAhead: 30, defaultTimezone: "Asia/Tokyo", titlePrefix: "【シフト】", locationIds: [] };

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

function setup(opts: { shifts?: ScheduledShift[]; members?: TeamMember[] } = {}) {
  const store = new Store(":memory:");
  const state = {
    shifts: opts.shifts ?? [],
    members: opts.members ?? [
      { id: "tm1", given_name: "花子", family_name: "山田", email_address: "hanako@example.com" },
      { id: "tm2", given_name: "太郎", family_name: "佐藤", email_address: null },
    ],
  };
  const calls: { op: "upsert" | "delete"; id: string; event?: CalendarEvent }[] = [];
  const calendar: CalendarApi = {
    async upsertEvent(event) {
      calls.push({ op: "upsert", id: event.id, event });
    },
    async deleteEvent(id) {
      calls.push({ op: "delete", id });
    },
  };
  const square = {
    async searchPublishedShifts() {
      return state.shifts;
    },
    async getScheduledShift(id: string) {
      return state.shifts.find((s) => s.id === id) ?? null;
    },
    async listTeamMembers() {
      return state.members;
    },
    async listLocations() {
      return new Map([["loc1", "渋谷店"]]);
    },
    async listJobs() {
      return new Map([["job1", "ホール"]]);
    },
  };
  const sync = new SyncService({ store, square, calendar: () => calendar, settings });
  return { store, state, calls, sync };
}

test("eventIdForShift はGoogleで使える文字だけで、毎回同じIDになる", () => {
  const id = eventIdForShift("SHIFT_abc-123");
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.equal(id, eventIdForShift("SHIFT_abc-123"));
  assert.notEqual(id, eventIdForShift("SHIFT_abc-124"));
});

test("buildEvent: タイトル・時間・招待先が正しく入る", () => {
  const e = buildEvent({
    shift: shift("s1"),
    email: "hanako@example.com",
    member: { id: "tm1", given_name: "花子", family_name: "山田" },
    locationName: "渋谷店",
    jobTitle: "ホール",
    settings,
  });
  assert.equal(e.summary, "【シフト】渋谷店 / ホール");
  assert.deepEqual(e.start, { dateTime: "2026-11-01T09:00:00+09:00", timeZone: "Asia/Tokyo" });
  assert.deepEqual(e.attendees, [{ email: "hanako@example.com", displayName: "山田 花子" }]);
  assert.match(e.description!, /メモ: レジ担当/);
  assert.equal(e.extendedProperties?.private?.squareShiftId, "s1");
});

test("新規シフトは招待され、2回目は変更なしでスキップ", async () => {
  const { sync, calls, store } = setup({ shifts: [shift("s1")] });
  const r1 = await sync.syncRange("test");
  assert.equal(r1.created, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event?.attendees[0].email, "hanako@example.com");
  assert.equal(store.getShiftEvent("s1")?.status, "synced");

  const r2 = await sync.syncRange("test");
  assert.equal(r2.unchanged, 1);
  assert.equal(calls.length, 1);
});

test("時間変更は同じ予定IDで更新される", async () => {
  const { sync, calls, state } = setup({ shifts: [shift("s1")] });
  await sync.syncRange("test");
  state.shifts = [shift("s1", { end_at: "2026-11-01T18:00:00+09:00" })];
  const r = await sync.syncRange("test");
  assert.equal(r.updated, 1);
  assert.equal(calls[1].op, "upsert");
  assert.equal(calls[1].id, calls[0].id);
  assert.equal(calls[1].event?.end.dateTime, "2026-11-01T18:00:00+09:00");
});

test("is_deleted になったシフトは予定を削除", async () => {
  const { sync, calls, state, store } = setup({ shifts: [shift("s1")] });
  await sync.syncRange("test");
  state.shifts = [shift("s1", { is_deleted: true })];
  const r = await sync.syncRange("test");
  assert.equal(r.deleted, 1);
  assert.deepEqual(calls.at(-1), { op: "delete", id: eventIdForShift("s1") });
  assert.equal(store.getShiftEvent("s1")?.status, "deleted");
});

test("検索結果から消えたシフトも個別に確認して削除", async () => {
  const { sync, calls, state } = setup({ shifts: [shift("s1")] });
  await sync.syncRange("test", new Date("2026-10-30T00:00:00Z"));
  state.shifts = [];
  const r = await sync.syncRange("test", new Date("2026-10-30T00:00:00Z"));
  assert.equal(r.deleted, 1);
  assert.equal(calls.at(-1)?.op, "delete");
});

test("メール未登録スタッフは招待せず no_email として記録", async () => {
  const { sync, calls, store } = setup({ shifts: [shift("s1", { team_member_id: "tm2" })] });
  const r = await sync.syncRange("test");
  assert.equal(r.no_email, 1);
  assert.equal(calls.length, 0);
  assert.equal(store.getShiftEvent("s1")?.status, "no_email");
});

test("管理画面で設定した招待先がSquareのメールより優先される", async () => {
  const { sync, calls, store } = setup({ shifts: [shift("s1", { team_member_id: "tm2" })] });
  store.setEmailOverride("tm2", "taro@gmail.com");
  const r = await sync.syncRange("test");
  assert.equal(r.created, 1);
  assert.equal(calls[0].event?.attendees[0].email, "taro@gmail.com");
});

test("担当者が別スタッフに変わると招待先が差し替わる", async () => {
  const { sync, calls, state } = setup({
    shifts: [shift("s1")],
    members: [
      { id: "tm1", email_address: "a@example.com" },
      { id: "tm3", email_address: "b@example.com" },
    ],
  });
  await sync.syncRange("test");
  state.shifts = [shift("s1", { team_member_id: "tm3" })];
  const r = await sync.syncRange("test");
  assert.equal(r.updated, 1);
  assert.equal(calls.at(-1)?.event?.attendees[0].email, "b@example.com");
});

test("Googleのエラーは記録され、次回の同期で再試行される", async () => {
  const { store, state } = setup();
  state.shifts = [shift("s1")];
  let fail = true;
  const calendar: CalendarApi = {
    async upsertEvent() {
      if (fail) throw new Error("boom");
    },
    async deleteEvent() {},
  };
  const sync = new SyncService({
    store,
    square: {
      searchPublishedShifts: async () => state.shifts,
      getScheduledShift: async () => null,
      listTeamMembers: async () => state.members,
      listLocations: async () => new Map(),
      listJobs: async () => new Map(),
    },
    calendar: () => calendar,
    settings,
  });
  const r1 = await sync.syncRange("test");
  assert.equal(r1.error, 1);
  assert.match(r1.errors[0], /boom/);
  assert.equal(store.getShiftEvent("s1")?.status, "error");

  fail = false;
  const r2 = await sync.syncRange("test");
  assert.equal(r2.error, 0);
  assert.equal(store.getShiftEvent("s1")?.status, "synced");
});

test("Webhook用の1件同期: 削除イベントで予定が消える", async () => {
  const { sync, calls } = setup({ shifts: [shift("s1")] });
  assert.equal(await sync.syncShiftById("s1"), "created");
  assert.equal(await sync.syncShiftById("s1", null), "deleted");
  assert.equal(calls.at(-1)?.op, "delete");
});
