import { config, googleRedirectUri, hosting, webhookUrl } from "./config.ts";
import { COMPANY, type Store } from "./db.ts";

export type SetupCheck = {
  ok: boolean;
  /** 必須でない項目（未設定でも動く） */
  optional?: boolean;
  label: string;
  detail?: string;
  /** コピーして他サービスに貼り付ける値 */
  copy?: { label: string; value: string };
};

/** 管理画面に出す「セットアップ状況」 */
export function buildSetupChecks(store: Store): SetupCheck[] {
  const isLocal = hosting.platform === "local";
  const persistent = isLocal || Boolean(hosting.volume) || Boolean(process.env.DATABASE_PATH);
  return [
    {
      ok: config.baseUrl.startsWith("https://") || isLocal,
      label: "公開URL（HTTPS）",
      detail: `${config.baseUrl}（${hosting.platform}）`,
    },
    {
      ok: persistent,
      label: "データの保存先",
      detail: persistent
        ? config.databasePath
        : "再起動で連携情報が消えます。Railwayの場合はサービスに Volume を追加し、マウント先を /data にしてください",
    },
    {
      ok: Boolean(config.square.accessToken),
      label: `Square アクセストークン（${config.square.environment === "production" ? "本番" : "サンドボックス"}）`,
      detail: config.square.accessToken ? undefined : "環境変数 SQUARE_ACCESS_TOKEN を設定してください",
    },
    {
      ok: Boolean(config.square.webhookSignatureKey),
      optional: true,
      label: "Square Webhook（即時反映。無くても15分ごとに同期）",
      detail: config.square.webhookSignatureKey ? undefined : "SquareでWebhookを登録し、Signature key を SQUARE_WEBHOOK_SIGNATURE_KEY に設定",
      copy: { label: "Webhookの通知先URL", value: webhookUrl() },
    },
    {
      ok: Boolean(config.google.clientId && config.google.clientSecret),
      label: "Google OAuth クライアント",
      detail: config.google.clientId ? undefined : "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定してください",
      copy: { label: "承認済みのリダイレクトURI", value: googleRedirectUri() },
    },
    {
      ok: Boolean(store.getActiveGoogleAccount(COMPANY)),
      label: "会社アカウントの連携",
      detail: store.getActiveGoogleAccount(COMPANY) ? undefined : "下の「1. 会社アカウント」から連携してください",
    },
  ];
}
