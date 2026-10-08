import assert from "node:assert/strict";
import { attentionReviewPresentation } from "@tact/runs-core/tact-runs-view/attentionInbox";

const attention = (attentionReason: "permission_mismatch" | "approval_required" | "permission_unknown" | "downstream_permission_conflict", executionStatus: "succeeded" | "failed") => ({ attentionReason, executionStatus, createdAt: "2027-01-01T00:00:00.000Z", acknowledgedAt: null });

const mismatch = attentionReviewPresentation(attention("permission_mismatch", "succeeded"));
assert.equal(mismatch.label, "事後検出：登録ルールと不一致");
assert.equal(mismatch.provenance, "post_execution_permission_finding");
const approval = attentionReviewPresentation(attention("approval_required", "failed"));
assert.equal(approval.label, "事後検出：承認要件あり");
assert.equal(approval.provenance, "post_execution_permission_finding");
assert.match(approval.explanation, /実行前の承認待ちを示すものではありません/);
const downstream = attentionReviewPresentation(attention("downstream_permission_conflict", "succeeded"));
assert.equal(downstream.label, "接続先権限エラー");
assert.equal(downstream.provenance, "downstream_provider_permission_failure");
const unknown = attentionReviewPresentation(attention("permission_unknown", "failed"));
assert.equal(unknown.label, "確認が必要（判定元不明）");
assert.equal(unknown.provenance, "unknown_provenance");

// The projection has no executionStatus input; terminal status cannot decide timing.
assert.deepEqual(attentionReviewPresentation(attention("permission_mismatch", "succeeded")), attentionReviewPresentation(attention("permission_mismatch", "failed")));
console.log("PASS attention governance semantics");
