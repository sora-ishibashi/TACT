// =========================
// Handoff Trigger(Phase104 Section5)
// =========================
//
// 「Primary Agentが継続不能」と判断できる最小条件を定義する。
// Quota取得APIはまだ実装しない(絶対条件、Section5・8)。Coding Agent
// 実行結果(core/codeAgent/types.tsのCodingAgentAdapter.isAvailable()/
// execute()が実際に返す情報)から、決定論的に判定する。
//
// 重要(絶対条件、Section5): 単純なCoding Error(1回の実行がエラー
// 終了した)と「Agent自体が利用不能」(isAvailable()がfalse)を混同
// しない。statusとして最後まで区別し、reasonにもその区別を残す
// (両方を同じ汎用文言へ握りつぶさない)。
//
// 責務(Section4の役割分担どおり): このモジュールは「引き継ぐべきか
// /なぜか」だけを決定する。実際のHandoff State作成は
// claudeToCodexHandoff.ts/handoffManager.tsの責務(責務を混ぜない)。
//
// 依存方向: core/tact-agent/gitState.tsが既にcore/codeAgent/
// gitProvider.tsを再利用している一方向依存(tact-agent → codeAgent)を
// そのまま踏襲する。CodeTask全体は取り込まず、判定に必要な最小限の
// 形(exitCode/timedOut)だけを構造的に受け取る(型としての強い結合を
// 避ける)。

export type AgentContinuationStatus =
  | "success"
  | "failure"
  | "unavailable"
  | "interrupted";

export interface AgentExecutionOutcome {

  // CodingAgentAdapter.isAvailable()の結果。事前チェックの時点で
  // false だった場合、execute()自体を呼んでいないケースを表す
  // (呼び出し側の既存規約——app/api/tact/code-tasks/execute/route.ts
  // ——と同じ、isAvailable()を先に見る前提)。
  availability?: { available: boolean; detail: string };

  // CodingAgentAdapter.execute()が例外を投げた場合のメッセージ。
  executionError?: string;

  // CodingAgentAdapter.execute()が正常に返した場合の実行結果
  // (core/codeAgent/types.tsのCodeTaskExecutionResultと同じ形の
  // 判定に必要な部分だけ)。
  executionResult?: { exitCode: number | null; timedOut: boolean };

}

export interface HandoffTriggerDecision {

  status: AgentContinuationStatus;

  shouldHandoff: boolean;

  reason: string;

}

export function classifyAgentContinuation(
  outcome: AgentExecutionOutcome
): AgentContinuationStatus {

  if (outcome.availability && !outcome.availability.available) {
    return "unavailable";
  }

  if (outcome.executionResult?.timedOut) {
    return "interrupted";
  }

  if (outcome.executionError) {
    return "failure";
  }

  if (outcome.executionResult && outcome.executionResult.exitCode !== 0) {
    return "failure";
  }

  return "success";

}

const CONTINUATION_REASONS: Record<AgentContinuationStatus, string> = {

  success: "正常に完了したため、引き継ぎは不要。",

  unavailable:
    "CodingAgentAdapter.isAvailable()がfalseを返した(Agent自体が実行不可)ため、継続不能と判断。",

  failure:
    "実行がエラー終了した(単純なCoding Errorであり、Agent自体の利用不可(unavailable)とは区別する)ため、継続不能と判断。",

  interrupted:
    "実行がtimeout/中断で終了したため、継続不能と判断。",

};

export function evaluateHandoffTrigger(
  outcome: AgentExecutionOutcome
): HandoffTriggerDecision {

  const status = classifyAgentContinuation(outcome);

  return {
    status,
    shouldHandoff: status !== "success",
    reason: CONTINUATION_REASONS[status],
  };

}
