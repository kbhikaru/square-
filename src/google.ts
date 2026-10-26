import type { Store } from "./db.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  // 予定の作成・更新・削除のみ（カレンダー全体の権限は要求しない）
  "https://www.googleapis.com/auth/calendar.events",
];

export type GoogleOAuthOptions = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
};

export class GoogleApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`Google API error ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

// ---------------- OAuth（Googleアカウント連携） ----------------

export class GoogleOAuth {
  private readonly opts: GoogleOAuthOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleOAuthOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  authUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", // refresh_token を受け取る
      prompt: "consent", // 再連携時も必ず refresh_token を発行させる
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${p}`;
  }

  async exchangeCode(code: string): Promise<{ email: string; refreshToken: string; accessToken: string; expiresAt: number }> {
    const json = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.opts.redirectUri,
    });
    if (!json.refresh_token) {
      throw new Error("refresh_token が返されませんでした。Googleアカウントの「サードパーティアクセス」から一度連携を解除して再試行してください。");
    }
    return {
      email: emailFromIdToken(json.id_token) ?? "(unknown)",
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
    const json = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    return { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  }

  async revoke(token: string): Promise<void> {
    await this.fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }

  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        ...params,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new GoogleApiError(res.status, json);
    return json;
  }
}

/** トークンエンドポイントから直接受け取ったid_tokenなので、ペイロードの読み取りのみ行う */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/** DBに保存した連携アカウントから、期限切れなら自動更新してアクセストークンを返す */
export async function getAccessToken(store: Store, oauth: GoogleOAuth): Promise<string> {
  const account = store.getGoogleAccount();
  if (!account) throw new Error("Googleアカウントが連携されていません");
  if (account.accessToken && account.expiresAt && account.expiresAt - 60_000 > Date.now()) {
    return account.accessToken;
  }
  const { accessToken, expiresAt } = await oauth.refresh(account.refreshToken);
  store.updateGoogleAccessToken(accessToken, expiresAt);
  return accessToken;
}

// ---------------- Calendar API ----------------

export type CalendarEvent = {
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: { email: string; displayName?: string }[];
  extendedProperties?: { private?: Record<string, string> };
  reminders?: { useDefault: boolean; overrides?: { method: "email" | "popup"; minutes: number }[] };
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
};

export interface CalendarApi {
  /** 予定を作成。同じIDが既にあればそれを上書き更新する */
  upsertEvent(event: CalendarEvent & { id: string }): Promise<void>;
  /** 予定を削除。既に無ければ何もしない */
  deleteEvent(eventId: string): Promise<void>;
}

export class GoogleCalendarClient implements CalendarApi {
  private readonly calendarId: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { calendarId: string; getToken: () => Promise<string>; fetch?: typeof fetch }) {
    this.calendarId = opts.calendarId;
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.getToken();
    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(this.calendarId)}/events${path}`;
    return this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async upsertEvent(event: CalendarEvent & { id: string }): Promise<void> {
    // sendUpdates=all で参加者（スタッフ）に招待/変更メールが届く
    const created = await this.request("POST", "?sendUpdates=all", event);
    if (created.ok) return;
    if (created.status !== 409) throw new GoogleApiError(created.status, await created.json().catch(() => ({})));

    // 409 = 同じIDの予定が既にある（削除済み含む）→ 更新して復活させる
    const updated = await this.request(
      "PUT",
      `/${encodeURIComponent(event.id)}?sendUpdates=all`,
      { ...event, status: "confirmed" },
    );
    if (!updated.ok) throw new GoogleApiError(updated.status, await updated.json().catch(() => ({})));
  }

  async deleteEvent(eventId: string): Promise<void> {
    const res = await this.request("DELETE", `/${encodeURIComponent(eventId)}?sendUpdates=all`);
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new GoogleApiError(res.status, await res.json().catch(() => ({})));
  }
}
