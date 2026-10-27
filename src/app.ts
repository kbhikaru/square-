import { config, googleRedirectUri } from "./config.ts";
import { Store } from "./db.ts";
import { GoogleCalendarGateway, GoogleOAuth, getAccessToken } from "./google.ts";
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
  const calendar = new GoogleCalendarGateway({ getToken: (key) => getAccessToken(store, oauth, key) });
  const sync = new SyncService({
    store,
    square,
    calendar,
    settings: {
      daysAhead: config.sync.daysAhead,
      defaultTimezone: config.sync.defaultTimezone,
      titleTemplate: config.sync.titleTemplate,
      locationIds: config.square.locationIds,
      defaultStoreCalendarId: config.google.defaultStoreCalendarId,
    },
  });
  return { store, square, oauth, calendar, sync };
}

export type App = ReturnType<typeof createApp>;
