// =========================
// Trigger.dev Project Config
// (Fast Port P5c: Route One Non-Side-Effecting Integration Read
// Through Trigger.dev)
// =========================
//
// 絶対条件(Step30): secretをこのfileに直書きしない。projectはTACTが
// まだ実際に作成していないTrigger.dev project(dashboard上で作成後に
// 得られるproject ref)を指すため、環境変数から読む(未設定でも
// このfile自体はnpm test/tsc/next buildのいずれからも評価されない
// ——`npx trigger.dev@latest deploy`等のTrigger.dev CLIコマンドを
// 明示的に実行した時だけ読まれる、P5a/P5bと同じ「unused foundation」
// の位置づけ)。
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./trigger"],
  // slack.list_channelsは短時間で終わるread-only操作であり、durable
  // long-running workflowではない。保守的に短いmaxDurationを設定する
  // (Trigger.dev公式要求によりproject全体で必須のfield)。
  maxDuration: 60,
});
