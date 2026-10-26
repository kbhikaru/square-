import { config, googleRedirectUri } from "./config.ts";
import { Store } from "./db.ts";
import { GoogleCalendarClient, GoogleOAuth, getAccessToken } from "./google.ts";
import { SquareClient } from "./square.ts";
import { SyncService } from "./sync.ts";

/** 設定値から各部品を組み立てる */
export function createApp() {
  const store = new Store(config.databasePath);
  const square = new SquareClient({
    accessToken: config.square.accessToken,
    baseUrl: config.square.baseUrl,
    apiVersion: config.square.apiVersion,
  });
  const oauth = new GoogleOAuth({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: googleRedirectUri(),
  });
  const calendar = new GoogleCalendarClient({
    calendarId: config.google.calendarId,
    getToken: () => getAccessToken(store, oauth),
  });
  const sync = new SyncService({
    store,
    square,
    calendar: () => calendar,
    settings: {
      daysAhead: config.sync.daysAhead,
      defaultTimezone: config.sync.defaultTimezone,
      titlePrefix: config.sync.titlePrefix,
      locationIds: config.square.locationIds,
    },
  });
  return { store, square, oauth, sync };
}

export type App = ReturnType<typeof createApp>;
