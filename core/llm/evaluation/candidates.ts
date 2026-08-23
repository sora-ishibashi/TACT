// =========================
// Known Model Candidates (STEP170)
// =========================
//
// STEP170時点でTACTが実際に呼び出し可能であることを確認済みの
// Provider/Modelの組み合わせ。core/llm/executionStrategy.tsの
// EXECUTION_STRATEGY_BY_MODEL_TIERとは意図的に別の定数として持つ
// (Tierとの対応付けを評価系へ持ち込まないため。STEP170絶対条件)。
//
// - openai: STEP157で実在・利用可否を確認済みの3モデル
//   (core/llm/pricing.tsのOPENAI_PRICINGと同じ)。
// - claude: STEP166で実在・利用可否を確認済みの1モデル
//   (core/llm/pricing.tsのANTHROPIC_PRICINGと同じ)。

import { ModelCandidate } from "./types";

export const KNOWN_MODEL_CANDIDATES: ModelCandidate[] = [

  { provider: "openai", model: "gpt-4o-mini" },

  { provider: "openai", model: "gpt-4o" },

  { provider: "openai", model: "gpt-4.1" },

  { provider: "claude", model: "claude-haiku-4-5-20251001" },

];
