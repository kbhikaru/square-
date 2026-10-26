import type { App } from "./app.ts";
import type { ShiftEventStatus } from "./db.ts";
import { teamMemberName, type TeamMember } from "./square.ts";

const STATUS_LABEL: Record<ShiftEventStatus, string> = {
  synced: "招待済み",
  no_email: "メール未登録",
  deleted: "削除済み",
  error: "エラー",
};

export async function renderDashboard(
  app: App,
  opts: { flash: string | null; webhookUrl: string; webhookEnabled: boolean },
): Promise<string> {
  const account = app.store.getGoogleAccount();
  const overrides = app.store.getEmailOverrides();

  let members: TeamMember[] = [];
  let squareError: string | null = null;
  try {
    members = (await app.square.listTeamMembers()).filter((m) => m.status !== "INACTIVE");
  } catch (e) {
    squareError = e instanceof Error ? e.message : String(e);
  }
  const memberById = new Map(members.map((m) => [m.id, m]));
  const events = app.store.listShiftEvents(100);
  const runs = app.store.listSyncRuns(5);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>シフト → Googleカレンダー連携</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#6b7280; --line:#e5e7eb; --accent:#1a73e8; --ok:#137333; --warn:#b06000; --err:#c5221f; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 8px 0 16px; }
  h2 { font-size: 1.05rem; margin: 0 0 12px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .flash { background:#e8f0fe; border-color:#c6dafc; white-space: pre-wrap; }
  .muted { color:var(--muted); font-size:.9rem; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  button, .btn { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; font-size:.95rem; cursor:pointer; text-decoration:none; display:inline-block; }
  button.secondary { background:#fff; color:var(--err); border:1px solid var(--line); }
  input[type=email] { padding:6px 8px; border:1px solid var(--line); border-radius:6px; min-width: 0; width: 100%; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align: middle; }
  th { color:var(--muted); font-weight:600; white-space: nowrap; }
  .tag { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.8rem; white-space:nowrap; }
  .synced { background:#e6f4ea; color:var(--ok); } .no_email { background:#fef7e0; color:var(--warn); }
  .deleted { background:#f1f3f4; color:var(--muted); } .error { background:#fce8e6; color:var(--err); }
  form.inline { display:flex; gap:6px; align-items:center; }
  code { background:#f1f3f4; padding:1px 4px; border-radius:4px; word-break: break-all; }
</style>
</head>
<body>
<main>
<h1>Squareシフト → Googleカレンダー連携</h1>

${opts.flash ? `<section class="flash">${esc(opts.flash)}</section>` : ""}

<section>
  <h2>1. Googleアカウント連携</h2>
  ${
    account
      ? `<p>連携中: <strong>${esc(account.email)}</strong> <span class="muted">（${esc(fmt(account.connectedAt))}〜）</span></p>
         <p class="muted">このアカウントのカレンダーにシフト予定を作成し、スタッフのメールアドレスへ招待を送ります。</p>
         <form method="post" action="/auth/google/disconnect" onsubmit="return confirm('連携を解除しますか？')"><button class="secondary">連携を解除</button></form>`
      : `<p class="muted">シフト予定を作成するGoogleアカウント（店舗の共有アカウントなど）で連携してください。</p>
         <a class="btn" href="/auth/google">Googleアカウントと連携する</a>`
  }
</section>

<section>
  <h2>2. 同期</h2>
  <div class="row">
    <form method="post" action="/sync"><button ${account ? "" : "disabled"}>今すぐ同期</button></form>
    <span class="muted">Webhook: ${opts.webhookEnabled ? `有効（<code>${esc(opts.webhookUrl)}</code>）` : "未設定（定期同期のみ）"}</span>
  </div>
  ${
    runs.length
      ? `<div class="table-wrap"><table><thead><tr><th>開始</th><th>種類</th><th>結果</th></tr></thead><tbody>
         ${runs.map((r) => `<tr><td>${esc(fmt(r.startedAt))}</td><td>${esc(r.trigger)}</td><td style="white-space:pre-wrap">${esc(r.summary ?? "実行中…")}</td></tr>`).join("")}
         </tbody></table></div>`
      : `<p class="muted">まだ同期していません。</p>`
  }
</section>

<section>
  <h2>3. スタッフと招待先メールアドレス</h2>
  <p class="muted">通常はSquareのスタッフ情報のメールアドレスに招待します。Googleで使っているアドレスが違う場合は、ここで上書きしてください。</p>
  ${
    squareError
      ? `<p class="tag error">Squareからスタッフを取得できません: ${esc(squareError)}</p>`
      : `<div class="table-wrap"><table><thead><tr><th>スタッフ</th><th>Squareのメール</th><th>招待先（上書き）</th></tr></thead><tbody>
        ${members
          .map((m) => {
            const o = overrides.get(m.id) ?? "";
            const effective = o || m.email_address || "";
            return `<tr>
              <td>${esc(teamMemberName(m) || m.id)}${effective ? "" : ` <span class="tag no_email">未登録</span>`}</td>
              <td>${esc(m.email_address ?? "—")}</td>
              <td><form class="inline" method="post" action="/staff/email">
                <input type="hidden" name="team_member_id" value="${esc(m.id)}">
                <input type="email" name="email" value="${esc(o)}" placeholder="${esc(m.email_address ?? "例: name@gmail.com")}">
                <button>保存</button></form></td>
            </tr>`;
          })
          .join("")}
        </tbody></table></div>`
  }
</section>

<section>
  <h2>4. 最近のシフト同期状況</h2>
  ${
    events.length
      ? `<div class="table-wrap"><table><thead><tr><th>開始日時</th><th>スタッフ</th><th>招待先</th><th>状態</th></tr></thead><tbody>
        ${events
          .map(
            (e) => `<tr>
              <td>${esc(fmt(e.startAt))}</td>
              <td>${esc(teamMemberName(memberById.get(e.teamMemberId ?? "")) || e.teamMemberId || "—")}</td>
              <td>${esc(e.attendeeEmail ?? "—")}</td>
              <td><span class="tag ${e.status}">${STATUS_LABEL[e.status] ?? e.status}</span>${e.message ? `<div class="muted">${esc(e.message)}</div>` : ""}</td>
            </tr>`,
          )
          .join("")}
        </tbody></table></div>`
      : `<p class="muted">まだありません。</p>`
  }
</section>
</main>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}
