import type { AccountKey, Store } from "./db.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

/** 連携の種類ごとに必要な権限 */
export const GOOGLE_SCOPES = {
  // 会社アカウント: 店舗カレンダーへの書き込み＋カレンダー一覧の表示（店舗ごとの選択用）
  company: ["openid", "email", EVENTS_SCOPE, CALENDAR_LIST_SCOPE],
  // スタッフ: 本人のカレンダーへの予定の書き込みのみ
  staff: ["openid", "email", EVENTS_SCOPE],
} as const;

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

/** 連携が無い、またはGoogle側で取り消された */
export class GoogleAccountUnavailableError extends Error {
  readonly key: AccountKey;
  constructor(key: AccountKey, reason: string) {
    super(reason);
    this.key = key;
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

  authUrl(state: string, purpose: keyof typeof GOOGLE_SCOPES, loginHint?: string): string {
    const p = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES[purpose].join(" "),
      access_type: "offline", // refresh_token を受け取る
      prompt: "consent select_account", // 再連携時も必ず refresh_token を発行させる
      state,
    });
    if (loginHint) p.set("login_hint", loginHint);
    return `${AUTH_URL}?${p}`;
  }

  async exchangeCode(code: string): Promise<{ email: string; refreshToken: string; accessToken: string; expiresAt: number; scopes: string[] }> {
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
      scopes: String(json.scope ?? "").split(" ").filter(Boolean),
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

/** 必要な権限がすべて許可されたか（同意画面でチェックを外された場合の検出） */
export function hasScopes(granted: string[], purpose: keyof typeof GOOGLE_SCOPES): boolean {
  return GOOGLE_SCOPES[purpose].filter((s) => s.startsWith("https://")).every((s) => granted.includes(s));
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

/** 保存済みの連携から、期限切れなら自動更新してアクセストークンを返す */
export async function getAccessToken(store: Store, oauth: GoogleOAuth, key: AccountKey): Promise<string> {
  const account = store.getActiveGoogleAccount(key);
  if (!account) throw new GoogleAccountUnavailableError(key, "Googleアカウントが連携されていません");
  if (account.accessToken && account.expiresAt && account.expiresAt - 60_000 > Date.now()) {
    return account.accessToken;
  }
  try {
    const { accessToken, expiresAt } = await oauth.refresh(account.refreshToken);
    store.updateGoogleAccessToken(key, accessToken, expiresAt);
    return accessToken;
  } catch (e) {
    // invalid_grant = 本人がGoogle側で連携を解除した／パスワード変更など → 再連携が必要
    if (e instanceof GoogleApiError && (e.body as any)?.error === "invalid_grant") {
      store.markGoogleAccountInvalid(key);
      throw new GoogleAccountUnavailableError(key, "Googleアカウントの連携が取り消されています（再連携が必要）");
    }
    throw e;
  }
}

// ---------------- Calendar API ----------------

export type CalendarEvent = {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: { email: string; displayName?: string }[];
  extendedProperties?: { private?: Record<string, string> };
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
};

export type CalendarInfo = { id: string; summary: string; primary: boolean };

/** どのアカウントの、どのカレンダーに書くかを指定して操作する */
export interface CalendarGateway {
  /** 予定を作成。同じIDが既にあればそれを上書き更新する */
  upsertEvent(account: AccountKey, calendarId: string, event: CalendarEvent): Promise<void>;
  /** 予定を削除。既に無ければ何もしない */
  deleteEvent(account: AccountKey, calendarId: string, eventId: string): Promise<void>;
}

export class GoogleCalendarGateway implements CalendarGateway {
  private readonly getToken: (key: AccountKey) => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { getToken: (key: AccountKey) => Promise<string>; fetch?: typeof fetch }) {
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request(account: AccountKey, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.getToken(account);
    return this.fetchImpl(`${CALENDAR_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async upsertEvent(account: AccountKey, calendarId: string, event: CalendarEvent): Promise<void> {
    const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
    // 招待相手がいる時だけ通知メールを送る（本人のカレンダーに直接書く場合は不要）
    const sendUpdates = event.attendees?.length ? "all" : "none";

    const created = await this.request(account, "POST", `${base}?sendUpdates=${sendUpdates}`, event);
    if (created.ok) return;
    if (created.status !== 409) throw new GoogleApiError(created.status, await created.json().catch(() => ({})));

    // 409 = 同じIDの予定が既にある（削除済み含む）→ 更新して復活させる
    const updated = await this.request(
      account,
      "PUT",
      `${base}/${encodeURIComponent(event.id)}?sendUpdates=${sendUpdates}`,
      { attendees: [], ...event, status: "confirmed" },
    );
    if (!updated.ok) throw new GoogleApiError(updated.status, await updated.json().catch(() => ({})));
  }

  async deleteEvent(account: AccountKey, calendarId: string, eventId: string): Promise<void> {
    const res = await this.request(
      account,
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    );
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new GoogleApiError(res.status, await res.json().catch(() => ({})));
  }

  /** 書き込み可能なカレンダーの一覧（店舗カレンダーの選択用） */
  async listWritableCalendars(account: AccountKey): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ minAccessRole: "writer", maxResults: "250" });
      if (pageToken) q.set("pageToken", pageToken);
      const res = await this.request(account, "GET", `/users/me/calendarList?${q}`);
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new GoogleApiError(res.status, json);
      for (const c of json.items ?? []) {
        out.push({ id: c.id, summary: c.summaryOverride ?? c.summary ?? c.id, primary: Boolean(c.primary) });
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return out;
  }
}
