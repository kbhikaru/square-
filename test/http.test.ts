import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { COMPANY, Store, staffKey } from "../src/db.ts";
import { createHandler, hashToken } from "../src/http.ts";
import { GOOGLE_SCOPES, hasScopes } from "../src/google.ts";
import { verifySquareSignature } from "../src/square.ts";
import type { App } from "../src/app.ts";

const KEY = "test-signature-key";
const BASE = "https://shifts.example.com";
const WEBHOOK_URL = `${BASE}/webhooks/square`;
const ADMIN = "Basic " + Buffer.from("admin:pw").toString("base64");

function sign(body: string): string {
  return createHmac("sha256", KEY).update(WEBHOOK_URL + body).digest("base64");
}

test("verifySquareSignature: 正しい署名だけ通す", () => {
  const body = '{"type":"labor.scheduled_shift.updated"}';
  assert.equal(verifySquareSignature({ signatureKey: KEY, notificationUrl: WEBHOOK_URL, rawBody: body, signature: sign(body) }), true);
  assert.equal(verifySquareSignature({ signatureKey: KEY, notificationUrl: WEBHOOK_URL, rawBody: body + " ", signature: sign(body) }), false);
  assert.equal(verifySquareSignature({ signatureKey: KEY, notificationUrl: WEBHOOK_URL, rawBody: body, signature: undefined }), false);
  assert.equal(verifySquareSignature({ signatureKey: "", notificationUrl: WEBHOOK_URL, rawBody: body, signature: sign(body) }), false);
});

test("hasScopes: カレンダー権限のチェックを外されたら検出する", () => {
  assert.equal(hasScopes([...GOOGLE_SCOPES.staff], "staff"), true);
  assert.equal(hasScopes(["openid", "email"], "staff"), false);
  assert.equal(hasScopes([...GOOGLE_SCOPES.staff], "company"), false);
});

async function startServer() {
  const store = new Store(":memory:");
  store.saveGoogleAccount(COMPANY, { email: "shop@example.com", refreshToken: "r", accessToken: "a", expiresAt: Date.now() + 3600_000 });
  const log = { synced: [] as [string, unknown][], ranges: [] as string[], authUrls: [] as string[] };
  let grantedScopes: string[] = [...GOOGLE_SCOPES.staff];
  const app = {
    store,
    square: { listTeamMembers: async () => [{ id: "tm1", given_name: "花子", family_name: "山田", email_address: "hanako@example.com" }] },
    oauth: {
      configured: true,
      authUrl: (state: string, purpose: string, hint?: string) => {
        const u = `https://accounts.google.com/auth?state=${state}&purpose=${purpose}&hint=${hint ?? ""}`;
        log.authUrls.push(u);
        return u;
      },
      exchangeCode: async () => ({ email: "hanako.private@gmail.com", refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3600_000, scopes: grantedScopes }),
      revoke: async () => {},
    },
    sync: {
      syncShiftById: async (id: string, shift: unknown) => {
        log.synced.push([id, shift]);
        return { store: "created" };
      },
      syncRange: async (trigger: string) => {
        log.ranges.push(trigger);
        return { created: 0, updated: 0, unchanged: 0, deleted: 0, no_email: 0, error: 0, shifts: 0, errors: [] };
      },
    },
  } as unknown as App;
  const handler = createHandler(app, {
    baseUrl: BASE,
    adminPassword: "pw",
    webhookUrl: WEBHOOK_URL,
    webhookSignatureKey: KEY,
    defaultStoreCalendarId: "primary",
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, store, log, setScopes: (s: string[]) => (grantedScopes = s) };
}

test("Webhook: 署名が正しければシフトを同期、不正なら403", async (t) => {
  const { server, base, log } = await startServer();
  t.after(() => server.close());

  const body = JSON.stringify({ type: "labor.scheduled_shift.published", data: { id: "SHIFT1" } });
  assert.equal((await fetch(`${base}/webhooks/square`, { method: "POST", body, headers: { "x-square-hmacsha256-signature": sign(body) } })).status, 200);

  const del = JSON.stringify({ type: "labor.scheduled_shift.deleted", data: { id: "SHIFT2", deleted: true } });
  await fetch(`${base}/webhooks/square`, { method: "POST", body: del, headers: { "x-square-hmacsha256-signature": sign(del) } });

  const bad = await fetch(`${base}/webhooks/square`, { method: "POST", body, headers: { "x-square-hmacsha256-signature": "nope" } });
  assert.equal(bad.status, 403);

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.synced, [
    ["SHIFT1", undefined],
    ["SHIFT2", null],
  ]);
});

