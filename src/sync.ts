import { createHash } from "node:crypto";
import { COMPANY, staffKey, type AccountKey, type EventTarget, type ShiftEventRow, type Store } from "./db.ts";
import { GoogleAccountUnavailableError, type CalendarEvent, type CalendarGateway } from "./google.ts";
import { teamMemberName, type ScheduledShift, type ScheduledShiftDetails, type SquareClient, type TeamMember } from "./square.ts";

export type SyncSettings = {
  daysAhead: number;
  defaultTimezone: string;
  /** 予定タイトルのひな形。{name}=氏名, {location}=店舗名, {job}=職種 */
  titleTemplate: string;
  locationIds: string[];
  /** 店舗ごとの設定が無い場合に使う、会社アカウント内のカレンダー */
  defaultStoreCalendarId: string;
};

export type TargetResult = "created" | "updated" | "unchanged" | "deleted" | "no_email" | "error";
export type ShiftResult = Partial<Record<EventTarget, TargetResult>>;

export type SyncSummary = Record<TargetResult, number> & { shifts: number; errors: string[] };

type SquareApi = Pick<SquareClient, "searchPublishedShifts" | "getScheduledShift" | "listTeamMembers" | "listLocations" | "listJobs">;

type Lookups = {
  members: Map<string, TeamMember>;
  locations: Map<string, string>;
  jobs: Map<string, string>;
  overrides: Map<string, string>;
  locationCalendars: Map<string, string>;
  linkedStaff: Set<string>;
  companyLinked: boolean;
};

/** 書き込み先1か所ぶんの「あるべき姿」 */
type Desired = { account: AccountKey; calendarId: string; event: CalendarEvent; attendeeEmail: string | null };

const TARGETS: EventTarget[] = ["store", "staff"];

/**
 * SquareのシフトIDから、Googleカレンダーの予定IDを決める（a-v,0-9のみ使用可）。
 * 店舗用とスタッフ用でIDを分ける（招待のコピーとIDが衝突しないように）
 */
