// =========================
// classifyIntent Regression (Phase 20)
// =========================
//
// 対象: core/tact-intent/ruleRouter.ts の classifyIntent()。
// STEP216(Rule Router新設)・Phase18(疑問文/情報要求ルーティング)の
// 既存Reality Test結果をそのまま恒久testへ移した(絶対条件: LLM/API
// 呼び出み0件、classifyIntent()自体が決定論的なため)。
//
// Category A(Deterministic Evaluation)。

import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import { check, summarize, type CheckResult } from "../lib/check";
import type { TactIntent } from "../../../core/tact-intent/types";

interface Case {
  phase: string;
  input: string;
  expected: TactIntent;
}

const cases: Case[] = [

  // STEP216: 元々のRule Router設計時からの既存ケース
  { phase: "STEP216", input: "日本の人口を調べて", expected: "research" },
  { phase: "STEP216", input: "日本の人口について調査して", expected: "research" },
  { phase: "STEP216", input: "日本の人口をリサーチして", expected: "research" },
  { phase: "STEP216", input: "このルールを覚えておいて", expected: "core_push" },
  { phase: "STEP216", input: "このコードを説明して", expected: "chat" },
  { phase: "STEP216", input: "今日は疲れた", expected: "chat" },
  { phase: "STEP216", input: "調べるってどういう意味?", expected: "chat" },
  { phase: "STEP216", input: "", expected: "chat" },

  // Phase18: 疑問文・情報要求ルーティング(Step9公式Reality Test A〜H)
  { phase: "Phase18-A", input: "日本の首相は誰ですか？", expected: "research" },
  { phase: "Phase18-B", input: "最新のiPhoneモデルは何ですか？", expected: "research" },
  { phase: "Phase18-C", input: "トヨタの競合はどこですか？", expected: "research" },
  { phase: "Phase18-D", input: "コードは何ですか？", expected: "chat" },
  { phase: "Phase18-E", input: "これはどういう意味ですか？", expected: "chat" },
  { phase: "Phase18-F", input: "調べるってどういう意味？", expected: "chat" },
  { phase: "Phase18-G", input: "日本の人口について教えて", expected: "research" },
  { phase: "Phase18-H", input: "これについてどう思う？", expected: "chat" },

  // Phase18: 追加FP検証で確認した既知の境界ケース
  { phase: "Phase18-FP", input: "これについてどう思いますか？", expected: "chat" },
  { phase: "Phase18-FP", input: "それは正しいですか？", expected: "chat" },
  { phase: "Phase18-FP", input: "これはどうしたらいいですか？", expected: "chat" },
  { phase: "Phase18-FP", input: "AIとは何ですか？", expected: "chat" },
  { phase: "Phase18-FP", input: "おすすめを教えて", expected: "chat" },
  { phase: "Phase18-FP", input: "iPhoneの最新モデルについて知りたい", expected: "research" },

  // Phase82-C: 「具体例/実例/事例」+ 依頼表現 -> research
  // (Phase81 Root Cause: 外部世界に実在する対象物の列挙を求める依頼が
  // 「調べ/調査/リサーチ」を含まないためchatへ落ち、Research
  // Capability(実Web検索)を経由しない不具合の修正確認)
  { phase: "Phase82-J", input: "具体例を5件追加して", expected: "research" },
  { phase: "Phase82-J", input: "実際の事例を追加して", expected: "research" },
  { phase: "Phase82-J", input: "その分野の実例を教えて", expected: "research" },
  { phase: "Phase82-J", input: "代表的な事例を紹介して", expected: "research" },

  // Phase82-K: 生成依頼(action語尾が「作って」)はresearchを誤起動
  // しない(トピックに「具体例」を含んでいても、既存に実在する対象を
  // 求めるアクション語尾で無ければ対象外、Phase82絶対条件「False
  // Positiveを極力増やさない」)。
  { phase: "Phase82-K", input: "自分の文章から具体例を5つ作って", expected: "chat" },
  { phase: "Phase82-K", input: "適当な事例を考えて", expected: "chat" },

];

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = cases.map((c) => {

    const decision = classifyIntent(c.input);

    return check(
      `[${c.phase}] classifyIntent("${c.input}") -> ${c.expected}`,
      decision.intent === c.expected,
      `actual=${decision.intent}, reason=${decision.reason}`
    );

  });

  return summarize("classifyIntent", results);

}
