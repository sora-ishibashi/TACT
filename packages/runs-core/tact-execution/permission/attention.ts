// =========================
// TACT Canonical Execution — Attention Candidate (SOR-51 / SOR-52)
// =========================
//
// SOR-51が用意した入口(pure domain function、新規DB tableなし)を、
// SOR-52指示に合わせて最小限拡張する。既存関数を書き直すのではなく、
// 「どのPermissionDecisionStatusがAttention対象か」「product-facing
// reasonへどう変換するか」を1つのmapへ切り出す——これがSOR-52指示
// section12の「後からconfigurableにできるextension pointを壊さない」
// への回答であり、再実装ではなく最小差分。
//
// 絶対条件(SOR-52 M-0原則):
//   - allowedはAttention対象ではない(元から)。
//   - unknownもM-0では対象外(SOR-52で明示的に決定——SOR-51時点は
//     暫定でcandidateを出していたが、これは「危険側」の暫定値であり、
//     SOR-52の明示ruleがこれを正式に上書きする)。推測でAttentionを
//     作らない、という既存原則の帰結。
//   - denied/approval_requiredはproduct-facing vocabularyへ変換する
//     (MISMATCH→permission_mismatch、APPROVAL_REQUIRED→approval_required、
//     SOR-51指示「Do not flatten approval into denied」を維持)。

import type { CanonicalExecution } from "../types";
import type { PermissionDecision, PermissionDecisionStatus } from "./types";

export type AttentionReason = "permission_mismatch" | "approval_required";

export const ATTENTION_REASONS: readonly AttentionReason[] = ["permission_mismatch", "approval_required"];

// SOR-52 M-0 rule(明示的、section12「UNKNOWN handling」):
// このmapに載っているPermissionDecisionStatusだけがAttention対象。
// unknownを対象化したくなった場合は、ここへ1行足すだけでよい
// (evaluator/policy/derive関数自体は変更不要)。
const ATTENTION_REASON_BY_DECISION_STATUS: Partial<Record<PermissionDecisionStatus, AttentionReason>> = {
  denied: "permission_mismatch",
  approval_required: "approval_required",
  // unknown: 意図的に未登録(M-0原則「UNKNOWN → Attentionなし」)。
};

export interface ExecutionAttentionCandidate {

  executionId: string;

  userId: string;

  provider: CanonicalExecution["provider"];

  operation: string;

  reason: AttentionReason;

  reasonCode: string;

  policyId: string | null;

  occurredAt: string;

}

// allowed、およびM-0では対象外のunknownはnullを返す(注意を要さない/
// 推測でAttentionを作らない、絶対条件)。
export function deriveExecutionAttentionCandidate(
  execution: CanonicalExecution,
  decision: PermissionDecision
): ExecutionAttentionCandidate | null {

  const reason = ATTENTION_REASON_BY_DECISION_STATUS[decision.status];

  if (!reason) {
    return null;
  }

  return {
    executionId: execution.id,
    userId: execution.userId,
    provider: execution.provider,
    operation: execution.operation,
    reason,
    reasonCode: decision.reasonCode,
    policyId: decision.policyId,
    occurredAt: decision.evaluatedAt,
  };

}