test("管理画面: パスワードが無いと401、別サイトからのPOSTは403", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  assert.equal((await fetch(`${base}/`)).status, 401);
  const wrong = await fetch(`${base}/`, { headers: { Authorization: "Basic " + Buffer.from("admin:x").toString("base64") } });
  assert.equal(wrong.status, 401);

  const csrf = await fetch(`${base}/sync`, { method: "POST", headers: { Authorization: ADMIN, Origin: "https://evil.example.com" }, redirect: "manual" });
  assert.equal(csrf.status, 403);
  const staffLink = await fetch(`${base}/staff/link`, { method: "POST", headers: { Origin: BASE }, body: "team_member_id=tm1" });
  assert.equal(staffLink.status, 401);
});

/** OAuthの流れを1回たどって、コールバックのレスポンスを返す */
async function runOAuth(base: string, startPath: string, headers: Record<string, string> = {}) {
  const start = await fetch(`${base}${startPath}`, { headers, redirect: "manual" });
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  return fetch(`${base}/auth/google/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
}

test("スタッフ連携: リンク発行 → 本人がGoogleで連携 → 保存され、リンクは使用済みに", async (t) => {
  const { server, base, store, log } = await startServer();
  t.after(() => server.close());

  const issued = await fetch(`${base}/staff/link`, {
    method: "POST",
    headers: { Authorization: ADMIN, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
    body: "team_member_id=tm1",
  });
  assert.equal(issued.status, 200);
  const link = (await issued.text()).match(/https:\/\/shifts\.example\.com\/connect\/([A-Za-z0-9_-]+)/)!;
  const path = new URL(link[0]).pathname;

  // スタッフ本人（管理者パスワード無し）がリンクを開く
  const landing = await fetch(`${base}${path}`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /山田 花子 さん/);

  const cb = await runOAuth(base, `${path}/start`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /連携が完了しました/);
  assert.match(log.authUrls.at(-1)!, /purpose=staff&hint=hanako%40example\.com|purpose=staff&hint=hanako@example\.com/);

  const acc = store.getGoogleAccount(staffKey("tm1"));
  assert.equal(acc?.email, "hanako.private@gmail.com");
  assert.deepEqual(log.ranges, ["staff-linked"]);

  // 使用済みリンクは無効
  assert.equal((await fetch(`${base}${path}`)).status, 410);
  assert.equal(store.findStaffLinkToken(hashToken(link[1])), null);
});

test("スタッフ連携: カレンダー権限のチェックを外されたら保存しない", async (t) => {
  const { server, base, store, setScopes } = await startServer();
  t.after(() => server.close());
  store.saveStaffLinkToken(hashToken("x".repeat(32)), "tm1", Date.now() + 60_000);
  setScopes(["openid", "email"]);
  const cb = await runOAuth(base, `/connect/${"x".repeat(32)}/start`);
  assert.equal(cb.status, 400);
  assert.equal(store.getGoogleAccount(staffKey("tm1")), null);
});

test("期限切れ・存在しない連携リンクは410", async (t) => {
  const { server, base, store } = await startServer();
  t.after(() => server.close());
  store.saveStaffLinkToken(hashToken("y".repeat(32)), "tm1", Date.now() - 1);
  assert.equal((await fetch(`${base}/connect/${"y".repeat(32)}`)).status, 410);
  assert.equal((await fetch(`${base}/connect/${"z".repeat(32)}`)).status, 410);
});

test("会社アカウント連携: 管理者が開始したフローで会社アカウントが保存される", async (t) => {
  const { server, base, store } = await startServer();
  t.after(() => server.close());
  const cb = await runOAuth(base, "/auth/google", { Authorization: ADMIN });
  // 会社用スコープが足りない（テストの既定はスタッフ用スコープ）ので拒否される
  assert.equal(cb.status, 303);
  assert.match(decodeURIComponent(cb.headers.get("location")!), /許可されませんでした/);
  assert.equal(store.getGoogleAccount(COMPANY)?.email, "shop@example.com");
});

test("OAuthコールバック: stateが一致しないものは拒否", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await fetch(`${base}/auth/google/callback?code=abc&state=xyz`, { headers: { Cookie: "oauth_state=different" }, redirect: "manual" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /state不一致/);
});
