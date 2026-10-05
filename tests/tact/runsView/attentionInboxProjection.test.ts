import { attentionDecisionPhase, attentionPrimaryAction, attentionPrimaryActionJapanese, attentionReasonJapanese, attentionReasonJapaneseExplanation, permissionJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  results.push(check("[SOR-184] terminal canonical execution status is projected as post-execution", attentionDecisionPhase({ executionStatus: "succeeded" }) === "post_execution" && attentionDecisionPhase({ executionStatus: "failed" }) === "post_execution" && attentionDecisionPhase({ executionStatus: "cancelled" }) === "post_execution"));
  results.push(check("[SOR-184] non-terminal execution status fails closed to unknown, never pre-execution", attentionDecisionPhase({ executionStatus: "observed" }) === "unknown" && attentionDecisionPhase({ executionStatus: "running" }) === "unknown"));
  results.push(check("[SOR-215] Japanese finding labels never expose attention/permission enums", attentionReasonJapanese("approval_required") === "承認要件あり" && attentionReasonJapanese("permission_mismatch") === "登録ルールと不一致" && attentionReasonJapanese("downstream_permission_conflict") === "接続先権限" && attentionReasonJapaneseExplanation("permission_unknown") === "権限の評価結果を確認できません。" && permissionJapanese("UNKNOWN") === "判定できません" && permissionJapanese("APPROVAL_REQUIRED") === "承認要件あり" && new Set([attentionReasonJapanese("approval_required"), attentionReasonJapanese("permission_mismatch"), attentionReasonJapanese("downstream_permission_conflict")]).size === 3));
  results.push(check("[SOR-215] one lifecycle primary action is selected from status", attentionPrimaryAction({ status: "open" }) === "acknowledge" && attentionPrimaryActionJapanese(attentionPrimaryAction({ status: "open" })) === "確認した" && attentionPrimaryAction({ status: "acknowledged" }) === "resolve" && attentionPrimaryActionJapanese(attentionPrimaryAction({ status: "acknowledged" })) === "解決する" && attentionPrimaryAction({ status: "resolved" }) === null));
  return summarize("runsView/attentionInboxProjection", results);
}
