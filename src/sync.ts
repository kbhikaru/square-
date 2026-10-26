import { createHash } from "node:crypto";
import type { Store } from "./db.ts";
import type { CalendarApi, CalendarEvent } from "./google.ts";
import { teamMemberName, type ScheduledShift, type SquareClient, type TeamMember } from "./square.ts";

export type SyncSettings = {
  daysAhead: number;
  defaultTimezone: string;
  titlePrefix: string;
  locationIds: string[];
};

export type SyncResult = "created" | "updated" | "unchanged" | "deleted" | "skipped" | "no_email" | "error";

export type SyncSummary = Record<SyncResult, number> & { total: number; errors: string[] };

type Lookups = {
  members: Map<string, TeamMember>;
  locations: Map<string, string>;
  jobs: Map<string, string>;
  overrides: Map<string, string>;
};

/** SquareのシフトIDから、Googleカレンダーの予定IDを決める（a-v,0-9のみ使用可） */
export function eventIdForShift(shiftId: string): string {
  return "sq" + createHash("sha256").update(shiftId).digest("hex").slice(0, 40);
}

/** シフトの公開内容から、カレンダー予定を組み立てる（純粋関数） */
export function buildEvent(args: {
  shift: ScheduledShift;
  email: string;
  member: TeamMember | undefined;
  locationName: string | undefined;
  jobTitle: string | undefined;
  settings: Pick<SyncSettings, "defaultTimezone" | "titlePrefix">;
}): CalendarEvent & { id: string } {
  const d = args.shift.published_shift_details!;
  const tz = d.timezone || args.settings.defaultTimezone;
  const name = teamMemberName(args.member);
  const titleParts = [args.locationName, args.jobTitle].filter(Boolean);

  const description = [
    name && `スタッフ: ${name}`,
    args.locationName && `店舗: ${args.locationName}`,
    args.jobTitle && `職種: ${args.jobTitle}`,
    d.notes && `メモ: ${d.notes}`,
    "",
    "※ Squareのシフトから自動作成された予定です。変更はSquare側で行ってください。",
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");

  return {
    id: eventIdForShift(args.shift.id),
    summary: `${args.settings.titlePrefix}${titleParts.join(" / ") || "勤務"}`,
    description,
    location: args.locationName,
    start: { dateTime: d.start_at!, timeZone: tz },
    end: { dateTime: d.end_at!, timeZone: tz },
    attendees: [{ email: args.email, ...(name ? { displayName: name } : {}) }],
    extendedProperties: { private: { squareShiftId: args.shift.id } },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };
}

export function hashEvent(e: CalendarEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([e.summary, e.description, e.location, e.start, e.end, e.attendees]))
    .digest("hex");
}

function emptySummary(): SyncSummary {
  return { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, no_email: 0, error: 0, total: 0, errors: [] };
}

export function formatSummary(s: SyncSummary): string {
  const parts = [
    `対象${s.total}件`,
    `新規${s.created}`,
    `更新${s.updated}`,
    `変更なし${s.unchanged}`,
    `削除${s.deleted}`,
    `メール未登録${s.no_email}`,
    `エラー${s.error}`,
  ];
  return parts.join(" / ") + (s.errors.length ? `\n${s.errors.slice(0, 5).join("\n")}` : "");
}

