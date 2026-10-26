# Squareシフト → Googleカレンダー招待 連携

Squareで**公開したシフト**を、担当スタッフのメールアドレス宛てに**Googleカレンダーの招待**として自動送信するサーバーです。

- 店舗のGoogleアカウントを管理画面から連携（OAuth）
- Squareのスタッフ情報のメールアドレスに招待を送信（管理画面で上書きも可能）
- シフトの時間変更・担当者変更・削除も、予定の更新・取り消しとして反映
- Square Webhookで即時反映 ＋ 定期同期（取りこぼし対策）

```
Square（シフト公開） ──Webhook/定期同期──▶ このサーバー ──Calendar API──▶ 店舗のGoogleカレンダー
                                                                     └─ 招待メール ▶ スタッフ
```

## 動作の仕組み

| Square側の操作 | Googleカレンダー側 |
| --- | --- |
| シフトを公開 | 店舗カレンダーに予定を作成し、スタッフを招待（招待メールが届く） |
| 公開済みシフトの時間・メモを変更して再公開 | 予定を更新（変更通知が届く） |
| 担当スタッフを変更 | 招待先を差し替え（前の担当者には取り消し通知） |
| シフトを削除 | 予定を削除（取り消し通知が届く） |
| 下書きのみのシフト | 何もしない（公開されるまで送らない） |

- 招待先は「管理画面で設定したアドレス」→「Squareのスタッフ情報のメールアドレス」の順で決まります。
- メールアドレスが無いスタッフのシフトは送らず、管理画面に「メール未登録」と表示します。
- 予定IDはシフトIDから決まるため、同じシフトの予定が二重に作られることはありません。

## 必要なもの

- Node.js 22.18 以上（TypeScriptをビルドなしで実行します。実行時の外部ライブラリは不要）
- Squareのアクセストークン（権限: `TIMECARDS_READ`, `EMPLOYEES_READ`, `MERCHANT_PROFILE_READ`）
- Google Cloud の OAuth クライアント

## セットアップ

### 1. Square

1. [Square Developer Dashboard](https://developer.squareup.com/apps) でアプリを作成し、**アクセストークン**を控える
2. （任意・推奨）Webhooks → サブスクリプションを追加
   - URL: `https://<あなたのドメイン>/webhooks/square`
   - イベント: `labor.scheduled_shift.published`, `labor.scheduled_shift.updated`, `labor.scheduled_shift.deleted`
   - 作成後に表示される **Signature key** を控える

### 2. Google Cloud

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「APIとサービス」→「ライブラリ」で **Google Calendar API** を有効化
3. 「OAuth 同意画面」を設定（スコープ: `calendar.events`）
   - 「テスト」状態のままだとリフレッシュトークンが7日で失効するため、本番運用時は「本番環境」に公開してください
4. 「認証情報」→「OAuth クライアントID」→ 種類 **ウェブアプリケーション**
   - 承認済みリダイレクトURI: `https://<あなたのドメイン>/auth/google/callback`
5. クライアントID とシークレットを控える

### 3. このサーバー

```bash
npm install          # 型チェック用の開発ツールのみ
cp .env.example .env # 値を記入
npm start
```

ブラウザで `BASE_URL` を開き、ユーザー名 `admin` / `ADMIN_PASSWORD` でログインします。

1. 「Googleアカウントと連携する」→ 予定を作るアカウント（店舗の共有アカウント推奨）でログイン
2. スタッフ一覧で、招待先のメールアドレスを確認（GoogleアカウントのアドレスとSquareの登録が違う人は上書き）
3. 「今すぐ同期」

以降は Webhook と定期同期（既定15分ごと）で自動反映されます。

## 設定（.env）

| 変数 | 説明 | 既定値 |
| --- | --- | --- |
| `BASE_URL` | 外部から見たURL（リダイレクトURI・Webhook署名に使用） | `http://localhost:3000` |
| `ADMIN_PASSWORD` | 管理画面のパスワード（未設定だと管理画面は開けません） | — |
| `SQUARE_ACCESS_TOKEN` | Squareのアクセストークン | — |
| `SQUARE_ENVIRONMENT` | `production` / `sandbox` | `sandbox` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Webhookの署名キー | — |
| `SQUARE_LOCATION_IDS` | 対象店舗の絞り込み（カンマ区切り） | 全店舗 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuthクライアント | — |
| `GOOGLE_CALENDAR_ID` | 予定を作るカレンダー | `primary` |
| `SYNC_DAYS_AHEAD` | 何日先まで同期するか | `30` |
| `SYNC_INTERVAL_MINUTES` | 定期同期の間隔（0で無効） | `15` |
| `DEFAULT_TIMEZONE` | シフトにタイムゾーンが無い場合 | `Asia/Tokyo` |
| `EVENT_TITLE_PREFIX` | 予定タイトルの接頭辞 | `【シフト】` |

cron等で1回だけ同期したい場合は `npm run sync` を使えます。

## 開発

```bash
npm test          # テスト
npm run typecheck # 型チェック
```

| ファイル | 役割 |
| --- | --- |
| `src/server.ts` | 起動・定期同期 |
| `src/http.ts` | ルーティング（管理画面・Google OAuth・Square Webhook） |
| `src/views.ts` | 管理画面のHTML |
| `src/sync.ts` | シフト → 予定の変換と同期ロジック |
| `src/square.ts` | Square API（シフト・スタッフ・店舗・職種）とWebhook署名検証 |
| `src/google.ts` | Google OAuth・Calendar API |
| `src/db.ts` | SQLite（連携トークン、シフトと予定の対応、招待先の上書き、同期履歴） |

## 注意点

- Googleの連携トークンは `DATABASE_PATH` のSQLiteに保存されます。ファイルの取り扱いに注意してください。
- 管理画面はHTTPSで公開してください（Basic認証のため）。
- Square Webhookの `labor.scheduled_shift.*` はベータ版のイベントです。届かない場合も定期同期で反映されます。
