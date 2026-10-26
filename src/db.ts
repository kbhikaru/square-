import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 連携したGoogleアカウントの識別子。会社アカウントは "company"、スタッフは "staff:<SquareのチームメンバーID>" */
export type AccountKey = "company" | `staff:${string}`;

export const COMPANY: AccountKey = "company";
export const staffKey = (teamMemberId: string): AccountKey => `staff:${teamMemberId}`;

export type GoogleAccount = {
  key: AccountKey;
  email: string;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number | null; // epoch ms
  connectedAt: string;
  /** Google側で連携が取り消された（再連携が必要） */
  invalid: boolean;
};

/** store = 店舗カレンダー（会社アカウント）, staff = スタッフ本人のカレンダー */
export type EventTarget = "store" | "staff";

export type ShiftEventStatus = "synced" | "no_email" | "deleted" | "error";

export type ShiftEventRow = {
  shiftId: string;
  target: EventTarget;
  accountKey: AccountKey | null;
  calendarId: string | null;
  eventId: string | null;
  teamMemberId: string | null;
  attendeeEmail: string | null;
  contentHash: string | null;
  status: ShiftEventStatus;
  message: string | null;
  startAt: string | null;
  updatedAt: string;
};

export type SyncRunRow = {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
};

export type OAuthState = { purpose: "company" | "staff"; teamMemberId: string | null };