export class SyncService {
  private readonly store: Store;
  private readonly square: Pick<SquareClient, "searchPublishedShifts" | "getScheduledShift" | "listTeamMembers" | "listLocations" | "listJobs">;
  private readonly calendar: () => CalendarApi;
  private readonly settings: SyncSettings;
  private lookupsCache: { at: number; value: Omit<Lookups, "overrides"> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lastErrors = new Map<string, string>();

  constructor(opts: {
    store: Store;
    square: SyncService["square"];
    calendar: () => CalendarApi;
    settings: SyncSettings;
  }) {
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
    const fresh = this.lookupsCache && Date.now() - this.lookupsCache.at < 5 * 60_000;
    if (!fresh || forceRefresh) {
      const [memberList, locations, jobs] = await Promise.all([
        this.square.listTeamMembers(),
        this.square.listLocations(),
        this.square.listJobs(),
      ]);
      this.lookupsCache = {
        at: Date.now(),
        value: { members: new Map(memberList.map((m) => [m.id, m])), locations, jobs },
      };
    }
    return { ...this.lookupsCache!.value, overrides: this.store.getEmailOverrides() };
  }

  /** 期間内の公開済みシフトをまとめて同期 */
  syncRange(trigger: string, now = new Date()): Promise<SyncSummary> {
    return this.exclusive(async () => {
      const runId = this.store.startSyncRun(trigger);
      this.lastErrors.clear();
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
          count(summary, await this.syncOne(shift.id, shift, lk), shift.id);
        }

        // 以前同期したのに今回の検索結果に無いシフト（削除・期間外移動など）を個別に確認
        for (const row of this.store.listActiveShiftEventsBetween(from, to)) {
          if (seen.has(row.shiftId)) continue;
          const shift = await this.square.getScheduledShift(row.shiftId);
          count(summary, await this.syncOne(row.shiftId, shift, lk), row.shiftId);
        }
      } catch (e) {
        summary.error++;
        summary.errors.push(errorMessage(e));
      }
      for (const [id, msg] of this.lastErrors) summary.errors.push(`${id}: ${msg}`);
      this.lastErrors.clear();
      this.store.finishSyncRun(runId, formatSummary(summary));
      return summary;
    });
  }

  /** 1件だけ同期（Webhook用）。shiftを渡さない場合はSquareから取得する */
  syncShiftById(shiftId: string, shift?: ScheduledShift | null): Promise<SyncResult> {
    return this.exclusive(async () => {
      const s = shift === undefined ? await this.square.getScheduledShift(shiftId) : shift;
      return this.syncOne(shiftId, s, await this.lookups());
    });
  }

  private async syncOne(shiftId: string, shift: ScheduledShift | null, lk: Lookups): Promise<SyncResult> {
    const existing = this.store.getShiftEvent(shiftId);
    const d = shift?.published_shift_details;
    // error の場合も予定が残っている可能性があるので「生きている」扱い
    const hasLiveEvent = Boolean(existing?.eventId && (existing.status === "synced" || existing.status === "error"));

    try {
      // シフトが削除された／未公開／担当者なし → 予定があれば削除
      if (!shift || !d || d.is_deleted || !d.team_member_id || !d.start_at || !d.end_at) {
        if (hasLiveEvent) {
          await this.calendar().deleteEvent(existing!.eventId!);
          this.store.upsertShiftEvent({
            ...existing!,
            status: "deleted",
            contentHash: null,
            message: shift ? "シフトが削除または担当者なしになりました" : "Squareにシフトが存在しません",
          });
          return "deleted";
        }
        return "skipped";
      }

      const member = lk.members.get(d.team_member_id);
      const email = (lk.overrides.get(d.team_member_id) ?? member?.email_address ?? "").trim();

      if (!email) {
        // 担当者がメール未登録のスタッフに変わった場合、前の担当者の予定は消す
        if (hasLiveEvent) await this.calendar().deleteEvent(existing!.eventId!);
        this.store.upsertShiftEvent({
          shiftId,
          eventId: existing?.eventId ?? null,
          teamMemberId: d.team_member_id,
          attendeeEmail: null,
          contentHash: null,
          status: "no_email",
          message: `${teamMemberName(member) || d.team_member_id} のメールアドレスが未登録です`,
          startAt: d.start_at,
        });
        return "no_email";
      }

      const event = buildEvent({
        shift,
        email,
        member,
        locationName: d.location_id ? lk.locations.get(d.location_id) : undefined,
        jobTitle: d.job_id ? lk.jobs.get(d.job_id) : undefined,
        settings: this.settings,
      });
      const hash = hashEvent(event);
      if (existing?.status === "synced" && existing.contentHash === hash) return "unchanged";

      await this.calendar().upsertEvent(event);
      this.store.upsertShiftEvent({
        shiftId,
        eventId: event.id,
        teamMemberId: d.team_member_id,
        attendeeEmail: email,
        contentHash: hash,
        status: "synced",
        message: null,
        startAt: d.start_at,
      });
      return hasLiveEvent ? "updated" : "created";
    } catch (e) {
      const msg = errorMessage(e);
      this.lastErrors.set(shiftId, msg);
      // 予定IDは残し、ハッシュを消して次回に再試行させる
      this.store.upsertShiftEvent({
        shiftId,
        eventId: existing?.eventId ?? null,
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
}

function count(summary: SyncSummary, result: SyncResult, _shiftId: string): void {
  summary[result]++;
  if (result !== "skipped") summary.total++;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 500) : String(e);
}
