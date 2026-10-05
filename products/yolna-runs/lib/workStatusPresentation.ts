const knownWorkStatusLabels: Record<string, string> = {
  created: "作成済み",
  planning: "計画中",
  running: "進行中",
  waiting_for_input: "入力待ち",
  waiting_for_approval: "承認待ち",
  completed: "完了",
  failed: "失敗",
  cancelled: "取消済み",
};

/** Product-only projection. Unknown canonical values remain visible without inferred meaning. */
export function workStatusPresentation(status: string): string {
  return knownWorkStatusLabels[status] ?? status;
}
