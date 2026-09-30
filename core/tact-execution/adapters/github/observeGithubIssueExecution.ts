// =========================
// TACT Canonical Execution — GitHub Issue Observation (SOR-130 Reality Test)
// =========================
//
// core/tact-execution/adapters/notion/observeNotionMcpExecution.tsと
// 同じ形の薄いwrapper。normalize結果をGeneric Observation Gateway
// (core/tact-execution/gateway/observeCanonicalExecution.ts)へ橋渡し
// するだけで、GitHub固有のorchestrationロジックは一切持たない。

import {
  captureExecution as defaultCaptureExecution,
} from "../../store";
import { observeExecutionPermission as defaultObserveExecutionPermission } from "../../permission";
import {
  observeExecutionWorkCorrelation as defaultObserveExecutionWorkCorrelation,
} from "../../correlation";
import {
  normalizeGithubIssueInvocationToExecution,
  GITHUB_ISSUE_ADAPTER_VERSION,
  type GithubIssueInvocationObservation,
} from "./normalizeGithubIssueExecution";
import {
  recordIngestionFailure as defaultRecordIngestionFailure,
} from "../../telemetry/ingestionFailureStore";
import { observeCanonicalExecution } from "../../gateway/observeCanonicalExecution";
import type { ObservationSource, ObserveCanonicalExecutionDeps } from "../../gateway/types";

export type ObserveGithubIssueExecutionDeps = ObserveCanonicalExecutionDeps;

const defaultDeps: ObserveGithubIssueExecutionDeps = {
  captureExecution: defaultCaptureExecution,
  observeExecutionPermission: defaultObserveExecutionPermission,
  observeExecutionWorkCorrelation: defaultObserveExecutionWorkCorrelation,
  onFailure: (stage, error) => {
    const errorKind = error instanceof Error ? error.name.slice(0, 100) : typeof error;
    console.error("[tact-execution/github] observation failed", { stage, errorKind });
  },
  recordIngestionFailure: async (input) => {
    try {
      await defaultRecordIngestionFailure(input);
    } catch {
      // Telemetry is best-effort and must never affect the observation pipeline itself.
    }
  },
};

export async function observeGithubIssueExecution(
  observation: GithubIssueInvocationObservation,
  deps: ObserveGithubIssueExecutionDeps = defaultDeps
): Promise<void> {

  const normalized = normalizeGithubIssueInvocationToExecution(observation);

  const source: ObservationSource = {
    userId: observation.userId,
    provider: "custom",
    connectionId: observation.connectionId ?? null,
    adapterVersion: GITHUB_ISSUE_ADAPTER_VERSION,
  };

  await observeCanonicalExecution(normalized, source, deps);

}

export type GithubIssueToolInvocationContext = Omit<GithubIssueInvocationObservation, "status" | "errorCode">;

/**
 * Convenience combinator mirroring executeWithNotionMcpObservation(): wraps
 * one real GitHub API call and observes it as succeeded/failed afterward.
 */
export async function executeWithGithubIssueObservation<T>(
  context: GithubIssueToolInvocationContext,
  executeCall: () => Promise<T>,
  deps: ObserveGithubIssueExecutionDeps = defaultDeps
): Promise<T> {
  try {
    const result = await executeCall();
    await observeGithubIssueExecution({ ...context, status: "succeeded" }, deps);
    return result;
  } catch (error) {
    await observeGithubIssueExecution({ ...context, status: "failed" }, deps);
    throw error;
  }
}
