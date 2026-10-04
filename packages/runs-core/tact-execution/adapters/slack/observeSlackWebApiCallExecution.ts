// =========================
// TACT Canonical Execution — Slack Web API Call Observation (SOR-130 Reality Test)
// =========================
//
// normalizeSlackWebApiCallExecution.tsの結果をGeneric Observation
// Gatewayへ橋渡しするだけの薄いwrapper。Slack固有のorchestration
// ロジックは一切持たない(既存のobserveSlackAppMentionExecution.ts
// と同じ形)。

import {
  captureExecution as defaultCaptureExecution,
} from "../../store";
import { observeExecutionPermission as defaultObserveExecutionPermission } from "../../permission";
import {
  observeExecutionWorkCorrelation as defaultObserveExecutionWorkCorrelation,
} from "../../correlation";
import {
  normalizeSlackWebApiInvocationToExecution,
  SLACK_WEB_API_ADAPTER_VERSION,
  type SlackWebApiInvocationObservation,
} from "./normalizeSlackWebApiCallExecution";
import {
  recordIngestionFailure as defaultRecordIngestionFailure,
} from "../../telemetry/ingestionFailureStore";
import { observeCanonicalExecution } from "../../gateway/observeCanonicalExecution";
import type { ObservationSource, ObserveCanonicalExecutionDeps } from "../../gateway/types";

export type ObserveSlackWebApiCallExecutionDeps = ObserveCanonicalExecutionDeps;

const defaultDeps: ObserveSlackWebApiCallExecutionDeps = {
  captureExecution: defaultCaptureExecution,
  observeExecutionPermission: defaultObserveExecutionPermission,
  observeExecutionWorkCorrelation: defaultObserveExecutionWorkCorrelation,
  onFailure: (stage, error) => {
    const errorKind = error instanceof Error ? error.name.slice(0, 100) : typeof error;
    console.error("[tact-execution/slack] web api observation failed", { stage, errorKind });
  },
  recordIngestionFailure: async (input) => {
    try {
      await defaultRecordIngestionFailure(input);
    } catch {
      // Telemetry is best-effort and must never affect the observation pipeline itself.
    }
  },
};

export async function observeSlackWebApiCallExecution(
  observation: SlackWebApiInvocationObservation,
  deps: ObserveSlackWebApiCallExecutionDeps = defaultDeps
): Promise<void> {

  const normalized = normalizeSlackWebApiInvocationToExecution(observation);

  const source: ObservationSource = {
    userId: observation.userId,
    provider: "slack",
    connectionId: observation.connectionId ?? null,
    adapterVersion: SLACK_WEB_API_ADAPTER_VERSION,
  };

  await observeCanonicalExecution(normalized, source, deps);

}

export type SlackWebApiToolInvocationContext = Omit<SlackWebApiInvocationObservation, "status" | "errorCode">;

export async function executeWithSlackWebApiObservation<T>(
  context: SlackWebApiToolInvocationContext,
  executeCall: () => Promise<T>,
  deps: ObserveSlackWebApiCallExecutionDeps = defaultDeps
): Promise<T> {
  try {
    const result = await executeCall();
    await observeSlackWebApiCallExecution({ ...context, status: "succeeded" }, deps);
    return result;
  } catch (error) {
    await observeSlackWebApiCallExecution({ ...context, status: "failed" }, deps);
    throw error;
  }
}
