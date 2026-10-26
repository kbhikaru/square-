// 1回だけ同期して終了する（cron等から実行する用）: npm run sync
import { createApp } from "./app.ts";
import { formatSummary } from "./sync.ts";

const { sync } = createApp();
const summary = await sync.syncRange("cli");
console.log(formatSummary(summary));
process.exit(summary.error > 0 ? 1 : 0);
