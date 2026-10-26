import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/db.ts";
import { createHandler } from "../src/http.ts";
import { verifySquareSignature } from "../src/square.ts";
import type { App } from "../src/app.ts";

const KEY = "test-signature-key";
const WEBHOOK_URL = "https://shifts.example.com/webhooks/square";

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

async function startServer() {
  const store = new Store(":memory:");
  store.saveGoogleAccount({ email: "shop@example.com", refreshToken: "r", accessToken: "a", expiresAt: Date.now() + 3600_000 });
  const synced: [string, unknown][] = [];
  const app = {
    store,
    sync: {
      syncShiftById: async (id: string, shift: unknown) => {
        synced.push([id, shift]);
        return "created";
      },
    },
  } as unknown as App;
  const handler = createHandler(app, {
    baseUrl: "https://shifts.example.com",
    adminPassword: "pw",
    webhookUrl: WEBHOOK_URL,
    webhookSignatureKey: KEY,
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, synced };
}

test("Webhook: 署名が正しければシフトを同期、不正なら403", async (t) => {
  const { server, base, synced } = await startServer();
  t.after(() => server.close());

  const body = JSON.stringify({ type: "labor.scheduled_shift.published", data: { id: "SHIFT1" } });
  const ok = await fetch(`${base}/webhooks/square`, {
    method: "POST",
    body,
    headers: { "x-square-hmacsha256-signature": sign(body) },
  });
  assert.equal(ok.status, 200);

  const del = JSON.stringify({ type: "labor.scheduled_shift.deleted", data: { id: "SHIFT2", deleted: true } });
  await fetch(`${base}/webhooks/square`, { method: "POST", body: del, headers: { "x-square-hmacsha256-signature": sign(del) } });

  const bad = await fetch(`${base}/webhooks/square`, {
    method: "POST",
    body,
    headers: { "x-square-hmacsha256-signature": "nope" },
  });
  assert.equal(bad.status, 403);

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(synced, [
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

  const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
  const csrf = await fetch(`${base}/sync`, {
    method: "POST",
    headers: { Authorization: auth, Origin: "https://evil.example.com" },
    redirect: "manual",
  });
  assert.equal(csrf.status, 403);
});

test("Google連携: stateが一致しないコールバックは拒否", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
  const res = await fetch(`${base}/auth/google/callback?code=abc&state=xyz`, {
    headers: { Authorization: auth, Cookie: "oauth_state=different" },
    redirect: "manual",
  });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get("location")!), /state不一致/);
});
