import type { App } from "./app.ts";
import { COMPANY, type EventTarget, type ShiftEventRow, type ShiftEventStatus } from "./db.ts";
import type { CalendarInfo } from "./google.ts";
import { teamMemberName, type TeamMember } from "./square.ts";

const STATUS_LABEL: Record<ShiftEventStatus, string> = {
  synced: "反映済み",
  no_email: "送信先なし",
  deleted: "削除済み",
  error: "エラー",
};

const STYLE = `
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#6b7280; --line:#e5e7eb; --accent:#1a73e8; --ok:#137333; --warn:#b06000; --err:#c5221f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --card:#1d2026; --text:#e8eaed; --muted:#9aa0a6; --line:#33373e; --accent:#8ab4f8; --ok:#81c995; --warn:#fdd663; --err:#f28b82; } }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }
  main { max-width: 980px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 8px 0 16px; }
  h2 { font-size: 1.05rem; margin: 0 0 8px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .flash { border-color: var(--accent); white-space: pre-wrap; }
  .muted { color:var(--muted); font-size:.9rem; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  button, .btn { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; font-size:.95rem; cursor:pointer; text-decoration:none; display:inline-block; white-space:nowrap; }
  @media (prefers-color-scheme: dark) { button, .btn { color:#14161a; } }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--line); }
  button.danger { background:transparent; color:var(--err); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  input, select { padding:6px 8px; border:1px solid var(--line); border-radius:6px; min-width:0; width:100%; background:var(--card); color:var(--text); font-size:.95rem; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align: top; }
  th { color:var(--muted); font-weight:600; white-space: nowrap; }
  .tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:.8rem; white-space:nowrap; border:1px solid currentColor; }
  .synced, .ok { color:var(--ok); } .no_email, .warn { color:var(--warn); } .deleted { color:var(--muted); } .error { color:var(--err); }
  details summary { cursor:pointer; margin-top:4px; }
  form.inline { display:flex; gap:6px; align-items:center; margin:0; }
  code { background:var(--bg); padding:1px 4px; border-radius:4px; word-break: break-all; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

// =============== 管理画面 ===============

export async function renderDashboard(
  app: App,
  opts: { flash: string | null; webhookUrl: string; webhookEnabled: boolean; defaultStoreCalendarId: string },
): Promise<string> {
  const company = app.store.getGoogleAccount(COMPANY);
  const staffAccounts = app.store.listStaffAccounts();
  const overrides = app.store.getEmailOverrides();
  const locationCalendars = app.store.getLocationCalendars();

  let members: TeamMember[] = [];
  let locations = new Map<string, string>();
  let squareError: string | null = null;
  try {
    [members, locations] = await Promise.all([app.square.listTeamMembers(), app.square.listLocations()]);
    members = members.filter((m) => m.status !== "INACTIVE");
  } catch (e) {
    squareError = e instanceof Error ? e.message : String(e);
  }

  let calendars: CalendarInfo[] = [];
  let calendarError: string | null = null;
  if (company && !company.invalid) {
    try {
      calendars = await app.calendar.listWritableCalendars(COMPANY);
    } catch (e) {
      calendarError = e instanceof Error ? e.message : String(e);
    }
  }
  const calendarName = (id: string) =>
    calendars.find((c) => (id === "primary" ? c.primary : c.id === id))?.summary ?? (id === "primary" ? "会社アカウントのメイン" : id);

  const memberById = new Map(members.map((m) => [m.id, m]));
  const runs = app.store.listSyncRuns(5);
  const linkedCount = members.filter((m) => staffAccounts.get(m.id) && !staffAccounts.get(m.id)!.invalid).length;

  return page(
    "シフト連携 管理画面",
    `
<h1>Squareシフト → Googleカレンダー連携</h1>
${opts.flash ? `<section class="flash">${esc(opts.flash)}</section>` : ""}

<section>
  <h2>1. 会社アカウント（店舗カレンダー）</h2>
  ${
    company
      ? `<p>連携中: <strong>${esc(company.email)}</strong> ${company.invalid ? `<span class="tag error">再連携が必要</span>` : ""}
           <span class="muted">（${esc(fmt(company.connectedAt))}〜）</span></p>
         <div class="row">
           ${company.invalid ? `<a class="btn" href="/auth/google">再連携する</a>` : ""}
           <form method="post" action="/auth/google/disconnect" onsubmit="return confirm('会社アカウントの連携を解除しますか？')"><button class="danger">連携を解除</button></form>
         </div>`
      : `<p class="muted">店舗カレンダーを持っている会社のGoogleアカウントで連携してください。</p>
         <a class="btn" href="/auth/google">会社アカウントと連携する</a>`
  }
</section>

