import type { AttentionCardView } from "./index";

// SOR-184 deliberately does not infer "not executed" from
// preExecutionVisible. That field describes an observation capability, not the
// current fact that an action has not happened. A terminal canonical execution
// status is the only fact this read model can use for a post-execution card.
export type AttentionDecisionPhase = "post_execution" | "unknown";
export type AttentionPrimaryAction = "acknowledge" | "resolve" | null;

export function attentionDecisionPhase(item: Pick<AttentionCardView, "executionStatus">): AttentionDecisionPhase {
  return item.executionStatus === "succeeded" || item.executionStatus === "failed" || item.executionStatus === "cancelled"
    ? "post_execution"
    : "unknown";
}

export function attentionReasonJapanese(reason: AttentionCardView["attentionReason"]): string {
  switch (reason) {
    case "approval_required": return "承認要件あり";
    case "permission_mismatch": return "登録ルールと不一致";
    case "permission_unknown": return "権限を確認できません";
    case "downstream_permission_conflict": return "接続先権限";
  }
}

/** Keeps the UI within the lifecycle actions the existing API supports. */
export function attentionPrimaryAction(item: Pick<AttentionCardView, "status">): AttentionPrimaryAction {
  switch (item.status) {
    case "open": return "acknowledge";
    case "acknowledged": return "resolve";
    case "resolved": return null;
  }
}

export function attentionPrimaryActionJapanese(action: AttentionPrimaryAction): string | null {
  switch (action) {
    case "acknowledge": return "確認した";
    case "resolve": return "解決する";
    case null: return null;
  }
}

export function attentionStatusJapanese(status: AttentionCardView["status"]): string {
  switch (status) {
    case "open": return "未確認";
    case "acknowledged": return "確認済み";
    case "resolved": return "解決済み";
  }
}

export function attentionReasonJapaneseExplanation(reason: AttentionCardView["attentionReason"]): string {
  switch (reason) {
    case "approval_required": return "この操作には人による承認が必要と記録されています。";
    case "permission_mismatch": return "登録ルールの評価と一致しない記録があります。";
    case "permission_unknown": return "権限の評価結果を確認できません。";
    case "downstream_permission_conflict": return "接続先の権限情報と整合しない記録があります。";
  }
}

export function permissionJapanese(result: AttentionCardView["permissionEvaluation"]): string {
  switch (result) {
    case "MATCH": return "登録ルールに一致";
    case "MISMATCH": return "登録ルールと不一致";
    case "APPROVAL_REQUIRED": return "承認要件あり";
    case "UNKNOWN": return "判定できません";
  }
}

export function executionResultJapanese(status: AttentionCardView["executionStatus"]): string {
  switch (status) {
    case "succeeded": return "完了";
    case "failed": return "失敗";
    case "cancelled": return "取り消し";
    case "running": return "実行中";
    case "observed": return "観測済み";
    case "unknown": return "判定できません";
  }
}

export function actionJapanese(action: string): string {
  const labels: Record<string, string> = {
    CREATE: "作成", CREATE_PAGE: "ページを作成", UPDATE: "更新", UPDATE_PAGE: "ページを更新",
    DELETE: "削除", DELETE_PAGE: "ページを削除", SEND: "送信", READ: "読み取り",
  };
  return labels[action] ?? "操作";
}
