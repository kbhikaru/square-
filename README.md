# Squareシフト → Googleカレンダー連携

Squareで**公開したシフト**を、次の2か所のGoogleカレンダーへ自動で書き込むサーバーです。

1. **スタッフ本人のGoogleカレンダー**（スタッフ各自がGoogleアカウントを連携）
2. **店舗カレンダー**（会社アカウント内に「カレンダーを追加」で作った店舗ごとのカレンダー）

```
                              ┌─▶ 店舗カレンダー（会社アカウント／店舗ごとに選択）
Square（シフト公開） ─▶ このサーバー ─┤
   Webhook＋定期同期              └─▶ スタッフ本人のカレンダー（本人が連携済みの場合）
```

## 動作の仕組み

| Square側の操作 | 本人のカレンダー | 店舗カレンダー |
| --- | --- | --- |
| シフトを公開 | 予定を追加（タイトル: 【出勤】氏名） | 予定を追加（タイトル: 【出勤】氏名） |
| 時間・メモを変更して再公開 | 更新 | 更新 |
| 担当スタッフを変更 | 前の人から削除し、新しい人に追加 | 更新 |
| 店舗を変更 | 更新 | 前の店舗カレンダーから削除し、新しい店舗カレンダーに追加 |
| シフトを削除 | 削除 | 削除 |
| 下書きのみ | 何もしない | 何もしない |

- **本人がGoogle未連携のスタッフ**は、店舗カレンダーの予定から、メールアドレス宛てに招待を送ります（あとで本人が連携すると、自動で直接書き込みに切り替わります）。
- 招待先は「管理画面で設定したアドレス」→「Squareのスタッフ情報のメールアドレス」の順で決まります。
- 未連携かつメールも無いスタッフは「送信先なし」と管理画面に表示します。
- スタッフの連携を管理画面から解除すると、本人のカレンダーにある今後のシフト予定を削除してから解除します。
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
3. 「OAuth 同意画面」を設定（スコープ: `calendar.events`, `calendar.calendarlist.readonly`）
4. 「認証情報」→「OAuth クライアントID」→ 種類 **ウェブアプリケーション**
   - 承認済みリダイレクトURI: `https://<あなたのドメイン>/auth/google/callback`
5. クライアントID とシークレットを控える

> **スタッフが個人のGmailアカウントで連携する場合の注意**
> - OAuth同意画面の「ユーザーの種類」は **外部** にします。
> - 「テスト」状態ではテストユーザーに登録した人（最大100人）しか連携できず、連携も7日で切れます。
> - 「本番環境」に公開すると誰でも連携できますが、カレンダー権限は「機密性の高いスコープ」のため、Googleの審査を受けるまでは「このアプリは確認されていません」という警告が出ます（「詳細」→「〜に移動」で進めます。未審査のままだと上限100人）。
> - 会社と全スタッフが同じ **Google Workspace** のアカウントなら「内部」にすれば、審査も警告も不要です。

### 3. このサーバー

```bash
npm install          # 型チェック用の開発ツールのみ
cp .env.example .env # 値を記入
npm start
```

ブラウザで `BASE_URL` を開き、ユーザー名 `admin` / `ADMIN_PASSWORD` でログインします。

1. 「会社アカウントと連携する」→ 店舗カレンダーを持っている会社のGoogleアカウントでログイン
2. 「店舗ごとの書き込み先カレンダー」で、各店舗のカレンダーを選ぶ
3. スタッフごとに「連携リンクを発行」→ リンクを本人に送る（LINE・メールなど）
   - 本人がリンクを開いて「Googleでログインして連携する」を押すと完了です
   - リンクは1回限り・14日間有効です（**14日以内に1回開けばOK**。連携後の定期的な更新は不要です）。本人以外には送らないでください
4. 「今すぐ同期」

以降は Webhook と定期同期（既定15分ごと）で自動反映されます。

## 連携はいつまで続くか

一度連携すれば、更新作業なしで使い続けられます。次の場合だけ「再連携が必要」と管理画面に表示されるので、連携リンクを再発行してください。

- 本人がGoogleアカウントの設定から、このアプリへのアクセスを削除した
- Google Cloud の同意画面が「テスト」状態のまま（7日で切れます → 「本番環境」に公開してください）
- 6か月以上まったく同期が行われなかった

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
| `STORE_CALENDAR_ID` | 店舗ごとの割り当てが無い場合の店舗カレンダー（空なら書き込まない） | `primary` |
| `SYNC_DAYS_AHEAD` | 何日先まで同期するか | `30` |
| `SYNC_INTERVAL_MINUTES` | 定期同期の間隔（0で無効） | `15` |
| `DEFAULT_TIMEZONE` | シフトにタイムゾーンが無い場合 | `Asia/Tokyo` |
| `EVENT_TITLE_TEMPLATE` | 予定タイトル（`{name}`=氏名, `{location}`=店舗名, `{job}`=職種） | `【出勤】{name}` |

cron等で1回だけ同期したい場合は `npm run sync` を使えます。

## 開発

```bash
npm test          # テスト
npm run typecheck # 型チェック
```

| ファイル | 役割 |
| --- | --- |
| `src/server.ts` | 起動・定期同期 |
| `src/http.ts` | ルーティング（管理画面・スタッフ連携リンク・Google OAuth・Square Webhook） |
| `src/views.ts` | 管理画面・スタッフ向けページのHTML |
| `src/sync.ts` | シフト → 予定の変換と同期ロジック |
| `src/square.ts` | Square API（シフト・スタッフ・店舗・職種）とWebhook署名検証 |
| `src/google.ts` | Google OAuth・Calendar API |
| `src/db.ts` | SQLite（会社・スタッフの連携トークン、シフトと予定の対応、店舗カレンダーの割り当て、連携リンク、同期履歴） |

## 注意点

- Googleの連携トークンは `DATABASE_PATH` のSQLiteに保存されます。ファイルの取り扱いに注意してください。
- 管理画面はHTTPSで公開してください（Basic認証のため）。
- Square Webhookの `labor.scheduled_shift.*` はベータ版のイベントです。届かない場合も定期同期で反映されます。
