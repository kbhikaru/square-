import { createServer } from "node:http";
import { config, googleRedirectUri, webhookUrl } from "./config.ts";
import { createApp } from "./app.ts";
import { createHandler } from "./http.ts";
import { formatSummary } from "./sync.ts";

const app = createApp();

if (!config.adminPassword) {
  console.warn("⚠ ADMIN_PASSWORD が未設定のため、管理画面にはログインできません。");
}

const handler = createHandler(app, {
  baseUrl: config.baseUrl,
  adminPassword: config.adminPassword,
  webhookUrl: webhookUrl(),
  webhookSignatureKey: config.square.webhookSignatureKey,
});

createServer((req, res) => void handler(req, res)).listen(config.port, () => {
  console.log(`管理画面:          ${config.baseUrl}/  (ユーザー名: admin)`);
  console.log(`GoogleリダイレクトURI: ${googleRedirectUri()}`);
  console.log(`Square Webhook URL:  ${webhookUrl()}`);
});

// 定期同期（Webhookの取りこぼし対策も兼ねる）
if (config.sync.intervalMinutes > 0) {
  const tick = async () => {
    if (!app.store.getGoogleAccount() || !config.square.accessToken) return;
    const summary = await app.sync.syncRange("scheduled");
    console.log(`[sync] ${formatSummary(summary)}`);
  };
  setTimeout(() => void tick().catch(console.error), 5_000);
  setInterval(() => void tick().catch(console.error), config.sync.intervalMinutes * 60_000);
}
