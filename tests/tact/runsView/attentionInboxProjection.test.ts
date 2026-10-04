import { attentionDecisionPhase, attentionReasonJapanese, attentionReasonJapaneseExplanation, permissionJapanese } from "@tact/runs-core/tact-runs-view/attentionInbox";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  results.push(check("[SOR-184] terminal canonical execution status is projected as post-execution", attentionDecisionPhase({ executionStatus: "succeeded" }) === "post_execution" && attentionDecisionPhase({ executionStatus: "failed" }) === "post_execution" && attentionDecisionPhase({ executionStatus: "cancelled" }) === "post_execution"));
  results.push(check("[SOR-184] non-terminal execution status fails closed to unknown, never pre-execution", attentionDecisionPhase({ executionStatus: "observed" }) === "unknown" && attentionDecisionPhase({ executionStatus: "running" }) === "unknown"));
  results.push(check("[SOR-184] Japanese projection never exposes attention/permission enums", attentionReasonJapanese("approval_required") === "承認待ち" && attentionReasonJapanese("permission_mismatch") === "登録ルールと不一致" && attentionReasonJapaneseExplanation("permission_unknown") === "権限の評価結果を確認できません。" && permissionJapanese("UNKNOWN") === "判定できません"));
  return summarize("runsView/attentionInboxProjection", results);
}
