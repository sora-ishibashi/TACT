// =========================
// SOR-130 Reality Test — .env / .env.local loader
// =========================
//
// tests/tact/runAll.tsはdotenv/config(.envのみ)をimportするが、
// Notion/Slack/GitHubのsandbox credentialは.env.localに置かれている
// (Next.jsの規約と同じ、.env.localが.envを上書きする)。Reality Test
// スクリプトはtests/tact/runAll.ts経由で実行されない独立エントリ
// ポイントのため、ここで明示的に両方loadする。
//
// 絶対条件(ESM import hoisting): ES moduleのimport宣言は、同じfile内の
// 他のどの実行文よりも先に評価される——「関数をexportし、呼び出し元で
// 呼ぶ」形にすると、呼び出しが実行される前に後続のimport宣言
// (core/tact-executionの読み込みで、OPENAI_API_KEY等を読むcore/llm/が
// import時に評価されてしまう)が先に走ってしまう。dotenv/config自体と
// 同じ「importするだけで副作用が起きる」self-executing moduleにする
// ことで、呼び出し元が最初のimport文としてこれをimportするだけで
// 正しい順序が保証される。

import { config } from "dotenv";

config({ path: ".env" });
config({ path: ".env.local", override: true });
