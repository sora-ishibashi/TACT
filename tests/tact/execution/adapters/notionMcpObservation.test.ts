import {
  executeWithNotionMcpObservation,
  observeNotionMcpExecution,
  type ObserveNotionMcpExecutionDeps,
} from "@tact/runs-core/tact-execution/adapters/notion/observeNotionMcpExecution";
import {
  normalizeNotionMcpInvocationToExecution,
  type NotionMcpInvocationObservation,
} from "@tact/runs-core/tact-execution/adapters/notion/normalizeNotionMcpExecution";
import type { CanonicalExecution, CaptureExecutionInput } from "@tact/runs-core/tact-execution/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function baseObservation(
  overrides: Partial<NotionMcpInvocationObservation> = {}
): NotionMcpInvocationObservation {
  return {
    userId: "user-1",
    actorKind: "ai_agent",
    principalId: "principal-1",
    agentId: "agent-1",
    connectionId: "connection-1",
    accountRef: "notion-account-1",
    invocationId: "mcp-invocation-1",
    externalRequestId: "request-1",
    mcpProvider: "anthropic",
    model: "claude-test",
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
    // 既定はpermissionStatus="unknown"(pendingではない)にする——SOR-51
    // wiring追加前から存在するTest12-14がobserveExecutionPermission()を
    // 誤って呼び出さないようにするため(下記の専用no-op stubと合わせて
    // 「呼ばれない」ことを検証する)。
    execution: { permissionStatus: "unknown", ...executionOverrides } as CanonicalExecution,
  };
}

function duplicateOutcome(executionOverrides: Partial<CanonicalExecution> = {}) {
  return {
    status: "duplicate" as const,
    execution: { permissionStatus: "unknown", ...executionOverrides } as CanonicalExecution,
  };
}

function noopObserveExecutionPermission(): ObserveNotionMcpExecutionDeps["observeExecutionPermission"] {
  return async () => ({ status: "persisted" as const, decision: {} as never, decisionId: "decision-stub" });
}

