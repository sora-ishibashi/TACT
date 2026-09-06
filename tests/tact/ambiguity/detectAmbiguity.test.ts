// =========================
// detectAmbiguity Regression (Phase 20)
// =========================
//
// 対象: core/tact-orchestrator/ambiguityDetector.ts の detectAmbiguity()。
// Phase15の設計時Must-trigger/Must-not-triggerケースをそのまま恒久test
// へ移した。Category A(Deterministic Evaluation)、LLM/API呼び出し0件。

import { detectAmbiguity } from "../../../core/tact-orchestrator/ambiguityDetector";
import { check, summarize, type CheckResult } from "../lib/check";

interface Case {
  phase: string;
  input: string;
  expectedAmbiguous: boolean;
}

const cases: Case[] = [

  // Phase15: (a) 裸の動詞(完全一致)
  { phase: "Phase15-a", input: "調べて", expectedAmbiguous: true },
  { phase: "Phase15-a", input: "調べてください", expectedAmbiguous: true },
  { phase: "Phase15-a", input: "比較して", expectedAmbiguous: true },
  { phase: "Phase15-a", input: "教えて", expectedAmbiguous: true },

  // Phase15: (b) 先行文脈が無いと意味を成さないカテゴリ語
  { phase: "Phase15-b", input: "競合について調べて", expectedAmbiguous: true },
  { phase: "Phase15-b", input: "資料を作って", expectedAmbiguous: true },

  // Phase15: Must-not-trigger(False Positive防止、絶対条件5)
  { phase: "Phase15-FP", input: "トヨタの競合について調べて", expectedAmbiguous: false },
  { phase: "Phase15-FP", input: "生成AI市場について調べて", expectedAmbiguous: false },
  { phase: "Phase15-FP", input: "トヨタについて調べて", expectedAmbiguous: false },
  { phase: "Phase15-FP", input: "STEP210の内容を踏まえて教えて", expectedAmbiguous: false },

  // Phase18/19 Regressionで再確認済みの境界(疑問文はAmbiguityの対象外)
  { phase: "Phase18-regress", input: "日本の首相は誰ですか？", expectedAmbiguous: false },

  // Architecture Migration Phase C2.1b: Slack送信意図はあるが
  // channel/textが欠けている場合はambiguous(Case4/5、独自Bot質問
  // システムを作らず既存clarification flowを使う)。
  { phase: "C2.1b-Case4", input: "Slackに『明日の会議は10時です』って送って", expectedAmbiguous: true },
  { phase: "C2.1b-Case5", input: "Slackの#tactへ送っておいて", expectedAmbiguous: true },
  { phase: "C2.1b-both-missing", input: "Slackに送って", expectedAmbiguous: true },

  // Architecture Migration Phase C2.1b: channel/textが両方揃っている
  // 場合はambiguousではない(classifyIntent()側でintegration_slack_
  // send_messageとして処理される、絶対条件: False Positiveを増やさない)。
  { phase: "C2.1b-complete", input: "Slackの#tactに『明日の会議は10時です』って送って", expectedAmbiguous: false },

];

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = cases.map((c) => {

    const result = detectAmbiguity(c.input);

    return check(
      `[${c.phase}] detectAmbiguity("${c.input}") -> ambiguous=${c.expectedAmbiguous}`,
      result.ambiguous === c.expectedAmbiguous,
      `actual=${result.ambiguous}${result.question ? `, question="${result.question}"` : ""}`
    );

  });

  return summarize("detectAmbiguity", results);

}
