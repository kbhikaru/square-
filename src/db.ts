import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type GoogleAccount = {
  email: string;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number | null; // epoch ms
  connectedAt: string;
};

export type ShiftEventStatus = "synced" | "no_email" | "deleted" | "error";

export type ShiftEventRow = {
  shiftId: string;
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

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS google_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at INTEGER,
        connected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shift_events (
        shift_id TEXT PRIMARY KEY,
        event_id TEXT,
        team_member_id TEXT,
        attendee_email TEXT,
        content_hash TEXT,
        status TEXT NOT NULL,
        message TEXT,
        start_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staff_email_overrides (
        team_member_id TEXT PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT
      );
    `);
  }

  // ---- Google連携アカウント ----

  getGoogleAccount(): GoogleAccount | null {
    const r = this.db.prepare("SELECT * FROM google_account WHERE id = 1").get() as any;
    if (!r) return null;
    return {
      email: r.email,
      refreshToken: r.refresh_token,
      accessToken: r.access_token,
      expiresAt: r.expires_at,
      connectedAt: r.connected_at,
    };
  }

  saveGoogleAccount(a: Omit<GoogleAccount, "connectedAt">): void {
    this.db
      .prepare(
        `INSERT INTO google_account (id, email, refresh_token, access_token, expires_at, connected_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, expires_at = excluded.expires_at, connected_at = excluded.connected_at`,
      )
      .run(a.email, a.refreshToken, a.accessToken, a.expiresAt, new Date().toISOString());
  }

  updateGoogleAccessToken(accessToken: string, expiresAt: number): void {
    this.db
      .prepare("UPDATE google_account SET access_token = ?, expires_at = ? WHERE id = 1")
      .run(accessToken, expiresAt);
  }

  deleteGoogleAccount(): void {
    this.db.prepare("DELETE FROM google_account WHERE id = 1").run();
  }

  // ---- シフト ↔ カレンダー予定の対応 ----

  getShiftEvent(shiftId: string): ShiftEventRow | null {
    const r = this.db.prepare("SELECT * FROM shift_events WHERE shift_id = ?").get(shiftId) as any;
    return r ? toShiftEventRow(r) : null;
  }

  upsertShiftEvent(row: Omit<ShiftEventRow, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO shift_events (shift_id, event_id, team_member_id, attendee_email, content_hash, status, message, start_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shift_id) DO UPDATE SET event_id = excluded.event_id, team_member_id = excluded.team_member_id,
           attendee_email = excluded.attendee_email, content_hash = excluded.content_hash, status = excluded.status,
           message = excluded.message, start_at = excluded.start_at, updated_at = excluded.updated_at`,
      )
      .run(
        row.shiftId,
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
      .prepare("SELECT * FROM shift_events ORDER BY start_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(toShiftEventRow);
  }

  /** 指定期間内で同期済みのシフト（Square側で消えたものの検出に使う） */
  listActiveShiftEventsBetween(fromIso: string, toIso: string): ShiftEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shift_events WHERE status IN ('synced', 'error') AND event_id IS NOT NULL
         AND start_at >= ? AND start_at < ?`,
      )
      .all(fromIso, toIso) as any[];
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

function toShiftEventRow(r: any): ShiftEventRow {
  return {
    shiftId: r.shift_id,
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
