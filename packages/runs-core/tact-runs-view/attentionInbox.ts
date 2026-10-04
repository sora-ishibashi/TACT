import type { AttentionCardView } from "./index";

// SOR-184 deliberately does not infer "not executed" from
// preExecutionVisible. That field describes an observation capability, not the
// current fact that an action has not happened. A terminal canonical execution
// status is the only fact this read model can use for a post-execution card.
export type AttentionDecisionPhase = "post_execution" | "unknown";

export function attentionDecisionPhase(item: Pick<AttentionCardView, "executionStatus">): AttentionDecisionPhase {
  return item.executionStatus === "succeeded" || item.executionStatus === "failed" || item.executionStatus === "cancelled"
    ? "post_execution"
    : "unknown";
}

export function attentionReasonJapanese(reason: AttentionCardView["attentionReason"]): string {
  switch (reason) {
    case "approval_required": return "承認待ち";
    case "permission_mismatch": return "登録ルールと不一致";
    case "permission_unknown": return "判定できません";
    case "downstream_permission_conflict": return "接続先の権限情報を確認してください";
  }
}

export function permissionJapanese(result: AttentionCardView["permissionEvaluation"]): string {
  switch (result) {
    case "MATCH": return "登録ルールに一致";
    case "MISMATCH": return "登録ルールと不一致";
    case "APPROVAL_REQUIRED": return "承認待ち";
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
