// =========================
// qualityProfile (STEP71)
// =========================
//
// 背景: STEP67(Writer Critique)・STEP68(Writer Revision)は、
// core/workflow/index.tsで「context.outputs.writerが存在すれば
// 無条件に実行される」構造になっていた。STEP69のDynamic Workflow
// Architecture設計(docs/dynamic-workflow-architecture.md 10章)が
// 提案したQualityProfileのうち、STEP71では「どこまでAIに品質保証
// 工程(Critique/Revision)を要求するか」だけを実装する
// (Agent構成そのものへの接続は今回のスコープ外。それは
// EvidenceMode(STEP70)が既に担っている)。
//
// 重要: EvidenceModeとQualityProfileは別軸。
// 「Evidence不要 = 品質チェック不要」ではない(STEP71指示)。
// そのため、EvidenceMode === "none" であっても、機械的な変換
// (文字数調整・校正・タイトル案出し等)でない依頼は
// standard(=Critiqueは行うがRevisionはしない)以上を割り当てる。
//
// 新しいLLM分類Agentは追加しない。既存のEvidenceMode判定
// (core/evidence/evidenceMode.ts、STEP70)と、そこで既に定義済みの
// パターン配列(MECHANICAL_EDIT_PATTERNS)を再利用し、
// 新規のキーワード集合は「品質を厳格にすべき」シグナルの
// 最小限の追加分だけに留める。

import {
  EvidenceMode,
  MECHANICAL_EDIT_PATTERNS,
} from "../evidence/evidenceMode";

export type QualityProfile =
  | "instant"
  | "standard"
  | "high"
  | "maximum";

export interface QualityProfileConfig {

  // Writer実行後にreviewWriterOutput()(STEP67)を実行するか。
  allowsCritique: boolean;

  // Critiqueがapproved=falseだった場合に、reviseWriterOutput()
  // (STEP68)による1回限りのRevisionを実行するか。
  // falseの場合、Critique自体は行われても差し戻しは行わない
  // (=診断のみ)。
  allowsRevision: boolean;

}

export const QUALITY_PROFILE_CONFIG: Record<
  QualityProfile,
  QualityProfileConfig
> = {

  // 速度最優先。Critique/Revisionともに行わない。
  // 誤字修正・文字数調整・タイトル案出し等、機械的な変換タスク向け。
  instant: {
    allowsCritique: false,
    allowsRevision: false,
  },

  // 通常回答。Critiqueは行い記録するが、自動的な書き直しはしない
  // (承認可否・指摘事項はcontext.writerCritiqueに残る)。
  standard: {
    allowsCritique: true,
    allowsRevision: false,
  },

  // レポート・分析等。Critique→(必要なら)Revision→再Critiqueまで
  // 実行する(STEP68の既存フロー)。
  high: {
    allowsCritique: true,
    allowsRevision: true,
  },

  // 論文レベル・重要調査。STEP71時点ではhighと同じゲート
  // (Critique+Revision)を使う。EvidenceMode側で既に
  // primary-source-required(一次情報優先)が扱われているため、
  // maximum固有の追加動作(例: Revision上限の緩和、Reviewer
  // プロンプトの強化)は今回実装しない(未解決事項として明記)。
  maximum: {
    allowsCritique: true,
    allowsRevision: true,
  },

};

// =========================
// 品質を厳格にすべき明示的なシグナル
// =========================
//
// STEP71の指示にある高品質側キーワード(論文・専門的・詳細・根拠・
// 一次情報・出典・エビデンス)のうち、一次情報・出典・エビデンスは
// 既にEvidenceMode側(primary-source-required判定)でカバーされて
// いるため、ここでは重複させず、EvidenceModeの判定結果を再利用する。
// ここに残すのは、EvidenceMode側ではカバーされない
// 「厳密さ・専門性」そのものを示す語彙のみ。
const RIGOR_SIGNAL_PATTERNS: RegExp[] = [

  /論文/,
  /学術/,
  /専門的/,
  /専門家向け/,
  /徹底的/,
  /厳密/,

];

// レポート・分析系の依頼を示すシグナル。
// これらはEvidenceMode=noneのケースにも現れ得る(例: 「この売上データを
// 分析して」はEvidence不要だが、standardより高い品質保証が望ましい)。
const ANALYTICAL_DEPTH_PATTERNS: RegExp[] = [

  /レポート/,
  /報告書/,
  /調査/,
  /分析/,
  /比較/,

];

// =========================
// detectQualityProfile
// =========================
//
// 優先順位:
//   1. EvidenceMode === "primary-source-required" → "maximum"
//      (一次情報優先の要求は、既に最も厳格なEvidence運用を
//      求めているため、品質保証も最大にする)
//   2. RIGOR_SIGNAL_PATTERNS(論文・学術・専門的等)に一致 → "maximum"
//   3. EvidenceMode === "required" → "high"
//      (調査・最新情報の収集が必要な依頼は、既定でCritique+Revisionを
//      許可する)
//   4. ANALYTICAL_DEPTH_PATTERNS(レポート・分析・比較等)に一致 → "high"
//   5. EvidenceMode === "none" の場合のみ、MECHANICAL_EDIT_PATTERNS
//      (校正・文字数調整・タイトル案出し等、判断を伴わない機械的変換)
//      に一致すれば "instant"。一致しなければ(壁打ち・トーン変更等、
//      ある程度の判断を要する依頼)"standard"
//      (EvidenceMode=none = Critique不要、にはしない)
//   6. それ以外(判定できない・曖昧なケースを含む) → "standard"
//      (安全側のデフォルト。従来通りCritiqueは行われる)
export function detectQualityProfile(
  userInput: string,
  evidenceMode: EvidenceMode
): QualityProfile {

  if (!userInput) return "standard";

  if (evidenceMode === "primary-source-required") {
    return "maximum";
  }

  if (RIGOR_SIGNAL_PATTERNS.some((p) => p.test(userInput))) {
    return "maximum";
  }

  if (evidenceMode === "required") {
    return "high";
  }

  if (ANALYTICAL_DEPTH_PATTERNS.some((p) => p.test(userInput))) {
    return "high";
  }

  if (evidenceMode === "none") {

    const isMechanicalEdit =
      MECHANICAL_EDIT_PATTERNS.some((p) => p.test(userInput));

    return isMechanicalEdit ? "instant" : "standard";

  }

  return "standard";

}
