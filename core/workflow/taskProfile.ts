// =========================
// TaskProfile (STEP156)
// =========================
//
// 背景(STEP155調査): TACTには既に「タスク特性の判定」が
// mode(quick/think/deep、ユーザー手動選択)とは独立に3つ存在していた。
//
//   category        … Planner(LLM)が判定するタスク分類
//                      (core/planner/getTeam.tsのgetTeam()の引数)
//   evidenceMode     … core/evidence/evidenceMode.tsの決定論的判定
//                      (Researcher/QueryBuilder/Analystの要否)
//   qualityProfile   … core/workflow/qualityProfile.tsの決定論的判定
//                      (Writer Critique/Revisionの要否)
//
// 一方でmodeの実効果は、core/conversation/outputSpec.tsの
// detailLevelを±1段階シフトするだけであり、LLM選択・Agent構成・
// Search強度には一切関与していなかった(STEP155報告参照)。
//
// TaskProfileは、この既存3軸を「重複再実装せず、そのまま」束ね、
// そこに今回新設する2軸(modelTier/searchIntensity)を加えた、
// Workflow実行判断の入力情報である。
//
// 重要な設計方針:
// - 新しいLLM分類呼び出しは追加しない。既存のcategory/evidenceMode/
//   qualityProfile(いずれも既に算出済みの値)から、決定論的な
//   マッピングだけでmodelTier/searchIntensityを導出する。
// - TaskProfileはあくまで「この仕事は何で、どの程度の品質・調査・
//   推論が必要か」という判断結果を表すだけであり、「実際にどの
//   モデル・どのSearch Providerを使うか」(Execution Strategy、
//   将来STEPで設計)とは責務を分離する。そのためmodelTier/
//   searchIntensityは抽象的な段階(economy/standard/premium、
//   none/light/standard/deep)のみを持ち、具体的なモデル名
//   ("gpt-4o-mini"等)やProvider名("tavily"等)は一切持たない。
// - STEP156時点では、modelTier/searchIntensityはcontext/
//   ExecutionRecordへ記録されるだけで、実際のLLM呼び出し
//   (core/llm/index.ts)やSearch呼び出し(core/tools/search/)の
//   分岐には一切使われない(将来STEPの接続対象として温存する)。

import { EvidenceMode } from "../evidence/evidenceMode";
import { QualityProfile } from "./qualityProfile";

// =========================
// ModelTier
// =========================
//
// 「どのモデルを使うか」ではなく「どれくらいの推論能力が必要か」を
// 表す抽象段階。具体的なモデル名(gpt-4o-mini/claude-*/gemini-*)との
// 対応付けは、将来のExecution Strategy側の責務とする
// (STEP156では対応付け自体を行わない。core/llm/index.tsのrunLLM()は
// 引き続き無条件でrunOpenAI()を呼ぶ、既存のまま)。
export type ModelTier =
  | "economy"
  | "standard"
  | "premium";

// =========================
// SearchIntensity
// =========================
//
// 「どのSearch Providerを使うか」ではなく「どれくらいの検索量・
// 深さが必要か」を表す抽象段階。具体的なProvider名(tavily/brave)や
// maxResults等のパラメータへの対応付けは、将来のExecution Strategy
// 側の責務とする(STEP156ではcore/tools/search/searchWithFallback.ts
// 等の実装には一切手を加えない)。
export type SearchIntensity =
  | "none"
  | "light"
  | "standard"
  | "deep";

export interface TaskProfile {

  // Planner(LLM)が判定したタスク分類。core/planner/getTeam.tsが
  // 既にswitch(category: string)で受けているため、新しい固定enumは
  // 作らず、既存と同じstring型のまま保持する。
  category: string;

  // 既存のcore/evidence/evidenceMode.tsをそのまま再利用(型の複製なし)。
  evidenceMode: EvidenceMode;

  // 既存のcore/workflow/qualityProfile.tsをそのまま再利用(型の複製なし)。
  qualityProfile: QualityProfile;

  // STEP156で新設。qualityProfileから決定論的に導出する。
  modelTier: ModelTier;

  // STEP156で新設。evidenceModeから決定論的に導出する。
  searchIntensity: SearchIntensity;

}

// =========================
// qualityProfile → modelTier
// =========================
//
// qualityProfileは既に「どこまで品質保証工程を要求するか」という
// 軸を持っている(instant: 機械的変換 〜 maximum: 論文レベル)ため、
// これをそのまま「どれくらいの推論能力が必要か」の判断材料として
// 転用する。4段階のqualityProfileを3段階のmodelTierへ以下のように
// 縮退させる:
//
//   instant  → economy  (機械的変換。高度な推論は不要)
//   standard → economy  (通常の壁打ち・トーン変更等。既定モデルで十分)
//   high     → standard (レポート・調査・比較等、Critique+Revisionを
//                         要求する水準。相応の推論能力が必要)
//   maximum  → premium  (論文レベル・一次情報優先の厳格な要求)
//
// "standard"を"economy"側に寄せているのは、TACTの既存Writerが
// standard(Critique実行・Revisionなし)を「通常回答」の既定値として
// 扱っており(qualityProfile.tsのコメント参照)、これを費用の高い
// モデル階層の既定にはしたくないため。
//
// STEP161: core/brain/effectiveModelTier.tsが「qualityProfileが
// 要求する最低Tier」の判定にこのテーブルをそのまま再利用するため
// exportする(同じ対応表を重複定義しない)。
export const MODEL_TIER_BY_QUALITY_PROFILE: Record<QualityProfile, ModelTier> = {

  instant: "economy",

  standard: "economy",

  high: "standard",

  maximum: "premium",

};

// =========================
// evidenceMode → searchIntensity
// =========================
//
// evidenceModeの4段階と1対1で対応させる(evidenceMode自体が
// 既に「どれくらい検索が必要か」を表す軸であるため、独自の判定
// ロジックを新設しない)。
const SEARCH_INTENSITY_BY_EVIDENCE_MODE: Record<EvidenceMode, SearchIntensity> = {

  none: "none",

  helpful: "light",

  required: "standard",

  "primary-source-required": "deep",

};

// =========================
// buildTaskProfile
// =========================
//
// 呼び出し元(core/workflow/handlePlanner.ts)が既に算出済みの
// category/evidenceMode/qualityProfileを渡すだけの、新しい判定を
// 一切行わない純関数。新しいLLM呼び出し・新しい正規表現判定は
// 追加しない(STEP156の絶対条件)。
export function buildTaskProfile(
  category: string,
  evidenceMode: EvidenceMode,
  qualityProfile: QualityProfile
): TaskProfile {

  return {

    category,

    evidenceMode,

    qualityProfile,

    modelTier:
      MODEL_TIER_BY_QUALITY_PROFILE[qualityProfile],

    searchIntensity:
      SEARCH_INTENSITY_BY_EVIDENCE_MODE[evidenceMode],

  };

}
