import type { AttentionCardView } from "./index";

// Attention is an execution-linked, post-observation read model. It is not a
// GovernanceApprovalRequest: only that separate durable record may show an
// actual pre-execution approval wait. Execution status is intentionally not
// an input to this classification.
export type AttentionPresentationProvenance =
  | "post_execution_permission_finding"
  | "downstream_provider_permission_failure"
  | "unknown_provenance";
export type AttentionPrimaryAction = "acknowledge" | "resolve" | null;

export type AttentionReviewPresentation = {
  provenance: AttentionPresentationProvenance;
  label: string;
  heading: string;
  explanation: string;
  timestampLabel: "検出日時" | "確認日時";
  timestamp: string;
};

export function attentionPresentationProvenance(item: Pick<AttentionCardView, "attentionReason">): AttentionPresentationProvenance {
  switch (item.attentionReason) {
    case "permission_mismatch":
    case "approval_required": return "post_execution_permission_finding";
    case "downstream_permission_conflict": return "downstream_provider_permission_failure";
    case "permission_unknown": return "unknown_provenance";
  }
}

export function attentionReviewPresentation(item: Pick<AttentionCardView, "attentionReason" | "createdAt" | "acknowledgedAt">): AttentionReviewPresentation {
  const provenance = attentionPresentationProvenance(item);
  const presentation = (() => {
    switch (item.attentionReason) {
      case "permission_mismatch": return { label: "事後検出：登録ルールと不一致", explanation: "実行の観測後に、登録ルールとの不一致が検出されました。" };
      case "approval_required": return { label: "事後検出：承認要件あり", explanation: "実行の観測後に、承認要件があることが検出されました。これは実行前の承認待ちを示すものではありません。" };
      case "downstream_permission_conflict": return { label: "接続先権限エラー", explanation: "接続先で観測された権限情報に不整合があります。" };
      case "permission_unknown": return { label: "確認が必要（判定元不明）", explanation: "この Attention の判定元を既存データから確定できません。" };
    }
  })();
  return { provenance, label: presentation.label, heading: presentation.label, explanation: presentation.explanation, timestampLabel: item.acknowledgedAt ? "確認日時" : "検出日時", timestamp: item.acknowledgedAt ?? item.createdAt };
}

export function attentionReasonJapanese(reason: AttentionCardView["attentionReason"]): string {
  switch (reason) {
    case "approval_required": return "承認要件あり";
    case "permission_mismatch": return "登録ルールと不一致";
    case "permission_unknown": return "権限を確認できません";
    case "downstream_permission_conflict": return "接続先権限";
  }
}

export function attentionPrimaryAction(item: Pick<AttentionCardView, "status">): AttentionPrimaryAction {
  switch (item.status) { case "open": return "acknowledge"; case "acknowledged": return "resolve"; case "resolved": return null; }
}
export function attentionPrimaryActionJapanese(action: AttentionPrimaryAction): string | null { return action === "acknowledge" ? "確認済みにする" : action === "resolve" ? "解決する" : null; }
export function attentionStatusJapanese(status: AttentionCardView["status"]): string { switch (status) { case "open": return "未確認"; case "acknowledged": return "確認済み"; case "resolved": return "解決済み"; } }
export function attentionReasonJapaneseExplanation(reason: AttentionCardView["attentionReason"]): string { return attentionReviewPresentation({ attentionReason: reason, createdAt: "", acknowledgedAt: null }).explanation; }
export function permissionJapanese(result: AttentionCardView["permissionEvaluation"]): string { switch (result) { case "MATCH": return "登録ルールに一致"; case "MISMATCH": return "登録ルールと不一致"; case "APPROVAL_REQUIRED": return "承認要件あり"; case "UNKNOWN": return "判定できません"; } }
export function executionResultJapanese(status: AttentionCardView["executionStatus"]): string { switch (status) { case "succeeded": return "完了"; case "failed": return "失敗"; case "cancelled": return "取り消し"; case "running": return "実行中"; case "observed": return "観測済み"; case "unknown": return "判定できません"; } }
export function actionJapanese(action: string): string { const labels: Record<string, string> = { CREATE: "作成", CREATE_PAGE: "ページを作成", UPDATE: "更新", UPDATE_PAGE: "ページを更新", DELETE: "削除", DELETE_PAGE: "ページを削除", SEND: "送信", READ: "読み取り" }; return labels[action] ?? "操作"; }
