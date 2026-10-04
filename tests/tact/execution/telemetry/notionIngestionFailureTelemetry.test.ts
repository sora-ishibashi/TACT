// =========================
// TACT Canonical Execution — Notion MCP Ingestion Failure Telemetry Wiring
// (SOR-46: onFailure() console.error is preserved unchanged; this suite
// verifies the new, optional recordIngestionFailure() side-channel)
// =========================

import {
  observeNotionMcpExecution,
  type ObserveNotionMcpExecutionDeps,
} from "@tact/runs-core/tact-execution/adapters/notion/observeNotionMcpExecution";
import type { NotionMcpInvocationObservation } from "@tact/runs-core/tact-execution/adapters/notion/normalizeNotionMcpExecution";
import type { CanonicalExecution } from "@tact/runs-core/tact-execution/types";
import type { RecordIngestionFailureInput } from "@tact/runs-core/tact-execution/telemetry/ingestionFailureStore";
import { check, summarize, type CheckResult } from "../../lib/check";

function baseObservation(overrides: Partial<NotionMcpInvocationObservation> = {}): NotionMcpInvocationObservation {
  return {
    userId: "user-1",
    actorKind: "ai_agent",
    principalId: "principal-1",
    agentId: "agent-1",
    connectionId: "connection-1",
    accountRef: "notion-account-1",
    invocationId: "mcp-invocation-1",
    toolName: "notion.pages.retrieve",
    operation: "READ",
    resource: { type: "page", ref: "page-1" },
    status: "succeeded",
    observedAt: "2026-09-20T00:00:01.000Z",
    ...overrides,
  };
}

function capturedOutcome(executionOverrides: Partial<CanonicalExecution> = {}) {
  return {
    status: "captured" as const,
    execution: { permissionStatus: "unknown", provider: "mcp", connectionId: "connection-1", adapterVersion: "notion-mcp-v1", userId: "user-1", ...executionOverrides } as CanonicalExecution,
  };
}

function noopPermission(): ObserveNotionMcpExecutionDeps["observeExecutionPermission"] {
  return async () => ({ status: "persisted" as const, decision: {} as never, decisionId: "decision-stub" });
}

function noopCorrelation(): ObserveNotionMcpExecutionDeps["observeExecutionWorkCorrelation"] {
  return async () => ({ status: "persisted" as const, decision: {} as never });
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // Stage 1: normalization failure.
  {
    const recorded: RecordIngestionFailureInput[] = [];
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome(),
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => undefined,
      recordIngestionFailure: async (input) => { recorded.push(input); },
    };

    await observeNotionMcpExecution(baseObservation({ invocationId: "" }), deps);

    results.push(check(
      "[normalization] a normalization failure records sanitized telemetry with stage=normalization and the observation's own userId/connectionId",
      recorded.length === 1 &&
        recorded[0].stage === "normalization" &&
        recorded[0].userId === "user-1" &&
        recorded[0].provider === "mcp" &&
        recorded[0].connectionId === "connection-1" &&
        recorded[0].errorKind.length > 0
    ));
  }

  // Stage 2: capture throws.
  {
    const recorded: RecordIngestionFailureInput[] = [];
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => { throw new TypeError("database unavailable"); },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => undefined,
      recordIngestionFailure: async (input) => { recorded.push(input); },
    };

    await observeNotionMcpExecution(baseObservation(), deps);

    results.push(check(
      "[capture/throw] a captureExecution() exception records stage=capture with a sanitized error kind (never the raw message)",
      recorded.length === 1 && recorded[0].stage === "capture" && recorded[0].errorKind === "TypeError"
    ));
  }

  // Stage 2b: capture returns a non-throwing failure status.
  {
    const recorded: RecordIngestionFailureInput[] = [];
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => ({ status: "unavailable" as const }),
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => undefined,
      recordIngestionFailure: async (input) => { recorded.push(input); },
    };

    await observeNotionMcpExecution(baseObservation(), deps);

    results.push(check(
      "[capture/unavailable] a captureExecution() 'unavailable' outcome also records stage=capture telemetry",
      recorded.length === 1 && recorded[0].stage === "capture"
    ));
  }

  // Stage 3: permission evaluation throws.
  {
    const recorded: RecordIngestionFailureInput[] = [];
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome({ permissionStatus: "pending" }),
      observeExecutionPermission: async () => { throw new Error("permission store unavailable"); },
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => undefined,
      recordIngestionFailure: async (input) => { recorded.push(input); },
    };

    await observeNotionMcpExecution(baseObservation(), deps);

    results.push(check(
      "[permission_evaluation] a permission evaluation failure records stage=permission_evaluation using the persisted execution's own provider/connectionId",
      recorded.length === 1 && recorded[0].stage === "permission_evaluation" && recorded[0].provider === "mcp" && recorded[0].connectionId === "connection-1"
    ));
  }

  // Stage 4: work correlation throws.
  {
    const recorded: RecordIngestionFailureInput[] = [];
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome(),
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: async () => { throw new Error("correlation store unavailable"); },
      onFailure: () => undefined,
      recordIngestionFailure: async (input) => { recorded.push(input); },
    };

    await observeNotionMcpExecution(baseObservation(), deps);

    results.push(check(
      "[work_correlation] a work correlation failure records stage=work_correlation",
      recorded.length === 1 && recorded[0].stage === "work_correlation"
    ));
  }

  // Backward compatibility: existing callers that omit recordIngestionFailure entirely are unaffected.
  {
    let onFailureCalls = 0;
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => { throw new Error("boom"); },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => { onFailureCalls += 1; },
      // recordIngestionFailure intentionally omitted.
    };

    let threw = false;
    try {
      await observeNotionMcpExecution(baseObservation(), deps);
    } catch {
      threw = true;
    }

    results.push(check(
      "[backward-compat] omitting recordIngestionFailure entirely does not throw and existing onFailure still fires",
      !threw && onFailureCalls === 1
    ));
  }

  // Telemetry failures never propagate into the observation pipeline.
  {
    let onFailureCalls = 0;
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => { throw new Error("boom"); },
      observeExecutionPermission: noopPermission(),
      observeExecutionWorkCorrelation: noopCorrelation(),
      onFailure: () => { onFailureCalls += 1; },
      recordIngestionFailure: async () => { throw new Error("telemetry store is down"); },
    };

    let threw = false;
    try {
      await observeNotionMcpExecution(baseObservation(), deps);
    } catch {
      threw = true;
    }

    results.push(check(
      "[isolation] a recordIngestionFailure() rejection is swallowed and never escapes observeNotionMcpExecution()",
      !threw && onFailureCalls === 1
    ));
  }

  return summarize("TACT Notion MCP — Ingestion Failure Telemetry Wiring", results);
}
