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
// SOR-178 / SEC-8D cutover(重要、既存コメントの上書き): denied/unknownの
// Attention episode生成は、このfunction(deriveExecutionAttentionCandidate)
// 経由では一切行わなくなった——その2つはSecurityFinding導出
// (../securityFinding/derive.ts)→SecurityFinding永続化→
// ensure_security_finding_attention_link() RPC(../permission/attentionStore.ts
// のensureSecurityFindingAttentionLink())が担う新しい経路に完全に移行した
// (SOR-178 Human Owner Decision C)。このfunctionは今後approval_required
// 専用(deniedは意図的にmapから除外、下記)——「将来denied/mismatchを
// 再度このmap経由に戻す」ことは想定しない(SecurityFinding側がreasonを
// finding_type起点でサーバー側に導出するため、ここでの重複定義は
// 混乱の元になる)。
//
// 絶対条件(SOR-52 M-0原則、SOR-178後も継続):
//   - allowedはAttention対象ではない(元から)。
//   - unknownは(SecurityFinding経由を除き)このfunctionの対象外のまま
//     (推測でAttentionを作らない、という既存原則の帰結)。
//   - approval_requiredはproduct-facing vocabularyへ変換する
//     (APPROVAL_REQUIRED→approval_required、SOR-51指示
//     「Do not flatten approval into denied」を維持)。

import type { CanonicalExecution } from "../types";
import type { PermissionDecision, PermissionDecisionStatus } from "./types";

// SOR-178: permission_unknown/downstream_permission_conflictを追加
// (migration 20270101000015のreason CHECK拡張と同じ4値、
// section10「Attention reason evolution」)。このfunction自身は
// approval_requiredしか生成しないが、型はSecurityFinding経由で作られる
// Attention行のreasonも含めて網羅する(read boundary/UI label mapが
// 1つの型で全reasonを扱えるようにする)。
export type AttentionReason =
  | "permission_mismatch"
  | "approval_required"
  | "permission_unknown"
  | "downstream_permission_conflict";

export const ATTENTION_REASONS: readonly AttentionReason[] = [
  "permission_mismatch",
  "approval_required",
  "permission_unknown",
  "downstream_permission_conflict",
];

// SOR-178後: このmapはapproval_requiredのみを持つ(上記コメント参照)。
// denied(permission_mismatch)/unknown(permission_unknown)/downstream
// conflictはSecurityFinding→ensure_security_finding_attention_link() RPC
// 経由でのみ生成される——ここへ戻さない。
const ATTENTION_REASON_BY_DECISION_STATUS: Partial<Record<PermissionDecisionStatus, AttentionReason>> = {
  approval_required: "approval_required",
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