const SCHEMA_VERSION = 2;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version < 2) {
      // v1（会社アカウントのみ・招待方式）のテーブルは構造が違うので作り直す
      this.db.exec("DROP TABLE IF EXISTS google_account; DROP TABLE IF EXISTS shift_events;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS google_accounts (
        account_key TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at INTEGER,
        connected_at TEXT NOT NULL,
        invalid INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS shift_events (
        shift_id TEXT NOT NULL,
        target TEXT NOT NULL,
        account_key TEXT,
        calendar_id TEXT,
        event_id TEXT,
        team_member_id TEXT,
        attendee_email TEXT,
        content_hash TEXT,
        status TEXT NOT NULL,
        message TEXT,
        start_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (shift_id, target)
      );
      CREATE INDEX IF NOT EXISTS shift_events_start ON shift_events (start_at);
      CREATE TABLE IF NOT EXISTS staff_email_overrides (
        team_member_id TEXT PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS location_calendars (
        location_id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staff_link_tokens (
        token_hash TEXT PRIMARY KEY,
        team_member_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        team_member_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  // ---- Google連携アカウント ----

  getGoogleAccount(key: AccountKey): GoogleAccount | null {
    const r = this.db.prepare("SELECT * FROM google_accounts WHERE account_key = ?").get(key) as any;
    return r ? toAccount(r) : null;
  }

  /** 有効な（取り消されていない）連携だけ */
  getActiveGoogleAccount(key: AccountKey): GoogleAccount | null {
    const a = this.getGoogleAccount(key);
    return a && !a.invalid ? a : null;
  }

  listStaffAccounts(): Map<string, GoogleAccount> {
    const rows = this.db.prepare("SELECT * FROM google_accounts WHERE account_key LIKE 'staff:%'").all() as any[];
    return new Map(rows.map((r) => [String(r.account_key).slice("staff:".length), toAccount(r)]));
  }

  saveGoogleAccount(key: AccountKey, a: { email: string; refreshToken: string; accessToken: string | null; expiresAt: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO google_accounts (account_key, email, refresh_token, access_token, expires_at, connected_at, invalid)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(account_key) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, expires_at = excluded.expires_at,
           connected_at = excluded.connected_at, invalid = 0`,
      )
      .run(key, a.email, a.refreshToken, a.accessToken, a.expiresAt, new Date().toISOString());
  }

  updateGoogleAccessToken(key: AccountKey, accessToken: string, expiresAt: number): void {
    this.db
      .prepare("UPDATE google_accounts SET access_token = ?, expires_at = ? WHERE account_key = ?")
      .run(accessToken, expiresAt, key);
  }

  markGoogleAccountInvalid(key: AccountKey): void {
    this.db.prepare("UPDATE google_accounts SET invalid = 1, access_token = NULL WHERE account_key = ?").run(key);
  }

  deleteGoogleAccount(key: AccountKey): void {
    this.db.prepare("DELETE FROM google_accounts WHERE account_key = ?").run(key);
  }

  // ---- シフト ↔ カレンダー予定の対応 ----

  getShiftEvent(shiftId: string, target: EventTarget): ShiftEventRow | null {
    const r = this.db
      .prepare("SELECT * FROM shift_events WHERE shift_id = ? AND target = ?")
      .get(shiftId, target) as any;
    return r ? toShiftEventRow(r) : null;
  }

  upsertShiftEvent(row: Omit<ShiftEventRow, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO shift_events (shift_id, target, account_key, calendar_id, event_id, team_member_id, attendee_email,
           content_hash, status, message, start_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shift_id, target) DO UPDATE SET account_key = excluded.account_key, calendar_id = excluded.calendar_id,
           event_id = excluded.event_id, team_member_id = excluded.team_member_id, attendee_email = excluded.attendee_email,
           content_hash = excluded.content_hash, status = excluded.status, message = excluded.message,
           start_at = excluded.start_at, updated_at = excluded.updated_at`,
      )
      .run(
        row.shiftId,
        row.target,
        row.accountKey,
        row.calendarId,
        row.eventId,
        row.teamMemberId,
        row.attendeeEmail,
        row.contentHash,
        row.status,
        row.message,
        row.startAt,
        new Date().toISOString(),
      );
  }

  listShiftEvents(limit = 200): ShiftEventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM shift_events ORDER BY start_at DESC, shift_id, target LIMIT ?")
      .all(limit) as any[];
    return rows.map(toShiftEventRow);
  }

  /** 期間内で予定が残っている（可能性がある）シフトID。Square側で消えたものの検出に使う */
  listLiveShiftIdsBetween(fromIso: string, toIso: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT shift_id FROM shift_events WHERE status IN ('synced', 'error') AND event_id IS NOT NULL
         AND start_at >= ? AND start_at < ?`,
      )
      .all(fromIso, toIso) as any[];
    return rows.map((r) => r.shift_id as string);
  }

  /** スタッフ本人のカレンダーにある、今後の予定 */
  listLiveStaffEvents(teamMemberId: string, fromIso: string): ShiftEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shift_events WHERE target = 'staff' AND account_key = ? AND status IN ('synced', 'error')
         AND event_id IS NOT NULL AND start_at >= ?`,
      )
      .all(staffKey(teamMemberId), fromIso) as any[];
    return rows.map(toShiftEventRow);
  }

  // ---- メールアドレスの上書き設定 ----

  getEmailOverrides(): Map<string, string> {
    const rows = this.db.prepare("SELECT * FROM staff_email_overrides").all() as any[];
    return new Map(rows.map((r) => [r.team_member_id as string, r.email as string]));
  }

  setEmailOverride(teamMemberId: string, email: string | null): void {
    if (!email) {
      this.db.prepare("DELETE FROM staff_email_overrides WHERE team_member_id = ?").run(teamMemberId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO staff_email_overrides (team_member_id, email) VALUES (?, ?)
         ON CONFLICT(team_member_id) DO UPDATE SET email = excluded.email`,
      )
      .run(teamMemberId, email);
  }

  // ---- 店舗（ロケーション）ごとのカレンダー ----

  /** 値が "" の場合は「この店舗はカレンダーに書き込まない」 */
  getLocationCalendars(): Map<string, string> {
    const rows = this.db.prepare("SELECT * FROM location_calendars").all() as any[];
    return new Map(rows.map((r) => [r.location_id as string, r.calendar_id as string]));
  }

  /** calendarId: null = 既定のカレンダーに戻す, "" = 書き込まない */
  setLocationCalendar(locationId: string, calendarId: string | null): void {
    if (calendarId === null) {
      this.db.prepare("DELETE FROM location_calendars WHERE location_id = ?").run(locationId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO location_calendars (location_id, calendar_id) VALUES (?, ?)
         ON CONFLICT(location_id) DO UPDATE SET calendar_id = excluded.calendar_id`,
      )
      .run(locationId, calendarId);
  }

  // ---- スタッフ連携用リンク ----

  saveStaffLinkToken(tokenHash: string, teamMemberId: string, expiresAt: number): void {
    this.db.prepare("DELETE FROM staff_link_tokens WHERE team_member_id = ? OR expires_at < ?").run(teamMemberId, Date.now());
    this.db
      .prepare("INSERT INTO staff_link_tokens (token_hash, team_member_id, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash, teamMemberId, expiresAt);
  }

  findStaffLinkToken(tokenHash: string): string | null {
    const r = this.db
      .prepare("SELECT team_member_id FROM staff_link_tokens WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, Date.now()) as any;
    return r ? (r.team_member_id as string) : null;
  }

  deleteStaffLinkTokens(teamMemberId: string): void {
    this.db.prepare("DELETE FROM staff_link_tokens WHERE team_member_id = ?").run(teamMemberId);
  }

  // ---- OAuthのstate（CSRF対策と、誰の連携かの記録） ----

  saveOAuthState(state: string, s: OAuthState): void {
    this.db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(Date.now() - 15 * 60_000);
    this.db
      .prepare("INSERT INTO oauth_states (state, purpose, team_member_id, created_at) VALUES (?, ?, ?, ?)")
      .run(state, s.purpose, s.teamMemberId, Date.now());
  }

  /** 1回だけ使える。15分で失効 */
  takeOAuthState(state: string): OAuthState | null {
    const r = this.db
      .prepare("SELECT * FROM oauth_states WHERE state = ? AND created_at >= ?")
      .get(state, Date.now() - 15 * 60_000) as any;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    return r ? { purpose: r.purpose, teamMemberId: r.team_member_id } : null;
  }

  // ---- 同期履歴 ----

  startSyncRun(trigger: string): number {
    const r = this.db
      .prepare("INSERT INTO sync_runs (trigger, started_at) VALUES (?, ?)")
      .run(trigger, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  finishSyncRun(id: number, summary: string): void {
    this.db
      .prepare("UPDATE sync_runs SET finished_at = ?, summary = ? WHERE id = ?")
      .run(new Date().toISOString(), summary, id);
  }

  listSyncRuns(limit = 10): SyncRunRow[] {
    const rows = this.db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      summary: r.summary,
    }));
  }
}

function toAccount(r: any): GoogleAccount {
  return {
    key: r.account_key,
    email: r.email,
    refreshToken: r.refresh_token,
    accessToken: r.access_token,
    expiresAt: r.expires_at,
    connectedAt: r.connected_at,
    invalid: Boolean(r.invalid),
  };
}

function toShiftEventRow(r: any): ShiftEventRow {
  return {
    shiftId: r.shift_id,
    target: r.target,
    accountKey: r.account_key,
    calendarId: r.calendar_id,
    eventId: r.event_id,
    teamMemberId: r.team_member_id,
    attendeeEmail: r.attendee_email,
    contentHash: r.content_hash,
    status: r.status,
    message: r.message,
    startAt: r.start_at,
    updatedAt: r.updated_at,
  };
}