<section>
  <h2>2. 店舗ごとの書き込み先カレンダー</h2>
  <p class="muted">会社アカウント内のカレンダー（「カレンダーを追加」で作った店舗カレンダーなど）から選びます。</p>
  ${
    squareError
      ? `<p class="error">Squareから店舗を取得できません: ${esc(squareError)}</p>`
      : !company || company.invalid
        ? `<p class="muted">会社アカウントを連携すると選べるようになります。</p>`
        : calendarError
          ? `<p class="error">カレンダー一覧を取得できません: ${esc(calendarError)}<br>権限追加のため、一度「連携を解除」して再連携してください。</p>`
          : `<div class="table-wrap"><table><thead><tr><th>店舗</th><th>書き込み先</th></tr></thead><tbody>
            ${[...locations]
              .map(([id, name]) => {
                const current = locationCalendars.has(id) ? locationCalendars.get(id)! : null;
                const opt = (value: string, label: string, selected: boolean) =>
                  `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
                const known = current === null || current === "" || calendars.some((c) => c.id === current);
                return `<tr><td>${esc(name)}</td><td>
                  <form class="inline" method="post" action="/locations/calendar">
                    <input type="hidden" name="location_id" value="${esc(id)}">
                    <select name="calendar_id">
                      ${opt("__default__", `既定（${defaultLabel(opts.defaultStoreCalendarId, calendarName)}）`, current === null)}
                      ${calendars.map((c) => opt(c.id, c.primary ? `${c.summary}（メイン）` : c.summary, current === c.id)).join("")}
                      ${known ? "" : opt(current!, `${current}（アクセス不可）`, true)}
                      ${opt("__none__", "書き込まない", current === "")}
                    </select>
                    <button>保存</button>
                  </form></td></tr>`;
              })
              .join("")}
            </tbody></table></div>`
  }
</section>

<section>
  <h2>3. スタッフのGoogle連携</h2>
  <p class="muted">
    連携済みのスタッフ: 本人のGoogleカレンダーに直接シフトが入ります。<br>
    未連携のスタッフ: 店舗カレンダーの予定から、下の「招待先」のメールに招待を送ります。<br>
    連携リンクはスタッフ本人だけに送ってください（1回限り・14日間有効）。
  </p>
  <p>連携済み ${linkedCount} / ${members.length} 人</p>
  ${
    squareError
      ? `<p class="error">Squareからスタッフを取得できません: ${esc(squareError)}</p>`
      : `<div class="table-wrap"><table><thead><tr><th>スタッフ</th><th>本人のGoogle</th></tr></thead><tbody>
        ${members
          .map((m) => {
            const acc = staffAccounts.get(m.id);
            const o = overrides.get(m.id) ?? "";
            const effective = o || m.email_address || "";
            const googleCell = acc
              ? `<div><span class="tag ${acc.invalid ? "error" : "ok"}">${acc.invalid ? "再連携が必要" : "連携済み"}</span> ${esc(acc.email)}</div>
                 <div class="row" style="margin-top:6px">
                   ${acc.invalid ? linkButton(m.id, "連携リンクを再発行") : ""}
                   <form method="post" action="/staff/disconnect" onsubmit="return confirm('${esc(jsStr(teamMemberName(m)))} さんの連携を解除し、本人のカレンダーから今後のシフト予定を削除しますか？')">
                     <input type="hidden" name="team_member_id" value="${esc(m.id)}"><button class="danger">解除</button></form>
                 </div>`
              : `<span class="tag warn">未連携</span><div style="margin-top:6px">${linkButton(m.id, "連携リンクを発行")}</div>`;
            return `<tr>
              <td>${esc(teamMemberName(m) || m.id)}<div class="muted">${esc(m.email_address ?? "メール未登録")}</div>
                ${!acc && !effective ? `<div class="warn">招待先がありません</div>` : ""}
                <details${o ? " open" : ""}><summary class="muted">未連携時の招待先${o ? `: ${esc(o)}` : ""}</summary>
                  <form class="inline" method="post" action="/staff/email" style="margin-top:6px">
                    <input type="hidden" name="team_member_id" value="${esc(m.id)}">
                    <input type="email" name="email" value="${esc(o)}" placeholder="${esc(m.email_address ?? "例: name@gmail.com")}">
                    <button class="secondary">保存</button></form>
                </details></td>
              <td>${googleCell}</td>
            </tr>`;
          })
          .join("")}
        </tbody></table></div>`
  }
</section>

<section>
  <h2>4. 同期</h2>
  <div class="row">
    <form method="post" action="/sync"><button>今すぐ同期</button></form>
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
  <h2>5. 最近のシフト反映状況</h2>
  ${renderShiftTable(app.store.listShiftEvents(200), memberById, calendarName)}
</section>
`,
  );
}

function defaultLabel(id: string, calendarName: (id: string) => string): string {
  if (!id) return "書き込まない";
  return id === "primary" ? "会社アカウントのメイン" : calendarName(id);
}

function linkButton(teamMemberId: string, label: string): string {
  return `<form method="post" action="/staff/link"><input type="hidden" name="team_member_id" value="${esc(teamMemberId)}"><button class="secondary">${esc(label)}</button></form>`;
}

