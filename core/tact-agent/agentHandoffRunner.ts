// =========================
// Generic Agent Handoff Runner(Phase111)
// =========================
//
// core/tact-agent/claudeToCodexHandoff.tsのrunClaudeToCodexHandoff()は
// Claude→Codexという固定ペアの名前・既定値を持っていた。Phase111では
// Agent Orchestrator(core/tact-agent/codingTaskRunner.ts)が
// Claude→Codex/Codex→Claudeのどちらの向きでも同じ経路を使えるよう、
// fromAgent/toAgentを必須の自由文字列として受け取る汎用版をここに
// 定義する。
//
// 重複実装はしない: 意味論(いつHandoffを作るか・何を渡すか)は
// evaluateHandoffTrigger()/createHandoff()/completeHandoff()
// (いずれも既存、無変更)へそのまま委譲するだけ。
// runClaudeToCodexHandoff()は、このファイルへ処理を委譲する薄い
// 後方互換Wrapperとして残す(既存API・既存テストとの互換性を維持する
// ため、rename/削除はしない)。

import { evaluateHandoffTrigger, AgentExecutionOutcome } from "./handoffTrigger";
import { createHandoff, completeHandoff } from "./handoffManager";
import { captureGitState } from "./gitState";
import { AgentHandoffStore, HandoffState, VerificationStatus } from "./types";

export interface RunAgentHandoffInput {

  taskId: string;

  repositoryPath: string;

  outcome: AgentExecutionOutcome;

  completedWork: string[];

  pendingWork: string[];

  verificationStatus: VerificationStatus;

  nextAction: string;

  // claudeToCodexHandoff.tsと異なり、ここでは既定値を持たない
  // (Claude/Codex固有の値をこのファイルへ持ち込まない)。
  fromAgent: string;

  toAgent: string;

}

export interface RunAgentHandoffResult {

  triggered: boolean;

  reason: string;

  handoff?: HandoffState;

}

export async function runAgentHandoff(
  input: RunAgentHandoffInput,
  store?: AgentHandoffStore
): Promise<RunAgentHandoffResult> {

  const decision = evaluateHandoffTrigger(input.outcome);

  if (!decision.shouldHandoff) {

    return {
      triggered: false,
      reason: decision.reason,
    };

  }

  const gitStatus = await captureGitState(input.repositoryPath);

  const handoff = await createHandoff(
    {
      taskId: input.taskId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      reason: decision.reason,
      completedWork: input.completedWork,
      pendingWork: input.pendingWork,
      verificationStatus: input.verificationStatus,
      gitStatus,
      nextAction: input.nextAction,
    },
    store
  );

  const completed = await completeHandoff(handoff.handoffId, store);

  return {
    triggered: true,
    reason: decision.reason,
    handoff: completed,
  };

}
