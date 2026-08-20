// =========================
// TACT Code Evaluation(STEP143-B: F/G)
// =========================
//
// 「コードを変更した」だけで成功扱いにしないため、変更前後で
// 同じWorkflowを実際に再実行し、Evidence件数・Reviewer issue数・
// quality scoreを比較する。
//
// 重要: 既存のCore Workflowエンジン(core/workflow/index.ts)を
// そのまま再利用する(独自の評価ロジックを新たに実装しない)。
//
// 再現可能なuserInput/modeが無い場合(既存のImprovementProposalは
// これを保持していない)、before/afterを比較できないため、
// 存在しないデータを捏造せず"inconclusive"として扱う。

import { runWorkflow } from "../workflow";
import { defaultWorkflow } from "../workflow/defaultWorkflow";
import {
  CodeTaskEvaluationClassification,
  CodeTaskEvaluationMetrics,
  CodeTaskEvaluationTask,
} from "./types";

export async function measureWorkflowMetrics(
  evaluationTask: CodeTaskEvaluationTask
): Promise<CodeTaskEvaluationMetrics> {

  const context =
    await runWorkflow(
      defaultWorkflow,
      evaluationTask.userInput,
      evaluationTask.mode
    );

  const reviewer =
    context.outputs.reviewer as
      | { issues?: unknown[] }
      | undefined;

  return {
    evidenceCount: context.evidence?.length ?? 0,
    reviewerIssueCount:
      Array.isArray(reviewer?.issues)
        ? reviewer.issues.length
        : 0,
    qualityScore:
      context.executionRecord?.quality?.score ?? null,
  };

}

export function classifyEvaluation(
  before: CodeTaskEvaluationMetrics | null,
  after: CodeTaskEvaluationMetrics | null
): {
  classification: CodeTaskEvaluationClassification;
  reason?: string;
} {

  if (!before || !after) {

    return {
      classification: "inconclusive",
      reason:
        "evaluationTaskが指定されていないため、before/afterを" +
        "比較できなかった(再現可能なWorkflow入力が無い)。",
    };

  }

  if (before.qualityScore !== null && after.qualityScore !== null) {

    if (after.qualityScore > before.qualityScore) {
      return { classification: "improved" };
    }

    if (after.qualityScore < before.qualityScore) {
      return { classification: "degraded" };
    }

    return { classification: "unchanged" };

  }

  // quality scoreが取得できない場合のフォールバック:
  // Evidence件数の増加・Reviewer issue数の減少を「改善」の代理指標とする。
  const evidenceImproved =
    after.evidenceCount > before.evidenceCount;

  const issuesImproved =
    after.reviewerIssueCount < before.reviewerIssueCount;

  const evidenceWorse =
    after.evidenceCount < before.evidenceCount;

  const issuesWorse =
    after.reviewerIssueCount > before.reviewerIssueCount;

  if ((evidenceImproved || issuesImproved) && !evidenceWorse && !issuesWorse) {
    return { classification: "improved" };
  }

  if (evidenceWorse || issuesWorse) {
    return { classification: "degraded" };
  }

  return { classification: "unchanged" };

}
