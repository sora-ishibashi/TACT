export type PresentationExecutionStatus = "observed" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export function summarizeActivityStatuses(items: readonly { executionStatus: PresentationExecutionStatus }[]) {
  return items.reduce((summary, item) => {
    if (item.executionStatus === "failed") summary.failed += 1;
    if (item.executionStatus === "running") summary.running += 1;
    if (item.executionStatus === "succeeded") summary.succeeded += 1;
    return summary;
  }, { failed: 0, running: 0, succeeded: 0 });
}

export function isAttentionDanger(reason: string): boolean {
  return reason === "permission_mismatch" || reason === "downstream_permission_conflict";
}
