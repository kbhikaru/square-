import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { App } from "./app.ts";
import { verifySquareSignature } from "./square.ts";
import { formatSummary } from "./sync.ts";
import { renderDashboard } from "./views.ts";

export type HttpSettings = {
  baseUrl: string;
  adminPassword: string;
  webhookUrl: string;
  webhookSignatureKey: string;
};

const SHIFT_EVENT_TYPES = new Set([
  "labor.scheduled_shift.created",
  "labor.scheduled_shift.updated",
  "labor.scheduled_shift.published",
  "labor.scheduled_shift.deleted",
]);

export function createHandler(app: App, s: HttpSettings) {
  const secureCookie = s.baseUrl.startsWith("https://") ? "; Secure" : "";

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", s.baseUrl);
    const route = `${req.method} ${url.pathname}`;

    try {
      // ---- 認証不要 ----
      if (route === "GET /healthz") return send(res, 200, "ok", "text/plain");
      if (route === "POST /webhooks/square") return await handleWebhook(req, res);

      // ---- ここから管理者のみ ----
      if (!isAdmin(req, s.adminPassword)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Shift Calendar Admin", charset="UTF-8"');
        return send(res, 401, "認証が必要です", "text/plain");
      }
      if (req.method === "POST" && !isSameOrigin(req, s.baseUrl)) {
        return send(res, 403, "不正なリクエスト元です", "text/plain");
      }

      switch (route) {
        case "GET /": {
          const html = await renderDashboard(app, {
            flash: url.searchParams.get("msg"),
            webhookUrl: s.webhookUrl,
            webhookEnabled: Boolean(s.webhookSignatureKey),
          });
          return send(res, 200, html, "text/html");
        }

        case "GET /auth/google": {
          if (!app.oauth.configured) return redirect(res, "/?msg=" + enc("GOOGLE_CLIENT_ID / SECRET を設定してください"));
          const state = randomBytes(16).toString("hex");
          res.setHeader("Set-Cookie", `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${secureCookie}`);
          return redirect(res, app.oauth.authUrl(state));
        }

        case "GET /auth/google/callback": {
          const state = url.searchParams.get("state") ?? "";
          const cookieState = parseCookies(req.headers.cookie).oauth_state ?? "";
          res.setHeader("Set-Cookie", `oauth_state=; HttpOnly; Path=/auth/google; Max-Age=0${secureCookie}`);
          if (url.searchParams.get("error")) return redirect(res, "/?msg=" + enc(`Google連携がキャンセルされました（${url.searchParams.get("error")}）`));
          if (!state || !safeEqual(state, cookieState)) return redirect(res, "/?msg=" + enc("連携に失敗しました（state不一致）。もう一度お試しください"));
          const code = url.searchParams.get("code");
          if (!code) return redirect(res, "/?msg=" + enc("認可コードがありません"));

          const tokens = await app.oauth.exchangeCode(code);
          app.store.saveGoogleAccount(tokens);
          return redirect(res, "/?msg=" + enc(`Googleアカウント ${tokens.email} と連携しました`));
        }

        case "POST /auth/google/disconnect": {
          const account = app.store.getGoogleAccount();
          if (account) await app.oauth.revoke(account.refreshToken);
          app.store.deleteGoogleAccount();
          return redirect(res, "/?msg=" + enc("Googleアカウントの連携を解除しました"));
        }

        case "POST /sync": {
          if (!app.store.getGoogleAccount()) return redirect(res, "/?msg=" + enc("先にGoogleアカウントを連携してください"));
          const summary = await app.sync.syncRange("manual");
          return redirect(res, "/?msg=" + enc(`同期しました: ${formatSummary(summary)}`));
        }

        case "POST /staff/email": {
          const form = new URLSearchParams(await readBody(req));
          const teamMemberId = form.get("team_member_id") ?? "";
          const email = (form.get("email") ?? "").trim();
          if (!teamMemberId) return redirect(res, "/?msg=" + enc("スタッフIDがありません"));
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return redirect(res, "/?msg=" + enc(`メールアドレスの形式が正しくありません: ${email}`));
          }
          app.store.setEmailOverride(teamMemberId, email || null);
          return redirect(res, "/?msg=" + enc(email ? `招待先を ${email} に設定しました（次回同期から反映）` : "招待先の上書きを解除しました"));
        }
      }
      return send(res, 404, "Not Found", "text/plain");
    } catch (e) {
      console.error(`[${route}]`, e);
      if (req.method === "GET" && url.pathname === "/") return send(res, 500, "エラーが発生しました", "text/plain");
      return redirect(res, "/?msg=" + enc(`エラー: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

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
    if (!app.store.getGoogleAccount()) return;

    const shift = event.type === "labor.scheduled_shift.deleted" ? null : undefined; // undefined = 最新をSquareから取得
    app.sync
      .syncShiftById(shiftId, shift)
      .then((r) => console.log(`[webhook] ${event.type} ${shiftId} → ${r}`))
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

function enc(s: string): string {
  return encodeURIComponent(s);
}