export function eventIdForShift(shiftId: string, target: EventTarget = "store"): string {
  const seed = target === "store" ? shiftId : `staff:${shiftId}`;
  return (target === "store" ? "sq" : "sqs") + createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

type EventContext = {
  shift: ScheduledShift;
  member: TeamMember | undefined;
  locationName: string | undefined;
  jobTitle: string | undefined;
  settings: Pick<SyncSettings, "defaultTimezone" | "titleTemplate">;
};

function baseEvent(c: EventContext, target: EventTarget, summary: string): CalendarEvent {
  const d = c.shift.published_shift_details!;
  const tz = d.timezone || c.settings.defaultTimezone;
  const name = teamMemberName(c.member);
  const description = [
    name && `スタッフ: ${name}`,
    c.locationName && `店舗: ${c.locationName}`,
    c.jobTitle && `職種: ${c.jobTitle}`,
    d.notes && `メモ: ${d.notes}`,
    "",
    "※ Squareのシフトから自動作成された予定です。変更はSquare側で行ってください。",
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");
  return {
    id: eventIdForShift(c.shift.id, target),
    summary,
    description,
    location: c.locationName,
    start: { dateTime: d.start_at!, timeZone: tz },
    end: { dateTime: d.end_at!, timeZone: tz },
    extendedProperties: { private: { squareShiftId: c.shift.id } },
  };
}

/** 予定タイトル（既定は「【出勤】氏名」）。本人用・店舗用で共通 */
export function eventTitle(c: EventContext): string {
  const values: Record<string, string> = {
    name: teamMemberName(c.member) || "スタッフ",
    location: c.locationName ?? "",
    job: c.jobTitle ?? "",
  };
  const title = c.settings.titleTemplate
    .replace(/\{(name|location|job)\}/g, (_, k: string) => values[k])
    .replace(/[\s/／・]+$/, "")
    .trim();
  return title || values.name;
}

/** スタッフ本人のカレンダー用 */
export function buildStaffEvent(c: EventContext): CalendarEvent {
  return baseEvent(c, "staff", eventTitle(c));
}

/**
 * 店舗カレンダー用。
 * inviteEmail があれば（本人がGoogle未連携の場合）招待も送る
 */
export function buildStoreEvent(c: EventContext & { inviteEmail: string | null }): CalendarEvent {
  const ev = baseEvent(c, "store", eventTitle(c));
  return {
    ...ev,
    attendees: c.inviteEmail ? [{ email: c.inviteEmail, ...(teamMemberName(c.member) ? { displayName: teamMemberName(c.member) } : {}) }] : [],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };
}

export function hashEvent(e: CalendarEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([e.summary, e.description, e.location, e.start, e.end, e.attendees ?? []]))
    .digest("hex");
}

function emptySummary(): SyncSummary {
  return { created: 0, updated: 0, unchanged: 0, deleted: 0, no_email: 0, error: 0, shifts: 0, errors: [] };
}

export function formatSummary(s: SyncSummary): string {
  const parts = [
    `シフト${s.shifts}件`,
    `新規${s.created}`,
    `更新${s.updated}`,
    `変更なし${s.unchanged}`,
    `削除${s.deleted}`,
    `送信先なし${s.no_email}`,
    `エラー${s.error}`,
  ];
  return parts.join(" / ") + (s.errors.length ? `\n${s.errors.slice(0, 5).join("\n")}` : "");
}

function isLive(row: ShiftEventRow | null): row is ShiftEventRow & { eventId: string; accountKey: AccountKey; calendarId: string } {
  return Boolean(row?.eventId && row.accountKey && row.calendarId && (row.status === "synced" || row.status === "error"));
}

export class SyncService {
  private readonly store: Store;
  private readonly square: SquareApi;
  private readonly calendar: CalendarGateway;
  private readonly settings: SyncSettings;
  private cache: { at: number; value: Pick<Lookups, "members" | "locations" | "jobs"> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private errors: string[] = [];

  constructor(opts: { store: Store; square: SquareApi; calendar: CalendarGateway; settings: SyncSettings }) {
    this.store = opts.store;
    this.square = opts.square;
    this.calendar = opts.calendar;
    this.settings = opts.settings;
  }

  /** 同期処理を直列化（定期実行とWebhookが同時に走らないように） */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async lookups(forceRefresh = false): Promise<Lookups> {
    const fresh = this.cache && Date.now() - this.cache.at < 5 * 60_000;
    if (!fresh || forceRefresh) {
      const [memberList, locations, jobs] = await Promise.all([
        this.square.listTeamMembers(),
        this.square.listLocations(),
        this.square.listJobs(),
      ]);
      this.cache = { at: Date.now(), value: { members: new Map(memberList.map((m) => [m.id, m])), locations, jobs } };
    }
    const linkedStaff = new Set<string>();
    for (const [id, a] of this.store.listStaffAccounts()) if (!a.invalid) linkedStaff.add(id);
    return {
      ...this.cache!.value,
      overrides: this.store.getEmailOverrides(),
      locationCalendars: this.store.getLocationCalendars(),
      linkedStaff,
      companyLinked: Boolean(this.store.getActiveGoogleAccount(COMPANY)),
    };
  }

  /** 期間内の公開済みシフトをまとめて同期 */
  syncRange(trigger: string, now = new Date()): Promise<SyncSummary> {
    return this.exclusive(async () => {
      const runId = this.store.startSyncRun(trigger);
      this.errors = [];
      const summary = emptySummary();
      try {
        const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
        const to = new Date(now.getTime() + this.settings.daysAhead * 24 * 3600_000).toISOString();
        const [shifts, lk] = await Promise.all([
          this.square.searchPublishedShifts({ from, to }, this.settings.locationIds),
          this.lookups(true),
        ]);

        const seen = new Set<string>();
        for (const shift of shifts) {
          seen.add(shift.id);
          tally(summary, await this.syncOne(shift.id, shift, lk));
        }
        // 以前同期したのに今回の検索結果に無いシフト（削除・期間外移動など）を個別に確認
        for (const shiftId of this.store.listLiveShiftIdsBetween(from, to)) {
          if (seen.has(shiftId)) continue;
          tally(summary, await this.syncOne(shiftId, await this.square.getScheduledShift(shiftId), lk));
        }
      } catch (e) {
        summary.error++;
        this.errors.unshift(errorMessage(e));
      }
      summary.errors = this.errors;
      this.store.finishSyncRun(runId, formatSummary(summary));
      return summary;
    });
  }

  /** 1件だけ同期（Webhook用）。shiftを渡さない場合はSquareから取得する */
  syncShiftById(shiftId: string, shift?: ScheduledShift | null): Promise<ShiftResult> {
    return this.exclusive(async () => {
      const s = shift === undefined ? await this.square.getScheduledShift(shiftId) : shift;
      return this.syncOne(shiftId, s, await this.lookups());
    });
  }

  /**
   * スタッフが連携を解除する前に、本人のカレンダーから今後のシフト予定を消す。
   * （解除後は本人のカレンダーを操作できなくなるため）
   */
  removeStaffEvents(teamMemberId: string, now = new Date()): Promise<number> {
    return this.exclusive(async () => {
      let removed = 0;
      for (const row of this.store.listLiveStaffEvents(teamMemberId, now.toISOString())) {
        try {
          await this.calendar.deleteEvent(row.accountKey!, row.calendarId!, row.eventId!);
        } catch (e) {
          if (!(e instanceof GoogleAccountUnavailableError)) throw e;
        }
        this.store.upsertShiftEvent({ ...row, status: "deleted", contentHash: null, message: "Google連携の解除により削除" });
        removed++;
      }
      return removed;
    });
  }

  private async syncOne(shiftId: string, shift: ScheduledShift | null, lk: Lookups): Promise<ShiftResult> {
    const d = shift?.published_shift_details;
    const active = Boolean(shift && d && !d.is_deleted && d.team_member_id && d.start_at && d.end_at);
    const desired = active ? this.desiredTargets(shift!, d!, lk) : { store: null, staff: null };

    const result: ShiftResult = {};
    for (const target of TARGETS) {
      const reason = !shift
        ? "Squareにシフトが存在しません"
        : !active
          ? "シフトが削除または担当者なしになりました"
          : target === "staff"
            ? "本人のGoogle連携がないため"
            : "店舗カレンダーの書き込み先がないため";
      const r = await this.reconcile(shiftId, target, desired[target], d, reason);
      if (r) result[target] = r;
    }

    // 本人未連携かつメールも無い → どこにも届かないことを記録
    if (active && result.staff !== "error" && !lk.linkedStaff.has(d!.team_member_id!) && !this.inviteEmailFor(d!.team_member_id!, lk)) {
      const member = lk.members.get(d!.team_member_id!);
      this.store.upsertShiftEvent({
        shiftId,
        target: "staff",
        accountKey: null,
        calendarId: null,
        eventId: null,
        teamMemberId: d!.team_member_id!,
        attendeeEmail: null,
        contentHash: null,
        status: "no_email",
        message: `${teamMemberName(member) || d!.team_member_id} はGoogle未連携で、メールアドレスも未登録です`,
        startAt: d!.start_at!,
      });
      result.staff = "no_email";
    }
    return result;
  }

  private inviteEmailFor(teamMemberId: string, lk: Lookups): string | null {
    return (lk.overrides.get(teamMemberId) ?? lk.members.get(teamMemberId)?.email_address ?? "").trim() || null;
  }

  private desiredTargets(shift: ScheduledShift, d: ScheduledShiftDetails, lk: Lookups): Record<EventTarget, Desired | null> {
    const tmId = d.team_member_id!;
    const ctx: EventContext = {
      shift,
      member: lk.members.get(tmId),
      locationName: d.location_id ? lk.locations.get(d.location_id) : undefined,
      jobTitle: d.job_id ? lk.jobs.get(d.job_id) : undefined,
      settings: this.settings,
    };
    const staffLinked = lk.linkedStaff.has(tmId);

    // スタッフ本人のカレンダー（本人がGoogle連携済みの場合のみ）
    const staff: Desired | null = staffLinked
      ? { account: staffKey(tmId), calendarId: "primary", event: buildStaffEvent(ctx), attendeeEmail: null }
      : null;

    // 店舗カレンダー（会社アカウント）。本人未連携ならここから招待を送る
    const calendarId = d.location_id && lk.locationCalendars.has(d.location_id)
      ? lk.locationCalendars.get(d.location_id)!
      : this.settings.defaultStoreCalendarId;
    let store: Desired | null = null;
    if (lk.companyLinked && calendarId) {
      const inviteEmail = staffLinked ? null : this.inviteEmailFor(tmId, lk);
      store = { account: COMPANY, calendarId, event: buildStoreEvent({ ...ctx, inviteEmail }), attendeeEmail: inviteEmail };
    }
    return { store, staff };
  }

  /** 1か所（店舗 or 本人）の予定を、あるべき姿に合わせる */
  private async reconcile(
    shiftId: string,
    target: EventTarget,
    want: Desired | null,
    d: ScheduledShiftDetails | undefined,
    removalReason: string,
  ): Promise<TargetResult | null> {
    const existing = this.store.getShiftEvent(shiftId, target);
    const live = isLive(existing);
    const samePlace = live && want && existing.accountKey === want.account && existing.calendarId === want.calendarId;
    // 予定が今どこにあるか（エラー時の記録用）
    let current: { account: AccountKey | null; calendarId: string | null; eventId: string | null } = live
      ? { account: existing.accountKey, calendarId: existing.calendarId, eventId: existing.eventId }
      : { account: null, calendarId: null, eventId: null };

    try {
      // 不要になった／場所が変わった予定を消す
      if (live && !samePlace) {
        await this.deleteQuietly(existing.accountKey, existing.calendarId, existing.eventId);
        current = { account: null, calendarId: null, eventId: null };
        if (!want) {
          this.store.upsertShiftEvent({ ...existing, status: "deleted", contentHash: null, message: removalReason });
          return "deleted";
        }
      }
      if (!want) {
        // 予定は無いが「送信先なし」などの記録が残っている場合は片付ける
        if (existing && existing.status !== "deleted") {
          this.store.upsertShiftEvent({ ...existing, status: "deleted", eventId: existing.eventId, contentHash: null, message: removalReason });
        }
        return null;
      }

      const hash = hashEvent(want.event);
      if (samePlace && existing.status === "synced" && existing.contentHash === hash) return "unchanged";

      current = { account: want.account, calendarId: want.calendarId, eventId: want.event.id };
      await this.calendar.upsertEvent(want.account, want.calendarId, want.event);
      this.store.upsertShiftEvent({
        shiftId,
        target,
        accountKey: want.account,
        calendarId: want.calendarId,
        eventId: want.event.id,
        teamMemberId: d?.team_member_id ?? null,
        attendeeEmail: want.attendeeEmail,
        contentHash: hash,
        status: "synced",
        message: null,
        startAt: d?.start_at ?? null,
      });
      return samePlace ? "updated" : "created";
    } catch (e) {
      const msg = errorMessage(e);
      this.errors.push(`${shiftId}(${target === "store" ? "店舗" : "本人"}): ${msg}`);
      // ハッシュを消して次回に再試行させる
      this.store.upsertShiftEvent({
        shiftId,
        target,
        accountKey: current.account,
        calendarId: current.calendarId,
        eventId: current.eventId,
        teamMemberId: d?.team_member_id ?? existing?.teamMemberId ?? null,
        attendeeEmail: existing?.attendeeEmail ?? null,
        contentHash: null,
        status: "error",
        message: msg,
        startAt: d?.start_at ?? existing?.startAt ?? null,
      });
      return "error";
    }
  }

  /** 連携が切れていて消せない場合は諦める（本人のカレンダーにはアクセスできない） */
  private async deleteQuietly(account: AccountKey, calendarId: string, eventId: string): Promise<void> {
    try {
      await this.calendar.deleteEvent(account, calendarId, eventId);
    } catch (e) {
      if (!(e instanceof GoogleAccountUnavailableError)) throw e;
    }
  }
}

function tally(summary: SyncSummary, r: ShiftResult): void {
  summary.shifts++;
  for (const v of Object.values(r)) if (v) summary[v]++;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 500) : String(e);
}
