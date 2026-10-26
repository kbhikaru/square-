import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { App } from "./app.ts";
import { COMPANY, staffKey } from "./db.ts";
import { hasScopes } from "./google.ts";
import { teamMemberName, verifySquareSignature } from "./square.ts";
import { formatSummary } from "./sync.ts";
import { renderDashboard, renderLinkIssued, renderStaffPage } from "./views.ts";

export type HttpSettings = {
  baseUrl: string;
  adminPassword: string;
  webhookUrl: string;
  webhookSignatureKey: string;
  defaultStoreCalendarId: string;
};

const SHIFT_EVENT_TYPES = new Set([
  "labor.scheduled_shift.created",
  "labor.scheduled_shift.updated",
  "labor.scheduled_shift.published",
  "labor.scheduled_shift.deleted",
]);

/** スタッフ用連携リンクの有効期限 */
const LINK_TTL_MS = 14 * 24 * 3600_000;

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function createHandler(app: App, s: HttpSettings) {
  const secureCookie = s.baseUrl.startsWith("https://") ? "; Secure" : "";
  const stateCookie = (v: string, maxAge: number) =>
    `oauth_state=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie}`;

  /** Google認可画面へ送り出す（会社・スタッフ共通） */
  function startOAuth(res: ServerResponse, purpose: "company" | "staff", teamMemberId: string | null, loginHint?: string) {
    const state = randomBytes(16).toString("hex");
    app.store.saveOAuthState(state, { purpose, teamMemberId });
    res.setHeader("Set-Cookie", stateCookie(state, 900));
    return redirect(res, app.oauth.authUrl(state, purpose, loginHint));
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", s.baseUrl);
    const route = `${req.method} ${url.pathname}`;

    try {
      // ================= 認証不要 =================
      if (route === "GET /healthz") return send(res, 200, "ok", "text/plain");
      if (route === "POST /webhooks/square") return await handleWebhook(req, res);
      if (route === "GET /auth/google/callback") return await handleCallback(req, res, url);

      // スタッフ向け: 連携リンク
      const connect = url.pathname.match(/^\/connect\/([A-Za-z0-9_-]{20,})(\/start)?$/);
      if (req.method === "GET" && connect) {
        const teamMemberId = app.store.findStaffLinkToken(hashToken(connect[1]));
        if (!teamMemberId) {
          return send(res, 410, renderStaffPage({ kind: "expired" }), "text/html");
        }
        const member = (await app.square.listTeamMembers().catch(() => [])).find((m) => m.id === teamMemberId);
        if (!connect[2]) {
          return send(res, 200, renderStaffPage({ kind: "landing", name: teamMemberName(member), startUrl: `${url.pathname}/start` }), "text/html");
        }
        if (!app.oauth.configured) return send(res, 503, "Google連携が設定されていません", "text/plain");
        return startOAuth(res, "staff", teamMemberId, member?.email_address ?? undefined);
      }

      // ================= ここから管理者のみ =================
      if (!isAdmin(req, s.adminPassword)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Shift Calendar Admin", charset="UTF-8"');
        return send(res, 401, "認証が必要です", "text/plain");
      }
      if (req.method === "POST" && !isSameOrigin(req, s.baseUrl)) {
        return send(res, 403, "不正なリクエスト元です", "text/plain");
      }
      const form = req.method === "POST" ? new URLSearchParams(await readBody(req)) : new URLSearchParams();

      switch (route) {
        case "GET /": {
          const html = await renderDashboard(app, {
            flash: url.searchParams.get("msg"),
            webhookUrl: s.webhookUrl,
            webhookEnabled: Boolean(s.webhookSignatureKey),
            defaultStoreCalendarId: s.defaultStoreCalendarId,
          });
          return send(res, 200, html, "text/html");
        }

        case "GET /auth/google": {
          if (!app.oauth.configured) return back(res, "GOOGLE_CLIENT_ID / SECRET を設定してください");
          return startOAuth(res, "company", null);
        }

        case "POST /auth/google/disconnect": {
          const account = app.store.getGoogleAccount(COMPANY);
          if (account) await app.oauth.revoke(account.refreshToken);
          app.store.deleteGoogleAccount(COMPANY);
          return back(res, "会社アカウントの連携を解除しました");
        }

        case "POST /sync": {
          const summary = await app.sync.syncRange("manual");
          return back(res, `同期しました: ${formatSummary(summary)}`);
        }

        case "POST /locations/calendar": {
          const locationId = form.get("location_id") ?? "";
          const value = form.get("calendar_id") ?? "__default__";
          if (!locationId) return back(res, "店舗IDがありません");
          // "__default__" = 既定に戻す, "__none__" = 書き込まない, それ以外 = カレンダーID
          app.store.setLocationCalendar(locationId, value === "__default__" ? null : value === "__none__" ? "" : value);
          return back(res, "店舗カレンダーの割り当てを保存しました（次回同期から反映）");
        }

        case "POST /staff/email": {
          const teamMemberId = form.get("team_member_id") ?? "";
          const email = (form.get("email") ?? "").trim();
          if (!teamMemberId) return back(res, "スタッフIDがありません");
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return back(res, `メールアドレスの形式が正しくありません: ${email}`);
          }
          app.store.setEmailOverride(teamMemberId, email || null);
          return back(res, email ? `招待先を ${email} に設定しました（次回同期から反映）` : "招待先の上書きを解除しました");
        }

        case "POST /staff/link": {
          const teamMemberId = form.get("team_member_id") ?? "";
          if (!teamMemberId) return back(res, "スタッフIDがありません");
          const token = randomBytes(24).toString("base64url");
          app.store.saveStaffLinkToken(hashToken(token), teamMemberId, Date.now() + LINK_TTL_MS);
          const member = (await app.square.listTeamMembers().catch(() => [])).find((m) => m.id === teamMemberId);
          // リンクはURL履歴に残さないよう、リダイレクトせずこの場で表示する
          return send(
            res,
            200,
            renderLinkIssued({ name: teamMemberName(member) || teamMemberId, link: `${s.baseUrl}/connect/${token}`, days: LINK_TTL_MS / 86400_000 }),
            "text/html",
          );
        }

        case "POST /staff/disconnect": {
          const teamMemberId = form.get("team_member_id") ?? "";
          const account = teamMemberId ? app.store.getGoogleAccount(staffKey(teamMemberId)) : null;
          if (!account) return back(res, "このスタッフは連携されていません");
          // 本人のカレンダーから今後のシフト予定を消してから解除（解除後は消せないため）
          const removed = account.invalid ? 0 : await app.sync.removeStaffEvents(teamMemberId);
          await app.oauth.revoke(account.refreshToken);
          app.store.deleteGoogleAccount(staffKey(teamMemberId));
          return back(res, `${account.email} の連携を解除しました（本人のカレンダーから${removed}件の予定を削除）`);
        }
      }
      return send(res, 404, "Not Found", "text/plain");
    } catch (e) {
      console.error(`[${route}]`, e);
      if (req.method === "GET") return send(res, 500, "エラーが発生しました", "text/plain");
      return back(res, `エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  async function handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const cookieState = parseCookies(req.headers.cookie).oauth_state ?? "";
    res.setHeader("Set-Cookie", stateCookie("", 0));

    // stateがこのブラウザで発行したものか確認（CSRF対策）。DBの記録は1回限り
    const saved = state && safeEqual(state, cookieState) ? app.store.takeOAuthState(state) : null;
    if (!saved) {
      return send(res, 400, renderStaffPage({ kind: "error", message: "連携に失敗しました（state不一致・期限切れ）。もう一度最初からお試しください。" }), "text/html");
    }
    const isStaff = saved.purpose === "staff" && saved.teamMemberId;
    const fail = (message: string) =>
      isStaff ? send(res, 400, renderStaffPage({ kind: "error", message }), "text/html") : back(res, message);

    if (url.searchParams.get("error")) return fail(`Google連携がキャンセルされました（${url.searchParams.get("error")}）`);
    const code = url.searchParams.get("code");
    if (!code) return fail("認可コードがありません");

    const tokens = await app.oauth.exchangeCode(code);
    if (!hasScopes(tokens.scopes, saved.purpose)) {
      await app.oauth.revoke(tokens.refreshToken);
      return fail("カレンダーへのアクセスが許可されませんでした。同意画面ですべての項目にチェックを入れてください。");
    }

    if (isStaff) {
      app.store.saveGoogleAccount(staffKey(saved.teamMemberId!), tokens);
      app.store.deleteStaffLinkTokens(saved.teamMemberId!);
      // すぐ本人のカレンダーに反映（招待方式からの切り替えも含む）
      void app.sync.syncRange("staff-linked").catch((e) => console.error("[sync after staff link]", e));
      return send(res, 200, renderStaffPage({ kind: "done", email: tokens.email }), "text/html");
    }

    app.store.saveGoogleAccount(COMPANY, tokens);
    return back(res, `会社アカウント ${tokens.email} と連携しました`);
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const ok = verifySquareSignature({
      signatureKey: s.webhookSignatureKey,
      notificationUrl: s.webhookUrl,
      rawBody: raw,
      signature: header(req, "x-square-hmacsha256-signature"),
    });
    if (!ok) return send(res, 403, "invalid signature", "text/plain");

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return send(res, 400, "invalid json", "text/plain");
    }
    // Squareには先に200を返し（再送防止）、同期は裏で行う
    send(res, 200, "ok", "text/plain");

    const shiftId: string | undefined = event?.data?.id;
    if (!SHIFT_EVENT_TYPES.has(event?.type) || !shiftId) return;

    const shift = event.type === "labor.scheduled_shift.deleted" ? null : undefined; // undefined = 最新をSquareから取得
    app.sync
      .syncShiftById(shiftId, shift)
      .then((r) => console.log(`[webhook] ${event.type} ${shiftId} →`, r))
      .catch((e) => console.error(`[webhook] ${event.type} ${shiftId} failed`, e));
  }
}

// ---------------- helpers ----------------

function isAdmin(req: IncomingMessage, password: string): boolean {
  if (!password) return false; // パスワード未設定なら管理画面は開かない
  const auth = header(req, "authorization") ?? "";
  if (!auth.startsWith("Basic ")) return false;
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  return sep >= 0 && safeEqual(decoded.slice(0, sep), "admin") && safeEqual(decoded.slice(sep + 1), password);
}

/** フォーム送信が自サイトからか確認（CSRF対策） */
function isSameOrigin(req: IncomingMessage, baseUrl: string): boolean {
  const expected = new URL(baseUrl).origin;
  const origin = header(req, "origin");
  if (origin) return origin === expected;
  const referer = header(req, "referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function parseCookies(cookie: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("リクエストが大きすぎます");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

/** 管理画面に戻ってメッセージを表示 */
function back(res: ServerResponse, message: string): void {
  redirect(res, "/?msg=" + encodeURIComponent(message));
}