function renderShiftTable(rows: ShiftEventRow[], members: Map<string, TeamMember>, calendarName: (id: string) => string): string {
  if (!rows.length) return `<p class="muted">まだありません。</p>`;
  // シフトごとに 店舗 / 本人 の2列にまとめる
  const byShift = new Map<string, Partial<Record<EventTarget, ShiftEventRow>>>();
  for (const r of rows) {
    const e = byShift.get(r.shiftId) ?? {};
    e[r.target] = r;
    byShift.set(r.shiftId, e);
  }
  const cell = (r: ShiftEventRow | undefined, where: (r: ShiftEventRow) => string) =>
    r
      ? `<span class="tag ${r.status}">${STATUS_LABEL[r.status] ?? r.status}</span>
         ${r.status === "synced" ? `<div class="muted">${esc(where(r))}</div>` : ""}
         ${r.message ? `<div class="muted">${esc(r.message)}</div>` : ""}`
      : `<span class="muted">—</span>`;

  return `<div class="table-wrap"><table><thead><tr><th>シフト</th><th>店舗カレンダー</th><th>本人のカレンダー</th></tr></thead><tbody>
    ${[...byShift.values()]
      .slice(0, 100)
      .map((e) => {
        const any = (e.store ?? e.staff)!;
        return `<tr>
          <td style="white-space:nowrap">${esc(fmt(any.startAt))}<div class="muted">${esc(teamMemberName(members.get(any.teamMemberId ?? "")) || any.teamMemberId || "—")}</div></td>
          <td>${cell(e.store, (r) => calendarName(r.calendarId ?? "") + (r.attendeeEmail ? ` ／ 招待: ${r.attendeeEmail}` : ""))}</td>
          <td>${cell(e.staff, () => "直接書き込み")}</td>
        </tr>`;
      })
      .join("")}
    </tbody></table></div>`;
}

export function renderLinkIssued(opts: { name: string; link: string; days: number }): string {
  const text = `${opts.name}さん\nシフトをあなたのGoogleカレンダーに自動で入れるための連携リンクです（${opts.days}日間有効）。\n${opts.link}`;
  return page(
    "連携リンク",
    `
<h1>${esc(opts.name)} さんの連携リンク</h1>
<section>
  <p>このリンクを <strong>${esc(opts.name)} さん本人だけ</strong> に送ってください。<br>
  <span class="muted">${opts.days}日間有効・1回連携すると無効になります。前に発行したリンクは無効になりました。</span></p>
  <p><input id="link" value="${esc(opts.link)}" readonly onclick="this.select()"></p>
  <div class="row">
    <button onclick="copy()">コピー</button>
    <button class="secondary" id="share" hidden onclick="share()">LINE・メールなどで送る</button>
    <a class="btn" style="background:transparent;color:var(--accent);border:1px solid var(--line)" href="/">管理画面に戻る</a>
  </div>
  <p class="muted" id="copied" hidden>コピーしました</p>
</section>
<script>
  const text = ${JSON.stringify(text).replace(/</g, "\\u003c")};
  if (navigator.share) document.getElementById("share").hidden = false;
  function copy() {
    navigator.clipboard.writeText(text).then(() => { document.getElementById("copied").hidden = false; });
  }
  function share() { navigator.share({ text }).catch(() => {}); }
</script>`,
  );
}

// =============== スタッフ向けページ ===============

export function renderStaffPage(
  p:
    | { kind: "landing"; name: string; startUrl: string }
    | { kind: "done"; email: string }
    | { kind: "expired" }
    | { kind: "error"; message: string },
): string {
  switch (p.kind) {
    case "landing":
      return page(
        "シフトをGoogleカレンダーに連携",
        `
<h1>シフトをGoogleカレンダーに自動登録</h1>
<section>
  <p>${p.name ? `${esc(p.name)} さん、` : ""}Squareで公開されたあなたのシフトを、あなたのGoogleカレンダーに自動で追加します。</p>
  <ul>
    <li>シフトが変更・削除されると、カレンダーの予定も自動で更新・削除されます</li>
    <li>このサービスが書き込むのはシフトの予定だけです</li>
    <li>連携はいつでも、Googleアカウントの「サードパーティ製のアプリとサービス」から解除できます</li>
  </ul>
  <p><a class="btn" href="${esc(p.startUrl)}">Googleでログインして連携する</a></p>
  <p class="muted">次の画面で「Googleカレンダーの予定の表示、編集」などへのアクセスを求められます。チェックを入れて許可してください。</p>
</section>`,
      );
    case "done":
      return page(
        "連携が完了しました",
        `<h1>連携が完了しました 🎉</h1>
<section><p><strong>${esc(p.email)}</strong> のGoogleカレンダーに、これからのシフトが入ります（反映まで数分かかる場合があります）。</p>
<p class="muted">このページは閉じて大丈夫です。</p></section>`,
      );
    case "expired":
      return page(
        "リンクが無効です",
        `<h1>このリンクは使えません</h1>
<section><p>有効期限が切れているか、すでに使用済みです。店舗の管理者に新しいリンクを発行してもらってください。</p></section>`,
      );
    case "error":
      return page("連携に失敗しました", `<h1>連携に失敗しました</h1><section><p>${esc(p.message)}</p></section>`);
  }
}

// =============== helpers ===============

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function jsStr(s: string): string {
  return s.replace(/[\\'"]/g, "");
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}