function noopObserveExecutionWorkCorrelation(): ObserveNotionMcpExecutionDeps["observeExecutionWorkCorrelation"] {
  return async () => ({ status: "persisted" as const, decision: {} as never });
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  // Tests 1-4: required Notion operations normalize to the pre-existing Canonical Execution vocabulary.
  {
    const cases: Array<[NotionMcpInvocationObservation["operation"], CaptureExecutionInput["actionCategory"], string]> = [
      ["READ", "read", "notion_read"],
      ["CREATE_PAGE", "create", "notion_create_page"],
      ["UPDATE_PAGE", "update", "notion_update_page"],
      ["DELETE_PAGE", "delete", "notion_delete_page"],
    ];

    for (const [operation, actionCategory, canonicalOperation] of cases) {
      const normalized = normalizeNotionMcpInvocationToExecution(baseObservation({ operation }));
      results.push(check(
        `[${operation}] Notion operation is normalized to Canonical Execution`,
        normalized.ok &&
          normalized.input.actionCategory === actionCategory &&
          normalized.input.operation === canonicalOperation &&
          normalized.input.provider === "mcp" &&
          normalized.input.targetProvider === "notion"
      ));
    }
  }

  // Test 5: tool errors become failed canonical executions without retaining the raw provider error.
  {
    const normalized = normalizeNotionMcpInvocationToExecution(baseObservation({
      status: "failed",
      errorCode: "notion_rate_limited",
    }));
    results.push(check(
      "[failed] tool error is a FAILED execution with only a safe generic message",
      normalized.ok &&
        normalized.input.status === "failed" &&
        normalized.input.errorCode === "notion_rate_limited" &&
        normalized.input.errorMessage === "Notion MCP tool execution failed"
    ));
  }

  // Tests 6-9: host-resolved identity and account scope pass through without inventing missing identities.
  {
    const normalized = normalizeNotionMcpInvocationToExecution(baseObservation());
    results.push(check(
      "[identity] agent and principal map to canonical agentId and actorId",
      normalized.ok && normalized.input.agentId === "agent-1" && normalized.input.actorId === "principal-1"
    ));
    results.push(check(
      "[identity] account/connection scope is retained in approved canonical fields",
      normalized.ok &&
        normalized.input.connectionId === "connection-1" &&
        (normalized.input.sourceMetadata as Record<string, unknown>).accountRef === "notion-account-1"
    ));
    results.push(check(
      "[metadata] only the allow-listed provider identity metadata enters the domain",
      normalized.ok &&
        JSON.stringify(Object.keys(normalized.input.sourceMetadata as Record<string, unknown>).sort()) ===
          JSON.stringify(["accountRef", "externalRequestId", "mcpProvider", "model", "toolName"])
    ));

    const unknownIdentity = normalizeNotionMcpInvocationToExecution(baseObservation({
      principalId: null,
      agentId: null,
      mcpProvider: null,
      model: null,
    }));
    results.push(check(
      "[identity] absent optional identities remain null/absent rather than guessed",
      unknownIdentity.ok &&
        unknownIdentity.input.actorId === null &&
        unknownIdentity.input.agentId === null &&
        !("mcpProvider" in (unknownIdentity.input.sourceMetadata as Record<string, unknown>))
    ));
  }

  // Tests 10-11: untrusted body, token, and arbitrary provider fields have no path into telemetry.
  {
    const unsafeAtRuntime = {
      ...baseObservation(),
      payload: { pageBody: "PRIVATE NOTION BODY" },
      token: "secret-token-value",
    } as NotionMcpInvocationObservation & Record<string, unknown>;
    const normalized = normalizeNotionMcpInvocationToExecution(unsafeAtRuntime);
    const serialized = normalized.ok ? JSON.stringify(normalized.input) : "";
    results.push(check(
      "[privacy] Notion payload body is not retained",
      !serialized.includes("PRIVATE NOTION BODY") && !serialized.includes("pageBody")
    ));
    results.push(check(
      "[privacy] token/secret fields are not retained",
      !serialized.includes("secret-token-value") && !serialized.includes("token")
    ));

    const unknownErrorCode = normalizeNotionMcpInvocationToExecution(baseObservation({
      status: "failed",
      errorCode: "secret-token-value" as never,
    }));
    results.push(check(
      "[privacy] an unrecognised provider error code falls back to the safe generic code",
      unknownErrorCode.ok && unknownErrorCode.input.errorCode === "notion_mcp_tool_failed"
    ));
  }

  // Tests 12-14: the hook preserves idempotency input and never converts an observation failure into a tool failure.
  {
    const captured: CaptureExecutionInput[] = [];
    const failures: string[] = [];
    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async (input) => {
        captured.push(input);
        return capturedOutcome();
      },
      observeExecutionPermission: noopObserveExecutionPermission(),
      observeExecutionWorkCorrelation: noopObserveExecutionWorkCorrelation(),
      onFailure: (stage) => failures.push(stage),
    };

    await observeNotionMcpExecution(baseObservation(), deps);
    await observeNotionMcpExecution(baseObservation(), deps);
    results.push(check(
      "[duplicate] duplicate invocation preserves the same capture idempotency key",
      captured.length === 2 &&
        captured[0]?.externalEventId === "mcp-invocation-1" &&
        captured[1]?.externalEventId === "mcp-invocation-1" &&
        failures.length === 0
    ));

    const captureFailureDeps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => { throw new Error("database unavailable"); },
      observeExecutionPermission: noopObserveExecutionPermission(),
      observeExecutionWorkCorrelation: noopObserveExecutionWorkCorrelation(),
      onFailure: (stage) => failures.push(stage),
    };
    let toolResult = "";
    await executeWithNotionMcpObservation(baseObservation(), async () => "tool-result", captureFailureDeps)
      .then((value) => { toolResult = value; });
    results.push(check(
      "[failure isolation] observation failure does not fail a successful Notion tool",
      toolResult === "tool-result" && failures.includes("capture")
    ));

    const failedCaptures: CaptureExecutionInput[] = [];
    let originalToolError: unknown;
    await executeWithNotionMcpObservation(
      baseObservation(),
      async () => { throw new Error("raw provider payload must not be stored"); },
      {
        captureExecution: async (input) => {
          failedCaptures.push(input);
          return capturedOutcome();
        },
        observeExecutionPermission: noopObserveExecutionPermission(),
      observeExecutionWorkCorrelation: noopObserveExecutionWorkCorrelation(),
        onFailure: () => undefined,
      }
    ).catch((error) => { originalToolError = error; });
    results.push(check(
      "[tool error] original tool error is preserved while one failed execution is observed",
      originalToolError instanceof Error &&
        failedCaptures.length === 1 &&
        failedCaptures[0]?.status === "failed" &&
        failedCaptures[0]?.errorMessage === "Notion MCP tool execution failed"
    ));
  }

  // SOR-51: capture成功直後にPermission Evaluationを呼ぶ配線
  // (core/tact-bot/adapters/slack/observeSlackExecution.tsと同じ
  // 「captureの直後、Work correlationは待たない」パターン)。
  {
    const permissionCalls: CanonicalExecution[] = [];

    const pendingDeps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome({ permissionStatus: "pending" }),
      observeExecutionPermission: async (execution) => {
        permissionCalls.push(execution);
        return { status: "persisted" as const, decision: {} as never, decisionId: "decision-stub" };
      },
      observeExecutionWorkCorrelation: noopObserveExecutionWorkCorrelation(),
      onFailure: () => undefined,
    };

    await observeNotionMcpExecution(baseObservation(), pendingDeps);
    results.push(check(
      "[SOR-51] a captured execution with permissionStatus=pending triggers Permission Evaluation",
      permissionCalls.length === 1
    ));

    const alreadyEvaluatedDeps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => duplicateOutcome({ permissionStatus: "allowed" }),
      observeExecutionPermission: async (execution) => {
        permissionCalls.push(execution);
        return { status: "persisted" as const, decision: {} as never, decisionId: "decision-stub" };
      },
      observeExecutionWorkCorrelation: noopObserveExecutionWorkCorrelation(),
      onFailure: () => undefined,
    };

    await observeNotionMcpExecution(baseObservation(), alreadyEvaluatedDeps);
    results.push(check(
      "[SOR-51/retry-safety] a duplicate capture that is already evaluated (permissionStatus != pending) does not re-trigger evaluation",
      permissionCalls.length === 1
    ));

    const permissionFailures: string[] = [];
    const permissionThrowDeps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome({ permissionStatus: "pending" }),
      observeExecutionPermission: async () => { throw new Error("permission store unavailable"); },
      observeExecutionWorkCorrelation: noopObserveExecutionWorkCorrelation(),
      onFailure: (stage) => permissionFailures.push(stage),
    };

    let observeThrew = false;
    try {
      await observeNotionMcpExecution(baseObservation(), permissionThrowDeps);
    } catch {
      observeThrew = true;
    }
    results.push(check(
      "[SOR-51/isolation] a Permission Evaluation failure is reported via onFailure and never thrown out of observation",
      !observeThrew && permissionFailures.length === 1 && permissionFailures[0] === "permission_evaluation"
    ));
  }

  // SOR-53 Path A: workId is threaded through to CaptureExecutionInput.workId
  // unvalidated (tenant/state validation is SOR-50's captureExecution()
  // responsibility, resolveTargetWorkForCorrelation()) — this adapter's own
  // job is only to not drop or invent the value.
  {
    const withWorkId = normalizeNotionMcpInvocationToExecution(baseObservation({ workId: "W-001" }));
    const withoutWorkId = normalizeNotionMcpInvocationToExecution(baseObservation({ workId: undefined }));
    const withNullWorkId = normalizeNotionMcpInvocationToExecution(baseObservation({ workId: null }));

    results.push(check(
      "[SOR-53 / Required tests 2-4] workId is threaded through unvalidated (a real invalid/cross-tenant/wrong-state workId is rejected downstream by " +
        "captureExecution()'s existing resolveTargetWorkForCorrelation(), which this adapter reuses rather than re-implementing); absent workId normalizes to null, never invented",
      withWorkId.ok && withWorkId.input.workId === "W-001" &&
        withoutWorkId.ok && withoutWorkId.input.workId === null &&
        withNullWorkId.ok && withNullWorkId.input.workId === null
    ));
  }

  // SOR-53: capture成功直後にWork Correlationを呼ぶ配線(Permissionとは
  // 独立、Attention同様onFailureで隔離される)。
  {
    const correlationCalls: CanonicalExecution[] = [];

    const deps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome(),
      observeExecutionPermission: noopObserveExecutionPermission(),
      observeExecutionWorkCorrelation: async (execution) => {
        correlationCalls.push(execution);
        return { status: "persisted" as const, decision: {} as never };
      },
      onFailure: () => undefined,
    };

    await observeNotionMcpExecution(baseObservation(), deps);
    results.push(check(
      "[SOR-53] every captured execution triggers Work Correlation (unlike Permission, there is no permissionStatus-style gate — " +
        "observeExecutionWorkCorrelation() itself owns the 'already matched' short-circuit)",
      correlationCalls.length === 1
    ));

    const duplicateDeps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => duplicateOutcome(),
      observeExecutionPermission: noopObserveExecutionPermission(),
      observeExecutionWorkCorrelation: async (execution) => {
        correlationCalls.push(execution);
        return { status: "already_matched" as const };
      },
      onFailure: () => undefined,
    };

    await observeNotionMcpExecution(baseObservation(), duplicateDeps);
    results.push(check(
      "[SOR-53] a duplicate capture still calls Work Correlation (its own already_matched guard handles the no-op safely)",
      correlationCalls.length === 2
    ));

    const correlationFailures: string[] = [];
    const correlationThrowDeps: ObserveNotionMcpExecutionDeps = {
      captureExecution: async () => capturedOutcome(),
      observeExecutionPermission: noopObserveExecutionPermission(),
      observeExecutionWorkCorrelation: async () => { throw new Error("correlation store unavailable"); },
      onFailure: (stage) => correlationFailures.push(stage),
    };

    let observeThrew = false;
    try {
      await observeNotionMcpExecution(baseObservation(), correlationThrowDeps);
    } catch {
      observeThrew = true;
    }
    results.push(check(
      "[SOR-53 / Required test 16] a Work Correlation failure is reported via onFailure(stage='work_correlation') and never thrown out of observation " +
        "(Permission/Attention pipeline from SOR-51/52 is unaffected)",
      !observeThrew && correlationFailures.length === 1 && correlationFailures[0] === "work_correlation"
    ));
  }

  return summarize("TACT Notion MCP Runs Observation", results);
}
