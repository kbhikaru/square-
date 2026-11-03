// Google Apps Script の実行環境（SpreadsheetApp / CalendarApp など）の最小限の偽物。
// gas/Code.gs を Node 上で動かしてテストするために使う。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

type Cell = unknown;

class FakeRange {
  readonly sheet: FakeSheet;
  readonly row: number;
  readonly col: number;
  readonly nr: number;
  readonly nc: number;
  constructor(sheet: FakeSheet, row: number, col: number, nr = 1, nc = 1) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${row},${col},${nr},${nc}`);
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.nr = nr;
    this.nc = nc;
  }
  getValues(): Cell[][] {
    const out: Cell[][] = [];
    for (let r = 0; r < this.nr; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < this.nc; c++) row.push(this.sheet.get(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  setValues(values: Cell[][]) {
    if (values.length !== this.nr || values.some((v) => v.length !== this.nc)) throw new Error("size mismatch");
    values.forEach((row, r) => row.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  getValue() {
    return this.sheet.get(this.row, this.col);
  }
  setValue(v: Cell) {
    this.sheet.set(this.row, this.col, v);
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet.set(this.row + r, this.col + c, "");
    return this;
  }
  getRow() {
    return this.row;
  }
  getColumn() {
    return this.col;
  }
  getSheet() {
    return this.sheet;
  }
  setFontWeight() {
    return this;
  }
  setDataValidation() {
    return this;
  }
  insertCheckboxes() {
    return this;
  }
}

export class FakeSheet {
  readonly name: string;
  readonly parent: FakeSpreadsheet;
  data: Cell[][] = [];
  hidden = false;
  constructor(name: string, parent: FakeSpreadsheet) {
    this.name = name;
    this.parent = parent;
  }
  get(r: number, c: number): Cell {
    const v = this.data[r - 1]?.[c - 1];
    return v === undefined ? "" : v;
  }
  set(r: number, c: number, v: Cell) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push("");
    // 先頭の ' は文字列扱いの印（スプレッドシートと同じく保存時に外す）
    row[c - 1] = typeof v === "string" && v.startsWith("'") ? v.slice(1) : v;
  }
  getName() {
    return this.name;
  }
  getParent() {
    return this.parent;
  }
  getRange(r: number, c: number, nr = 1, nc = 1) {
    return new FakeRange(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.data.length; i > 0; i--) if (this.data[i - 1].some((v) => v !== "" && v !== undefined)) return i;
    return 0;
  }
  getLastColumn() {
    return Math.max(0, ...this.data.map((r) => {
      for (let i = r.length; i > 0; i--) if (r[i - 1] !== "" && r[i - 1] !== undefined) return i;
      return 0;
    }));
  }
  getMaxRows() {
    return 1000;
  }
  appendRow(row: Cell[]) {
    const r = this.getLastRow() + 1;
    row.forEach((v, i) => this.set(r, i + 1, v));
    return this;
  }
  insertRowAfter(r: number) {
    this.data.splice(r, 0, []);
    return this;
  }
  deleteRows(start: number, n: number) {
    this.data.splice(start - 1, n);
  }
  setFrozenRows() {
    return this;
  }
  setColumnWidth() {
    return this;
  }
  hideSheet() {
    this.hidden = true;
    return this;
  }
  isSheetHidden() {
    return this.hidden;
  }
  /** テスト用: 2行目以降を、ヘッダー名をキーにしたオブジェクトで返す */
  rows(): Record<string, Cell>[] {
    const header = (this.data[0] ?? []) as string[];
    return this.data.slice(1, this.getLastRow()).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
  }
}

export class FakeSpreadsheet {
  sheets: FakeSheet[] = [];
  toasts: string[] = [];
  getSheetByName(name: string) {
    return this.sheets.find((s) => s.name === name) ?? null;
  }
  insertSheet(name: string) {
    const s = new FakeSheet(name, this);
    this.sheets.push(s);
    return s;
  }
  getSpreadsheetTimeZone() {
    return "Asia/Tokyo";
  }
  toast(msg: string) {
    this.toasts.push(msg);
  }
  sheet(name: string) {
    const s = this.getSheetByName(name);
    if (!s) throw new Error(`no sheet ${name}`);
    return s;
  }
  /** 設定シートの値を項目名で書き換える */
  setSetting(label: string, value: Cell) {
    const s = this.sheet("設定");
    for (let r = 2; r <= s.getLastRow(); r++) if (s.get(r, 1) === label) return s.set(r, 2, value);
    throw new Error(`no setting ${label}`);
  }
  setting(label: string) {
    const s = this.sheet("設定");
    for (let r = 2; r <= s.getLastRow(); r++) if (s.get(r, 1) === label) return s.get(r, 2);
    throw new Error(`no setting ${label}`);
  }
}

// ---------------- Calendar ----------------

let eventSeq = 0;

export class FakeEvent {
  readonly id = `ev${++eventSeq}@google.com`;
  title: string;
  start: Date;
  end: Date;
  description = "";
  location = "";
  guests: string[] = [];
  tags: Record<string, string> = {};
  invitesSent = false;
  /** Google Meet が付いているか（Workspaceの自動追加設定を再現） */
  meet = true;
  readonly calendar: FakeCalendar;
  constructor(cal: FakeCalendar, title: string, start: Date, end: Date) {
    this.calendar = cal;
    this.title = title;
    this.start = start;
    this.end = end;
  }
  getId() {
    return this.id;
  }
  setTitle(t: string) {
    this.title = t;
  }
  setTime(s: Date, e: Date) {
    this.start = s;
    this.end = e;
  }
  setDescription(d: string) {
    this.description = d;
  }
  setLocation(l: string) {
    this.location = l;
  }
  setTag(k: string, v: string) {
    this.tags[k] = v;
  }
  getGuestList() {
    return this.guests.map((g) => ({ getEmail: () => g }));
  }
  addGuest(g: string) {
    this.guests.push(g);
  }
  removeGuest(g: string) {
    this.guests = this.guests.filter((x) => x !== g);
  }
  deleteEvent() {
    this.calendar.events.delete(this.id);
  }
}

export class FakeCalendar {
  readonly id: string;
  readonly name: string;
  readonly owned: boolean;
  /** 共有の権限: edit = 予定の変更, read = 閲覧のみ */
  access: "edit" | "read";
  events = new Map<string, FakeEvent>();
  constructor(id: string, name: string, owned: boolean, access: "edit" | "read" = "edit") {
    this.id = id;
    this.name = name;
    this.owned = owned;
    this.access = access;
  }
  getId() {
    return this.id;
  }
  getName() {
    return this.name;
  }
  isOwnedByMe() {
    return this.owned;
  }
  createEvent(title: string, start: Date, end: Date, opts: { description?: string; location?: string; guests?: string; sendInvites?: boolean } = {}) {
    if (this.access !== "edit") throw new Error("Action not allowed: You do not have permission to edit this calendar");
    const ev = new FakeEvent(this, title, start, end);
    ev.description = opts.description ?? "";
    ev.location = opts.location ?? "";
    ev.guests = opts.guests ? opts.guests.split(",") : [];
    ev.invitesSent = Boolean(opts.sendInvites);
    this.events.set(ev.id, ev);
    return ev;
  }
  getEventById(id: string) {
    return this.events.get(id) ?? null;
  }
  list() {
    return [...this.events.values()];
  }
}

export class FakeCalendarApp {
  calendars = new Map<string, FakeCalendar>();
  /** 会社アカウントのカレンダー一覧に登録済み（購読済み）のID */
  subscribed = new Set<string>();
  readonly main: FakeCalendar;
  constructor(mainId = "shop@example.com") {
    this.main = this.add(new FakeCalendar(mainId, mainId, true));
  }
  add(cal: FakeCalendar, subscribed = cal.owned) {
    this.calendars.set(cal.id, cal);
    if (subscribed) this.subscribed.add(cal.id);
    return cal;
  }
  /** スタッフが自分のカレンダーを会社アカウントに共有した状態にする（未登録） */
  share(email: string, access: "edit" | "read" = "edit") {
    return this.add(new FakeCalendar(email, email, false, access), false);
  }
  unshare(email: string) {
    this.calendars.delete(email);
    this.subscribed.delete(email);
  }
  getCalendarById(id: string) {
    return this.subscribed.has(id) ? (this.calendars.get(id) ?? null) : null;
  }
  subscribeToCalendar(id: string) {
    const cal = this.calendars.get(id);
    if (!cal) throw new Error(`Calendar not found or no access: ${id}`);
    this.subscribed.add(id);
    return cal;
  }
  getAllOwnedCalendars() {
    return [...this.calendars.values()].filter((c) => c.owned);
  }
  getDefaultCalendar() {
    return this.main;
  }
}

// ---------------- Square ----------------

export type Shift = {
  id: string;
  published_shift_details?: Record<string, unknown>;
};

export class FakeSquare {
  shifts: Shift[] = [];
  members: Record<string, unknown>[] = [];
  locations: { id: string; name: string }[] = [];
  jobs: { id: string; title: string }[] = [];
  calls: string[] = [];
  token = "EAAA-token";

  fetch(url: string, opts: { method: string; headers: Record<string, string>; payload?: string }) {
    const path = url.replace(/^https:\/\/connect\.squareup(sandbox)?\.com/, "");
    this.calls.push(`${opts.method.toUpperCase()} ${path}`);
    const reply = (code: number, body: unknown) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
    if (opts.headers.Authorization !== `Bearer ${this.token}`) return reply(401, { errors: [{ code: "UNAUTHORIZED" }] });
    if (path === "/v2/labor/scheduled-shifts/search") return reply(200, { scheduled_shifts: this.shifts });
    const m = path.match(/^\/v2\/labor\/scheduled-shifts\/(.+)$/);
    if (m) {
      const s = this.shifts.find((x) => x.id === decodeURIComponent(m[1]));
      return s ? reply(200, { scheduled_shift: s }) : reply(404, { errors: [{ code: "NOT_FOUND" }] });
    }
    if (path === "/v2/team-members/search") return reply(200, { team_members: this.members });
    if (path === "/v2/locations") return reply(200, { locations: this.locations });
    if (path.startsWith("/v2/team-members/jobs")) return reply(200, { jobs: this.jobs });
    return reply(404, {});
  }
}

// ---------------- 実行環境の組み立て ----------------

export function loadGas() {
  const ss = new FakeSpreadsheet();
  const calendar = new FakeCalendarApp();
  const square = new FakeSquare();
  const props = new Map<string, string>();
  const cache = new Map<string, string>();
  const triggers: { handler: string; kind: string }[] = [];
  const meetCalls: string[] = [];
  const calendarApi = { disabled: false };
  const logs: string[] = [];

  const builder = (kind: string) => {
    const b: any = {
      timeBased: () => b,
      everyMinutes: () => b,
      forSpreadsheet: () => b,
      onEdit: () => b,
      create: () => {
        triggers.push({ handler: b.handler, kind });
        return {};
      },
    };
    return b;
  };

  const validation: any = {
    requireValueInList: () => validation,
    setAllowInvalid: () => validation,
    build: () => ({}),
  };

  const context: Record<string, unknown> = {
    console,
    SpreadsheetApp: {
      getActive: () => ss,
      newDataValidation: () => validation,
      getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) }),
    },
    CalendarApp: calendar,
    UrlFetchApp: {
      fetch: (url: string, opts: any) => {
        // Google Calendar API（Meet を外すための GET / PUT）
        const m = url.match(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events\/([^?]+)(?:\?(.*))?$/);
        if (m) {
          const reply = (code: number, body: unknown) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
          meetCalls.push(`${opts.method.toUpperCase()} ${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
          if (calendarApi.disabled) {
            return reply(403, { error: { code: 403, message: "Google Calendar API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } });
          }
          if (opts.headers?.Authorization !== "Bearer fake-oauth-token") return reply(401, {});
          const cal = calendar.calendars.get(decodeURIComponent(m[1]));
          const ev = cal?.getEventById(`${decodeURIComponent(m[2])}@google.com`);
          if (!ev) return reply(404, { error: { code: 404 } });
          if (opts.method === "get") {
            return reply(200, {
              id: decodeURIComponent(m[2]),
              summary: ev.title,
              ...(ev.meet ? { hangoutLink: "https://meet.google.com/abc-defg-hij", conferenceData: { conferenceId: "abc-defg-hij" } } : {}),
            });
          }
          if (opts.method === "put") {
            const body = JSON.parse(opts.payload);
            if (/conferenceDataVersion=1/.test(m[3] ?? "") && !body.conferenceData) ev.meet = false;
            return reply(200, body);
          }
          return reply(405, {});
        }
        return square.fetch(url, opts);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => props.set(k, v),
        deleteProperty: (k: string) => props.delete(k),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cache.get(k) ?? null,
        put: (k: string, v: string) => cache.set(k, v),
      }),
    },
    Logger: { log: (m: string) => logs.push(m) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: {
      getOAuthToken: () => "fake-oauth-token",
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler })),
      deleteTrigger: (t: { getHandlerFunction: () => string }) => {
        const i = triggers.findIndex((x) => x.handler === t.getHandlerFunction());
        if (i >= 0) triggers.splice(i, 1);
      },
      newTrigger: (handler: string) => {
        const b = builder("trigger");
        b.handler = handler;
        return b;
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_alg: string, text: string) => [...createHash("sha256").update(text).digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d: Date, tz: string, pattern: string) => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
            .formatToParts(d)
            .map((p) => [p.type, p.value]),
        );
        return pattern === "M/d HH:mm" ? `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}` : d.toISOString();
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../gas/Code.gs", import.meta.url), "utf8"), context, { filename: "Code.gs" });
  const gas = context as any;

  return { gas, ss, calendar, square, props, cache, triggers, meetCalls, calendarApi, logs };
}
