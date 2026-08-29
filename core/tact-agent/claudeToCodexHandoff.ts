// =========================
// Claude → Codex Handoff(Phase104 Section6)
// =========================
//
// Claude Codeが継続不能と判定された場合に、実際にHandoff Stateを
// 作成し、担当をCodexへ切り替えるところまでを1つの操作としてまとめる。
// 個々の意味論(Handoff作成/完了/Git状態取得)は既存の
// handoffManager.ts・gitState.tsへそのまま委譲するだけで、ここでは
// 「いつ・何を渡して呼ぶか」という手順だけを持つ(重複実装しない)。
//
// 絶対条件: completedWork/pendingWork/verificationStatus/nextActionは
// 実際のTask内容を知っている呼び出し元からそのまま受け取る。この
// モジュール自身が「何が完了したか」を推測・捏造しない
// (Section6「completedWorkとpendingWorkを混同しない」の裏返し——
// どちらも自動生成しない)。
//
// Phase111: Agent Orchestrator(core/tact-agent/codingTaskRunner.ts)は
// Claude→Codexだけでなく任意のAgentペア(Codex→Claude等)でHandoffを
// 使うため、fromAgent/toAgentを固定しない汎用実装を
// core/tact-agent/agentHandoffRunner.tsへ切り出した。この
// ファイルは、既存API(runClaudeToCodexHandoff/ClaudeToCodexHandoffInput/
// ClaudeToCodexHandoffResult、および既定値fromAgent="claude-code"/
// toAgent="codex")との互換性を保つための薄いWrapperとして残す
// (重複実装しない、rename/削除はしない)。

import { AgentExecutionOutcome } from "./handoffTrigger";
import { runAgentHandoff } from "./agentHandoffRunner";
import { AgentHandoffStore, HandoffState, VerificationStatus } from "./types";

export interface ClaudeToCodexHandoffInput {

  taskId: string;

  // captureGitState()に渡すリポジトリパス。
  repositoryPath: string;

  outcome: AgentExecutionOutcome;

  completedWork: string[];

  pendingWork: string[];

  verificationStatus: VerificationStatus;

  nextAction: string;

  // 既定 "claude-code" → "codex"。将来他のAgentペアにも使えるよう
  // 上書き可能にする(値のハードコード禁止、絶対条件)。
  fromAgent?: string;

  toAgent?: string;

}

export interface ClaudeToCodexHandoffResult {

  triggered: boolean;

  reason: string;

  handoff?: HandoffState;

}

export async function runClaudeToCodexHandoff(
  input: ClaudeToCodexHandoffInput,
  store?: AgentHandoffStore
): Promise<ClaudeToCodexHandoffResult> {

  return runAgentHandoff(
    {
      taskId: input.taskId,
      repositoryPath: input.repositoryPath,
      outcome: input.outcome,
      completedWork: input.completedWork,
      pendingWork: input.pendingWork,
      verificationStatus: input.verificationStatus,
      nextAction: input.nextAction,
      fromAgent: input.fromAgent ?? "claude-code",
      toAgent: input.toAgent ?? "codex",
    },
    store
  );

}
