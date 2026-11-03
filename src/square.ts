import { createHmac, timingSafeEqual } from "node:crypto";

// Square APIのレスポンス（JSONはsnake_case）

export type ScheduledShiftDetails = {
  team_member_id?: string | null;
  location_id?: string | null;
  job_id?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  notes?: string | null;
  is_deleted?: boolean | null;
  timezone?: string;
};

export type ScheduledShift = {
  id: string;
  draft_shift_details?: ScheduledShiftDetails;
  published_shift_details?: ScheduledShiftDetails;
  version?: number;
  created_at?: string;
  updated_at?: string;
};

export type TeamMember = {
  id: string;
  given_name?: string | null;
  family_name?: string | null;
  email_address?: string | null;
  status?: "ACTIVE" | "INACTIVE";
};

export type SquareApiOptions = {
  accessToken: string;
  baseUrl: string;
  apiVersion: string;
  fetch?: typeof fetch;
};

export class SquareApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`Square API error ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export class SquareClient {
  private readonly opts: SquareApiOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SquareApiOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.opts.accessToken) throw new Error("SQUARE_ACCESS_TOKEN が設定されていません");
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Square-Version": this.opts.apiVersion,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new SquareApiError(res.status, json);
    return json as T;
  }

  /** 公開済みシフトを開始日時の範囲で取得（ページング込み） */
  async searchPublishedShifts(range: { from: string; to: string }, locationIds: string[] = []): Promise<ScheduledShift[]> {
    const shifts: ScheduledShift[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ scheduled_shifts?: ScheduledShift[]; cursor?: string }>(
        "POST",
        "/v2/labor/scheduled-shifts/search",
        {
          query: {
            filter: {
              start: { start_at: range.from, end_at: range.to },
              scheduled_shift_statuses: ["PUBLISHED"],
              ...(locationIds.length ? { location_ids: locationIds } : {}),
            },
            sort: { field: "START_AT", order: "ASC" },
          },
          limit: 50,
          ...(cursor ? { cursor } : {}),
        },
      );
      shifts.push(...(res.scheduled_shifts ?? []));
      cursor = res.cursor;
    } while (cursor);
    return shifts;
  }

  async getScheduledShift(id: string): Promise<ScheduledShift | null> {
    try {
      const res = await this.request<{ scheduled_shift?: ScheduledShift }>(
        "GET",
        `/v2/labor/scheduled-shifts/${encodeURIComponent(id)}`,
      );
      return res.scheduled_shift ?? null;
    } catch (e) {
      if (e instanceof SquareApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** 全スタッフ（退職者含む）。過去シフトの紐付けのため INACTIVE も取る */
  async listTeamMembers(): Promise<TeamMember[]> {
    const members: TeamMember[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ team_members?: TeamMember[]; cursor?: string }>(
        "POST",
        "/v2/team-members/search",
        { limit: 200, ...(cursor ? { cursor } : {}) },
      );
      members.push(...(res.team_members ?? []));
      cursor = res.cursor;
    } while (cursor);
    return members;
  }

  async listLocations(): Promise<Map<string, string>> {
    const res = await this.request<{ locations?: { id: string; name?: string }[] }>("GET", "/v2/locations");
    return new Map((res.locations ?? []).map((l) => [l.id, l.name ?? l.id]));
  }

  async listJobs(): Promise<Map<string, string>> {
    const jobs = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await this.request<{ jobs?: { id: string; title?: string }[]; cursor?: string }>(
        "GET",
        `/v2/team-members/jobs${q}`,
      );
      for (const j of res.jobs ?? []) jobs.set(j.id, j.title ?? "");
      cursor = res.cursor;
    } while (cursor);
    return jobs;
  }
}

/**
 * Square Webhookの署名検証。
 * 署名 = Base64(HMAC-SHA256(signatureKey, 通知先URL + 生のリクエストボディ))
 */
export function verifySquareSignature(opts: {
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
  signature: string | undefined;
}): boolean {
  if (!opts.signatureKey || !opts.signature) return false;
  const expected = createHmac("sha256", opts.signatureKey)
    .update(opts.notificationUrl + opts.rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function teamMemberName(m: TeamMember | undefined): string {
  if (!m) return "";
  return [m.family_name, m.given_name].filter(Boolean).join(" ");
}
