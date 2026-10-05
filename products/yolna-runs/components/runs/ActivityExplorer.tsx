"use client";

import type { ActivityItemView } from "@tact/runs-core/tact-runs-view";
import ActivityTable from "./ActivityTable";

export type ActivityExplorerProps = {
  items: ActivityItemView[];
  attentionExecutionIds: ReadonlySet<string>;
  selectedExecutionId: string | null;
  onSelectExecution: (executionId: string) => void;
  onSelectWork: (workId: string) => void;
  onReviewCorrelation: (executionId: string) => void;
};

/**
 * Explorer composition boundary. Other Runs sections keep the shared
 * `onSelectExecution(executionId)` contract and never own an execution detail.
 */
export function ActivityExplorer(props: ActivityExplorerProps) {
  return <ActivityTable {...props} />;
}
