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

export const config = {
  port: int("PORT", 3000),
  baseUrl: str("BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
  adminPassword: str("ADMIN_PASSWORD"),
  databasePath: str("DATABASE_PATH", "./data/app.db"),

  square: {
    accessToken: str("SQUARE_ACCESS_TOKEN"),
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
    titlePrefix: str("EVENT_TITLE_PREFIX", "【シフト】"),
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
