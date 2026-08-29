// =========================
// Codex Resume(Phase104 Section7)
// =========================
//
// Codex側が「どのTaskについて、何から再開すればよいか」を1回の
// 呼び出しで取得するための、taskId起点の合成。
//
// 既存のresumeFromHandoff()(handoffManager.ts)はhandoffId起点の
// ままにしている(既存シグネチャを変更しない、絶対条件)。ここでは
// getCurrentHandoff()で対象Taskの最新HandoffIdを求めてから
// resumeFromHandoff()へ委譲するだけの薄い合成にとどめる
// (重複実装しない)。

import { getCurrentHandoff, resumeFromHandoff, ResumeFromHandoffResult } from "./handoffManager";
import { AgentHandoffStore } from "./types";

// resumeFromHandoff(taskId) 相当の入口。対象TaskにHandoffが1件も
// 無い場合はundefinedを返す(存在しないHandoffを捏造しない)。
export async function resumeLatestHandoffForTask(
  taskId: string,
  store?: AgentHandoffStore
): Promise<ResumeFromHandoffResult | undefined> {

  const latest = await getCurrentHandoff(taskId, store);

  if (!latest) {
    return undefined;
  }

  return resumeFromHandoff(latest.handoffId, store);

}

// 次のAgentへ渡すInstructionを、Handoffの情報だけから決定論的に組み立てる
// (絶対条件、Section7: Prompt生成ロジックを過度に高度化しない・LLM
// 呼び出しは行わない。単純な文字列組み立てのみ)。
//
// Phase111: 実装自体はもともとCodex固有の文言を一切含んでおらず
// (completedWork/pendingWork/nextAction/gitStatus/verificationStatusのみ
// を使う)、Claude→Codex/Codex→Claudeのどちらの向きでもそのまま使える。
// Agent Orchestrator(core/tact-agent/codingTaskRunner.ts)からは、この
// 汎用名で呼び出す。既存のbuildCodexResumeInstruction()は、この関数への
// 別名としてそのまま残す(既存API・既存テストとの互換性を維持するため、
// rename/削除はしない)。
export function buildAgentResumeInstruction(
  result: ResumeFromHandoffResult
): string {

  const { task, handoff } = result;

  const lines: string[] = [];

  lines.push(`# Handoff Resume: ${task?.title ?? handoff.taskId}`);

  if (task?.description) {
    lines.push("", "## Task", task.description);
  }

  lines.push("", "## 完了済み(再実行しないこと)");
  lines.push(
    handoff.completedWork.length > 0
      ? handoff.completedWork.map((w) => `- ${w}`).join("\n")
      : "- (記録なし)"
  );

  lines.push("", "## 未完了(ここから再開)");
  lines.push(
    handoff.pendingWork.length > 0
      ? handoff.pendingWork.map((w) => `- ${w}`).join("\n")
      : "- (記録なし)"
  );

  lines.push("", "## 次にやること", handoff.nextAction);

  lines.push(
    "",
    "## Git状態",
    `branch=${handoff.gitStatus.branch}, lastCommit=${handoff.gitStatus.lastCommit}, ` +
      `workingTree=${handoff.gitStatus.workingTreeStatus}` +
      (handoff.gitStatus.dirtyFileCount !== undefined
        ? `, dirtyFiles=${handoff.gitStatus.dirtyFileCount}`
        : "")
  );

  const verificationEntries = Object.entries(handoff.verificationStatus.checks);

  if (verificationEntries.length > 0) {

    lines.push(
      "",
      "## 検証済み状態",
      verificationEntries.map(([name, checkResult]) => `- ${name}: ${checkResult}`).join("\n")
    );

  }

  return lines.join("\n");

}

// 既存API名との互換性のためのエイリアス(Phase104〜110で既に
// import済みの呼び出し元・テストをそのまま動かし続けるため、
// rename/削除はしない)。
export const buildCodexResumeInstruction = buildAgentResumeInstruction;
