import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

/** 動いているサーバー環境を判定し、公開URLと保存先を自動で決める */
function detectHosting() {
  const env = process.env;
  const platform = env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID
    ? "Railway"
    : env.RENDER
      ? "Render"
      : env.FLY_APP_NAME
        ? "Fly.io"
        : env.K_SERVICE
          ? "Cloud Run"
          : "local";
  const autoBaseUrl = env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
    : env.RENDER_EXTERNAL_URL
      ? env.RENDER_EXTERNAL_URL
      : env.FLY_APP_NAME
        ? `https://${env.FLY_APP_NAME}.fly.dev`
        : `http://localhost:${env.PORT || 3000}`;
  // 永続ディスク（Railway Volume など）があればそこにDBを置く
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || "";
  return { platform, autoBaseUrl, volume };
}

export const hosting = detectHosting();

export const config = {
  port: int("PORT", 3000),
  baseUrl: str("BASE_URL", hosting.autoBaseUrl).replace(/\/$/, ""),
  adminPassword: str("ADMIN_PASSWORD"),
  databasePath: str("DATABASE_PATH", hosting.volume ? `${hosting.volume.replace(/\/$/, "")}/app.db` : "./data/app.db"),

  square: {
    accessToken: str("SQUARE_ACCESS_TOKEN"),
    environment: str("SQUARE_ENVIRONMENT", "sandbox") === "production" ? "production" : "sandbox",
    baseUrl:
      str("SQUARE_ENVIRONMENT", "sandbox") === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com",
    apiVersion: "2026-09-16",
    webhookSignatureKey: str("SQUARE_WEBHOOK_SIGNATURE_KEY"),
    locationIds: str("SQUARE_LOCATION_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  google: {
    clientId: str("GOOGLE_CLIENT_ID"),
    clientSecret: str("GOOGLE_CLIENT_SECRET"),
    // 店舗ごとの割り当てが無い場合に使う、会社アカウント内のカレンダーID（空なら書き込まない）
    defaultStoreCalendarId: str("STORE_CALENDAR_ID", "primary"),
  },

  sync: {
    daysAhead: int("SYNC_DAYS_AHEAD", 30),
    intervalMinutes: int("SYNC_INTERVAL_MINUTES", 15),
    defaultTimezone: str("DEFAULT_TIMEZONE", "Asia/Tokyo"),
    // 予定タイトル。{name}=氏名, {location}=店舗名, {job}=職種
    titleTemplate: str("EVENT_TITLE_TEMPLATE", "【出勤】{name}"),
  },
};

export type Config = typeof config;

export function googleRedirectUri(): string {
  return `${config.baseUrl}/auth/google/callback`;
}

export function staffConnectUrl(token: string): string {
  return `${config.baseUrl}/connect/${token}`;
}

export function webhookUrl(): string {
  return `${config.baseUrl}/webhooks/square`;
}
