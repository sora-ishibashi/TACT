import type { TaskExecutionSummary } from "./task";

// =========================
// LearningSignal / evaluateTaskExecution (Phase 27)
// =========================
//
// Phase25(Intelligence / Learning Layer Architecture Audit)・Phase26
// (Task Evaluation / Learning Signal 必要性検証)を踏まえた最小実装。
//
// 目的: TaskExecutionSummary(1 Task分の実行結果)から、将来の
// Reflection / Learning Layerが利用できる最小限の分類(Signal)を
// 決定論的に導出する。今回はこのSignalを「作るところ」までであり、
// Reflection(複数Task/複数Executionを見て「なぜそうなったか」
// 「次回どう変えるか」を判断する層)自体は実装しない
// (絶対条件: 責務境界を明確にする)。
//
// 絶対条件(Phase27):
//   - LLMを使わない(既存フィールドの組み合わせのみで判定する)。
//   - evidenceCountを閾値として使わない(Phase26調査結論: 実運用
//     データに基づかない閾値はprecision illusionにつながる。既存の
//     answerConfidence(Phase21)が既にEvidence品質を集約済みのため、
//     それを再利用するだけに留める)。
//   - uncertaintyNoteは分類条件に使わない(「なぜその分類になったか」
//     を説明する情報として温存し、分類そのものには関与させない、
//     Phase26で確立した「LearningSignal=分類、uncertaintyNote=理由」
//     という責務分離)。
//   - Chat(answerConfidence===undefined)を「低信頼」と解釈しない。
//     undefinedは「このCapabilityではこのSignalを持たない」という
//     意味であり、insufficient_evidenceとは別物(Phase26 Case H)。
//
// 配置について: buildEpisode()(episode.ts、Phase11)と同じ位置づけ
// ——OrchestrationRequest/Resultの「入力・出力を、呼び出し元が事後的に
// 利用するための独立したユーティリティ」であり、Commander/Executorの
// 内部実装(detectAmbiguity()・deriveAnswerConfidence()のように
// runOrchestration()の実行過程で自動的に呼ばれるもの)ではない。
// Evaluation Signalを「使う場所」(将来のReflection Layer)がまだ
// 存在しないため(Phase25/26で確認済み)、Commander/Executorからは
// 呼び出さない。呼び出し元はbuildEpisode()と同様に、
// runOrchestration()の戻り値(OrchestrationResult.tasks)を受け取った
// 後で、必要に応じてこの関数を呼ぶ。

export type LearningSignal =
  | "successful_execution"
  | "partially_successful"
  | "insufficient_evidence"
  | "permanent_failure"
  | "clarification_required";

export interface EvaluateTaskExecutionOptions {

  // Phase15のAmbiguity Detection経路(OrchestrationResult.clarification
  // が設定される場合)は、tasks=[]のためTaskExecutionSummary自体が
  // 生成されない(既存設計)。呼び出し元がこの経路であることを
  // 明示的に伝えるためのフラグ。trueの場合、summary引数の中身に
  // 関わらず"clarification_required"を返す。
  clarification?: boolean;

}

export function evaluateTaskExecution(
  summary: TaskExecutionSummary,
  options?: EvaluateTaskExecutionOptions
): LearningSignal {

  // A. Clarification(Phase15): 「失敗」でも「成功」でもない、
  // ユーザーとの確認を必要とした、という別種のSignal(Phase26 Case I)。
  if (options?.clarification) {
    return "clarification_required";
  }

  // B. failed / cancelled: 一時的失敗からのRecovery等の細分化は
  // 今回のスコープ外(絶対条件: 5 Signalの範囲を守る、Phase19の
  // retriedフィールドはここでは参照しない)。
  if (summary.status !== "completed") {
    return "permanent_failure";
  }

  // C・D・E: Research(Evidence概念を持つCapability)のみ、Phase21の
  // answerConfidenceをそのまま転用する。新しい閾値・新しい判定基準は
  // 作らない。
  if (summary.capability === "research") {

    if (summary.answerConfidence === "insufficient_evidence") {
      return "insufficient_evidence";
    }

    if (summary.answerConfidence === "partially_supported") {
      return "partially_successful";
    }

    // answerConfidence==="supported"、またはundefined(Research
    // Task自体は完了しているがConfidence算出に至らなかった異常系
    // ケースを含む、テスト項目9)のいずれも、既存のTask成功を
    // 否定する材料が無いため成功として扱う。
    return "successful_execution";

  }

  // F. completed + Chat等(Research条件に該当しないCapability):
  // Evidence概念自体が存在しないため、answerConfidence===undefinedを
  // 「低信頼」とは解釈しない(絶対条件、Phase26 Case H)。
  return "successful_execution";

}
