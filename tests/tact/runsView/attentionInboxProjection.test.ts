import { attentionDecisionPhase, attentionPrimaryAction, attentionPrimaryActionJapanese, attentionReasonJapanese, attentionReasonJapaneseExplanation, attentionReviewPresentation, permissionJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  results.push(check("[SOR-184] terminal canonical execution status is projected as post-execution", attentionDecisionPhase({ executionStatus: "succeeded" }) === "post_execution" && attentionDecisionPhase({ executionStatus: "failed" }) === "post_execution" && attentionDecisionPhase({ executionStatus: "cancelled" }) === "post_execution"));
  results.push(check("[SOR-184] non-terminal execution status fails closed to unknown, never pre-execution", attentionDecisionPhase({ executionStatus: "observed" }) === "unknown" && attentionDecisionPhase({ executionStatus: "running" }) === "unknown"));
  const postExecution = attentionReviewPresentation({ executionStatus: "succeeded", createdAt: "2026-10-05T14:24:00.000Z", acknowledgedAt: null });
  const unknownExecution = attentionReviewPresentation({ executionStatus: "running", createdAt: "2026-10-05T14:24:00.000Z", acknowledgedAt: null });
  const acknowledged = attentionReviewPresentation({ executionStatus: "succeeded", createdAt: "2026-10-05T14:24:00.000Z", acknowledgedAt: "2026-10-05T14:30:00.000Z" });
  results.push(check("[SOR-255] completed execution is post-execution review and a created Attention timestamp is a record time", postExecution.phase === "post_execution" && postExecution.timestampLabel === "記録日時" && postExecution.timestamp === "2026-10-05T14:24:00.000Z"));
  results.push(check("[SOR-255] an unproven pre/post state fails closed to details, never a preflight approval", unknownExecution.phase === "unknown" && unknownExecution.explanation.includes("詳細")));
  results.push(check("[SOR-255] acknowledged Attention uses its actual acknowledgement timestamp", acknowledged.timestampLabel === "確認日時" && acknowledged.timestamp === "2026-10-05T14:30:00.000Z"));
  results.push(check("[SOR-215] Japanese finding labels never expose attention/permission enums", attentionReasonJapanese("approval_required") === "承認要件あり" && attentionReasonJapanese("permission_mismatch") === "登録ルールと不一致" && attentionReasonJapanese("downstream_permission_conflict") === "接続先権限" && attentionReasonJapaneseExplanation("permission_unknown") === "権限の評価結果を確認できません。" && permissionJapanese("UNKNOWN") === "判定できません" && permissionJapanese("APPROVAL_REQUIRED") === "承認要件あり" && new Set([attentionReasonJapanese("approval_required"), attentionReasonJapanese("permission_mismatch"), attentionReasonJapanese("downstream_permission_conflict")]).size === 3));
  results.push(check("[SOR-215] one lifecycle primary action is selected from status", attentionPrimaryAction({ status: "open" }) === "acknowledge" && attentionPrimaryActionJapanese(attentionPrimaryAction({ status: "open" })) === "確認した" && attentionPrimaryAction({ status: "acknowledged" }) === "resolve" && attentionPrimaryActionJapanese(attentionPrimaryAction({ status: "acknowledged" })) === "解決する" && attentionPrimaryAction({ status: "resolved" }) === null));
  return summarize("runsView/attentionInboxProjection", results);
}
