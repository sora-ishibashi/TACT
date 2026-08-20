// =========================
// requestTypeGuard (STEP37)
// =========================
//
// 背景: STEP28で導入したrequestType("task" | "question")の判定は、
// Task Reconstruction LLM(core/conversation/reconstructTask.ts)の
// 自由回答のみに依存していた。STEP36までの実機テストで、
// 「この成果物の目的を説明してください」のような、明らかに
// 成果物についての質問であるにもかかわらずtaskと誤判定され、
// Workflowが起動して成果物が変更されてしまうケースを確認した。
//
// 本モジュールは、STEP33のdetectResearchRequirement()と同じ方針
// (LLMの判断を置き換えるのではなく、明確に一方的なシグナルが
// あるときだけ安全側へ補正する)で、requestTypeの機械的な
// 安全網を提供する。新しいLLM呼び出しは追加しない。
//
// 重要: 「質問なのか作業依頼なのか」を完全にコードで決定する
// ものではない。質問を示す語尾(説明して/教えて等)と、作業依頼を
// 示す動詞(修正して/追加して等)の両方が現れる、あるいは
// どちらも現れない場合は、判定が難しいケースとしてLLMの判定を
// そのまま尊重する(誤検知よりも見逃しを許容する安全側の設計)。

// 質問(question)を示す強いシグナル。
// 「〜して」で終わっていても、変更ではなく説明・開示を求める表現。
const QUESTION_SIGNAL_PATTERNS: RegExp[] = [

  /説明して/,
  /教えて/,
  /見せて/,
  /示して/,

  /どこから/,
  /どこに/,
  /どこが/,

  /なぜ/,
  /どうして/,

  /信用できる/,
  /信頼できる/,
  /信頼度/,
  /信用度/,

  /目的は/,
  /何を意味/,
  /どういう意味/,

  /弱いところ/,
  /弱点/,

  /一次情報/,
  /出典/,
  /根拠は/,

  /(は|って)\s*何/,
  /\?$/,
  /？$/,

];

// 作業依頼(task)を示す強いシグナル。成果物本文の変更・生成を
// 直接求める動詞。
const TASK_SIGNAL_PATTERNS: RegExp[] = [

  /修正して/,
  /変更して/,
  /更新して/,
  /追加して/,
  /削除して/,
  /書き直して/,
  /書き換えて/,
  /作って/,
  /作成して/,
  /直して/,

  /具体的にして/,
  /詳しくして/,
  /簡潔にして/,
  /短くして/,
  /長くして/,

  /反映して/,
  /組み込んで/,

];

export function applyRequestTypeSafetyNet(
  userInput: string,
  llmRequestType: "task" | "question"
): "task" | "question" {

  if (!userInput) return llmRequestType;

  const hasQuestionSignal =
    QUESTION_SIGNAL_PATTERNS.some((p) => p.test(userInput));

  const hasTaskSignal =
    TASK_SIGNAL_PATTERNS.some((p) => p.test(userInput));

  // 両方のシグナルが同時に検出された場合(複合的な依頼、
  // 「〜を修正した理由を教えて」のような入り組んだ表現等)や、
  // どちらのシグナルも検出されない場合は、誤って安全網が
  // 介入しないよう、LLMの判定をそのまま採用する。
  if (hasQuestionSignal === hasTaskSignal) {
    return llmRequestType;
  }

  return hasQuestionSignal ? "question" : "task";

}
