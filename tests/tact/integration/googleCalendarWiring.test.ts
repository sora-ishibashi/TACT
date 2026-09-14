// =========================
// TACT Integration — TIME-P1c Calendar Wiring Regression
// =========================
//
// 対象: "google_calendar"をcanonical IntegrationService/Policy/
// Provisioning/CapabilityBinding/Adapter dispatchへ配線した部分。
// 実Supabase・実Composio APIには一切接続しない(既存
// tests/tact/integration/execution.test.tsと同じDeps差し替え手法)。
//
// 最重要確認事項(TIME-P1c Calendar Wiringの絶対条件):
//   - google_calendar.availability_readはread専用policyとして
//     allowされ、write系operationは一切allowlistに存在しない
//   - Adapterはavailability_read以外のoperationを一切dispatchしない
//     (create/update/delete/move/invite/rsvp/generic executeは
//     構造的に到達不能)
//   - capability "calendar.availability.read"は
//     "integration.google_calendar.availability_read"というfixed
//     bindingにのみ対応する(LLM-selected operationではない)
//   - Connection ownershipは常にuserId-scopedで再検証され、他user
//     所有のConnectionでは実行(executeIntegrationAction呼び出し)に
//     一切到達しない

import {
  executeReadIntegrationAction,
  type ExecuteApprovedIntegrationActionDeps,
} from "../../../core/tact-integration/execution";
import {
  validateGoogleCalendarAvailabilityReadRequest,
  mapCalendarAvailabilityErrorToIntegrationError,
} from "../../../core/tact-integration/providers/composio/adapter";
import { lookupIntegrationActionPolicy, evaluatePolicyDecision } from "../../../core/tact-integration/policy";
import {
  createIntegrationConnectionLink,
  disconnectIntegrationConnection,
  type CreateIntegrationConnectionLinkDeps,
  type DisconnectIntegrationConnectionDeps,
} from "../../../core/tact-integration/provisioning";
import { isComposioServiceAuthConfigured } from "../../../core/tact-integration/providers/composio/connectionLink";
import {
  resolveCapabilityForBinding,
  isBindingCompatibleWithCapability,
  listKnownExecutionBindings,
} from "../../../core/tact-orchestrator/capabilityPlan";
import type { Work, Run, WorkTask } from "../../../core/tact-work/types";
import type { Connection, IntegrationExecutionResult, IntegrationService } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";
const OTHER_USER_ID = "user-2";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-cal-1",
    userId: OWNER_USER_ID,
    service: "google_calendar",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_calendar_123",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "test",
    status: "pending",
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: "work-1",
    taskId: "task-1",
    attempt: 1,
    capability: "integration.google_calendar.availability_read",
    provider: "composio",
    status: "running",
    startedAt: "2026-09-15T00:00:00.000Z",
    createdAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

// executeReadIntegrationAction()はApprovalを一切扱わないが、
// ExecuteApprovedIntegrationActionDepsは両境界共有の型のため、
// getApproval等write専用depsもダミーとして満たす必要がある
// (実際には呼ばれない)。
function makeDeps(overrides: Partial<ExecuteApprovedIntegrationActionDeps> = {}) {

  const calls = {
    getConnectionCalls: 0,
    executeIntegrationActionCalls: 0,
    executeIntegrationActionArgs: [] as { service: string; operation: string; input: Record<string, unknown>; providerConnectionRef: string }[],
    createRunCalls: 0,
    completeRunCalls: 0,
    failRunCalls: 0,
    updateTaskStatusCalls: [] as { taskId: string; status: string }[],
  };

  const deps: ExecuteApprovedIntegrationActionDeps = {

    getWork: async (workId, userId) => {
      if (userId !== OWNER_USER_ID) return undefined;
      return makeWork({ id: workId });
    },

    getApproval: async () => undefined,

    getConnection: async (connectionId, userId) => {
      calls.getConnectionCalls += 1;
      if (userId !== OWNER_USER_ID) return undefined;
      return makeConnection({ id: connectionId });
    },

    listTasksForWork: async () => [makeTask()],

    listRunsForTask: async () => [],

    createRun: async (workId, userId, accessToken, taskId, params) => {
      calls.createRunCalls += 1;
      return makeRun({ workId, taskId, attempt: params.attempt, capability: params.capability, provider: params.provider ?? null });
    },

    completeRun: async () => {
      calls.completeRunCalls += 1;
    },

    failRun: async () => {
      calls.failRunCalls += 1;
    },

    attachRunExternalRef: async () => {},

    updateTaskStatus: async (_workId, _userId, _accessToken, taskId, status) => {
      calls.updateTaskStatusCalls.push({ taskId, status });
    },

    executeIntegrationAction: async (request): Promise<IntegrationExecutionResult> => {
      calls.executeIntegrationActionCalls += 1;
      calls.executeIntegrationActionArgs.push({
        service: request.action.service,
        operation: request.action.operation,
        input: request.action.input,
        providerConnectionRef: request.providerConnectionRef,
      });
      return {
        status: "completed",
        providerExecutionRef: "log-cal-1",
        output: {
          rangeStartUtc: "2026-09-21T00:00:00.000Z",
          rangeEndUtc: "2026-09-22T00:00:00.000Z",
          timezone: "Asia/Tokyo",
          busyIntervals: [],
          sourceScope: "own_calendar",
        },
      };
    },

    reconcileWorkCompletionStatus: async () => ({ status: "no_change", reason: "tasks_not_all_terminal" }),

    emitAuditEvent: async () => {},

    ...overrides,

  };

  return { deps, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // 1. Policy allowlist
  // =========================

  {
    const policy = lookupIntegrationActionPolicy("google_calendar", "availability_read");
    results.push(check(
      "[1] google_calendar.availability_readはPOLICY_ALLOWLISTにriskClass=\"read\"で登録されている",
      policy?.riskClass === "read"
    ));
  }

  {
    const decision = evaluatePolicyDecision("google_calendar", "availability_read");
    results.push(check(
      "[2] evaluatePolicyDecision(\"google_calendar\",\"availability_read\") -> allow、Approval不要(requiresApprovalForRiskClass(\"read\")===false)",
      decision.decision === "allow" && decision.riskClass === "read"
    ));
  }

  for (const writeLikeOperation of ["create_event", "update_event", "delete_event", "move_event", "invite", "rsvp", "execute"]) {
    const policy = lookupIntegrationActionPolicy("google_calendar", writeLikeOperation);
    results.push(check(
      `[3] google_calendar.${writeLikeOperation}はallowlistに存在しない(undefined) — write系operationは一切registerされていない`,
      policy === undefined
    ));
  }

  {
    const decision = evaluatePolicyDecision("google_calendar", "create_event");
    results.push(check(
      "[4] 未登録operationはfail-closed(decision !== \"allow\")——安全側でapproval必須へfallbackしない",
      decision.decision !== "allow"
    ));
  }

  // =========================
  // 2. Adapter dispatch: input validation (pure function, no Composio client needed)
  // =========================

  {
    const validation = validateGoogleCalendarAvailabilityReadRequest({
      service: "google_calendar",
      operation: "availability_read",
      input: { rangeStartUtc: "2026-09-21T00:00:00.000Z", rangeEndUtc: "2026-09-22T00:00:00.000Z", timezone: "Asia/Tokyo" },
    });
    results.push(check(
      "[5] 正しい形のavailability_read inputはok:trueで3フィールドをそのまま返す",
      validation.ok === true &&
        validation.rangeStartUtc === "2026-09-21T00:00:00.000Z" &&
        validation.rangeEndUtc === "2026-09-22T00:00:00.000Z" &&
        validation.timezone === "Asia/Tokyo"
    ));
  }

  for (const badOperation of ["create_event", "delete_event", "execute", "list_events"]) {
    const validation = validateGoogleCalendarAvailabilityReadRequest({
      service: "google_calendar",
      operation: badOperation,
      input: { rangeStartUtc: "2026-09-21T00:00:00.000Z", rangeEndUtc: "2026-09-22T00:00:00.000Z", timezone: "Asia/Tokyo" },
    });
    results.push(check(
      `[6] operation="${badOperation}"はavailability_read以外として構造的に拒否される(ok:false) — hard read-only boundary`,
      validation.ok === false
    ));
  }

  for (const missingField of ["rangeStartUtc", "rangeEndUtc", "timezone"] as const) {
    const input: Record<string, unknown> = {
      rangeStartUtc: "2026-09-21T00:00:00.000Z",
      rangeEndUtc: "2026-09-22T00:00:00.000Z",
      timezone: "Asia/Tokyo",
    };
    delete input[missingField];
    const validation = validateGoogleCalendarAvailabilityReadRequest({ service: "google_calendar", operation: "availability_read", input });
    results.push(check(
      `[7] ${missingField}が欠けたinputはok:falseで拒否される(fail closed、部分的なrangeで実行しない)`,
      validation.ok === false
    ));
  }

  {
    // calendarId/items/slug等、mapToGoogleCalendarFindFreeSlotsInput()が
    // 受け付けないfieldを混ぜても無視される(そもそもこのvalidatorは
    // 宣言された3フィールド以外を一切読まない)ことの確認。
    const validation = validateGoogleCalendarAvailabilityReadRequest({
      service: "google_calendar",
      operation: "availability_read",
      input: {
        rangeStartUtc: "2026-09-21T00:00:00.000Z",
        rangeEndUtc: "2026-09-22T00:00:00.000Z",
        timezone: "Asia/Tokyo",
        calendarId: "attendee@example.com",
        toolSlug: "GOOGLECALENDAR_CREATE_EVENT",
      },
    });
    results.push(check(
      "[8] calendarId/toolSlug等の余分なfieldを含むinputでも、検証結果には3フィールドしか現れない(caller/LLMがカレンダー対象やtool slugを注入する経路が無い)",
      validation.ok === true &&
        !("calendarId" in validation) &&
        !("toolSlug" in validation)
    ));
  }

  // =========================
  // 3. Adapter: CalendarAvailabilityErrorCode -> IntegrationErrorCode
  // =========================

  {
    const mapped = mapCalendarAvailabilityErrorToIntegrationError({ code: "connection_missing", message: "m1" });
    results.push(check("[9] connection_missing -> connection_missing", mapped.code === "connection_missing" && mapped.retryable === false));
  }
  {
    const mapped = mapCalendarAvailabilityErrorToIntegrationError({ code: "permission_denied", message: "m2" });
    results.push(check("[10] permission_denied -> authorization_denied", mapped.code === "authorization_denied"));
  }
  {
    const mapped = mapCalendarAvailabilityErrorToIntegrationError({ code: "provider_failure", message: "m3" });
    results.push(check("[11] provider_failure -> provider_execution_failed", mapped.code === "provider_execution_failed"));
  }
  {
    const mapped = mapCalendarAvailabilityErrorToIntegrationError({ code: "malformed_response", message: "m4" });
    results.push(check(
      "[12] malformed_response -> malformed_response(provider_execution_failedへ握り潰さず区別を維持する)",
      mapped.code === "malformed_response"
    ));
  }

  // =========================
  // 4. Provisioning / connectionLink: google_calendar is a supported service
  // =========================

  {
    const linkDeps: CreateIntegrationConnectionLinkDeps = {
      providerKind: "composio",
      provider: {
        createConnectionLink: async () => ({ providerConnectionRef: "ca_new_1", redirectUrl: "https://example.test/oauth", canonicalStatus: "pending", providerStatusRaw: "INITIATED" }),
        getConnectionStatus: async () => null,
        disableConnection: async () => true,
      },
      createConnection: async (userId, _accessToken, params) => ({
        id: params.id ?? "conn-new-1",
        userId,
        service: params.service,
        status: params.status ?? "pending",
        provider: "composio",
        providerConnectionRef: params.providerConnectionRef,
        metadata: params.metadata ?? null,
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      }),
      generateConnectionId: () => "generated-id",
    };

    const outcome = await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: "token", service: "google_calendar" },
      linkDeps
    );

    results.push(check(
      "[13] createIntegrationConnectionLink({service:\"google_calendar\"})はunsupported_serviceではなく実際にlinkを作成する",
      outcome.status === "created" && outcome.connection.service === "google_calendar"
    ));
  }

  {
    const outcome = await createIntegrationConnectionLink(
      { userId: OWNER_USER_ID, accessToken: "token", service: "not_a_real_service" },
      {
        providerKind: "composio",
        provider: { createConnectionLink: async () => null, getConnectionStatus: async () => null, disableConnection: async () => true },
        createConnection: async () => { throw new Error("must not be called for an unsupported service"); },
        generateConnectionId: () => "unused",
      }
    );
    results.push(check(
      "[14] 依然として未知serviceはunsupported_serviceのまま(google_calendar追加が他serviceのfail-closedを緩めていない)",
      outcome.status === "unsupported_service"
    ));
  }

  {
    const disconnectDeps: DisconnectIntegrationConnectionDeps = {
      provider: { createConnectionLink: async () => null, getConnectionStatus: async () => null, disableConnection: async () => true },
      listConnectionsForUser: async (userId, _accessToken, service, status) =>
        userId === OWNER_USER_ID && service === "google_calendar" && status === "active"
          ? [makeConnection()]
          : [],
      updateConnectionStatus: async () => {},
    };

    const outcome = await disconnectIntegrationConnection(
      { userId: OWNER_USER_ID, accessToken: "token", service: "google_calendar" },
      disconnectDeps
    );

    results.push(check(
      "[15] disconnectIntegrationConnection({service:\"google_calendar\"})もunsupported_serviceではない(切断経路も汎用catalogへ乗っている)",
      outcome.status === "disconnected" && outcome.revokedConnectionIds.length === 1
    ));
  }

  {
    // isComposioServiceAuthConfigured("google_calendar")はCOMPOSIO_
    // GOOGLECALENDAR_AUTH_CONFIG_IDを見る(getComposioAuthConfigId()の
    // exhaustive switchにgoogle_calendarのcaseが追加されている)。
    const original = process.env.COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID;
    try {
      delete process.env.COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID;
      const unconfigured = isComposioServiceAuthConfigured("google_calendar" as IntegrationService);
      process.env.COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID = "auth-config-test-value";
      const configured = isComposioServiceAuthConfigured("google_calendar" as IntegrationService);
      results.push(check(
        "[16] isComposioServiceAuthConfigured(\"google_calendar\")はCOMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_IDの有無を正しく反映する",
        unconfigured === false && configured === true
      ));
    } finally {
      if (original === undefined) {
        delete process.env.COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID;
      } else {
        process.env.COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID = original;
      }
    }
  }

  // =========================
  // 5. Capability binding wiring
  // =========================

  {
    results.push(check(
      "[17] resolveCapabilityForBinding(\"integration.google_calendar.availability_read\") === \"calendar.availability.read\"",
      resolveCapabilityForBinding("integration.google_calendar.availability_read") === "calendar.availability.read"
    ));
  }

  {
    results.push(check(
      "[18] isBindingCompatibleWithCapability(\"calendar.availability.read\", 正しいbinding) === true",
      isBindingCompatibleWithCapability("calendar.availability.read", "integration.google_calendar.availability_read") === true
    ));
  }

  {
    results.push(check(
      "[19] isBindingCompatibleWithCapability(\"communication.write\", google_calendarのbinding) === false(capability/binding不一致はinvalid)",
      isBindingCompatibleWithCapability("communication.write", "integration.google_calendar.availability_read") === false
    ));
  }

  {
    results.push(check(
      "[20] 未知のbinding文字列はresolveCapabilityForBinding()でundefined(fail closed、LLMが任意のbinding名を作れない)",
      resolveCapabilityForBinding("integration.google_calendar.create_event") === undefined
    ));
  }

  {
    results.push(check(
      "[21] listKnownExecutionBindings()にintegration.google_calendar.availability_readが含まれる",
      listKnownExecutionBindings().includes("integration.google_calendar.availability_read")
    ));
  }

  // =========================
  // 6. Canonical Reality Test: the REAL executeReadIntegrationAction()
  // boundary, mocked only at the Store/Gateway DI seam (no live Supabase,
  // no live Composio) — proves Policy + Connection ownership + Run
  // lifecycle actually work end-to-end for google_calendar/availability_read.
  // =========================

  {
    const { deps, calls } = makeDeps();

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-cal-1",
        action: {
          service: "google_calendar",
          operation: "availability_read",
          input: { rangeStartUtc: "2026-09-21T00:00:00.000Z", rangeEndUtc: "2026-09-22T00:00:00.000Z", timezone: "Asia/Tokyo" },
        },
      },
      deps
    );

    results.push(check(
      "[22 Reality Test] 正しく所有・activeなgoogle_calendar Connectionでの読み取りはcompletedになり、Gateway(executeIntegrationAction)が正確に1回、正しいservice/operation/inputで呼ばれる",
      outcome.status === "completed" &&
        calls.executeIntegrationActionCalls === 1 &&
        calls.executeIntegrationActionArgs[0].service === "google_calendar" &&
        calls.executeIntegrationActionArgs[0].operation === "availability_read" &&
        calls.executeIntegrationActionArgs[0].providerConnectionRef === "ca_calendar_123"
    ));
  }

  {
    // 他user所有のConnection(getConnectionが所有者以外にはundefinedを
    // 返す、既存の一貫したConnection storeの契約)——実行境界自身が
    // 再検証し、Gateway呼び出しに一切到達しない。
    const { deps, calls } = makeDeps({
      getConnection: async (connectionId, userId) => {
        calls.getConnectionCalls += 1;
        if (userId !== OTHER_USER_ID) return undefined; // このConnectionはOTHER_USER_ID所有
        return makeConnection({ id: connectionId, userId: OTHER_USER_ID });
      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-belongs-to-other-user",
        action: {
          service: "google_calendar",
          operation: "availability_read",
          input: { rangeStartUtc: "2026-09-21T00:00:00.000Z", rangeEndUtc: "2026-09-22T00:00:00.000Z", timezone: "Asia/Tokyo" },
        },
      },
      deps
    );

    results.push(check(
      "[23 Reality Test] 他user所有のconnectionIdを渡しても、connection_unavailableでfail closed、Gateway(executeIntegrationAction)は0回",
      outcome.status === "connection_unavailable" && calls.executeIntegrationActionCalls === 0
    ));
  }

  {
    // Workがrunning以外(例: completed)の場合、Connectionが正しくても
    // Gatewayへは到達しない(既存read boundary共通ガード、google_calendar
    // でも同様に効くことの確認)。
    const { deps, calls } = makeDeps({
      getWork: async (workId, userId) => {
        if (userId !== OWNER_USER_ID) return undefined;
        return makeWork({ id: workId, status: "completed" });
      },
    });

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-cal-1",
        action: {
          service: "google_calendar",
          operation: "availability_read",
          input: { rangeStartUtc: "2026-09-21T00:00:00.000Z", rangeEndUtc: "2026-09-22T00:00:00.000Z", timezone: "Asia/Tokyo" },
        },
      },
      deps
    );

    results.push(check(
      "[24 Reality Test] Workがrunning以外ならwork_not_runnableでfail closed、Gatewayは0回",
      outcome.status === "work_not_runnable" && calls.executeIntegrationActionCalls === 0
    ));
  }

  {
    // 未登録operation(例: 誤って"create_event"を渡した場合)は
    // Policy再評価の時点でinvalid_actionへfail closedし、Gatewayに
    // 到達しない——「Approvalが無いから止まる」のではなく
    // 「policyそのものに存在しない」ことを確認する。
    const { deps, calls } = makeDeps();

    const outcome = await executeReadIntegrationAction(
      {
        workId: "work-1",
        userId: OWNER_USER_ID,
        accessToken: "token",
        taskId: "task-1",
        connectionId: "conn-cal-1",
        action: { service: "google_calendar", operation: "create_event", input: {} },
      },
      deps
    );

    results.push(check(
      "[25 Reality Test] service=\"google_calendar\", operation=\"create_event\"(write系)はPolicy未登録のためinvalid_actionでfail closed、Gatewayは0回",
      outcome.status === "invalid_action" && calls.executeIntegrationActionCalls === 0
    ));
  }

  for (const wrongService of ["gmail", "slack", "notion"] as const) {
    const { deps, calls } = makeDeps({
      getConnection: async (connectionId, userId) => {
        calls.getConnectionCalls += 1;
        return userId === OWNER_USER_ID
          ? makeConnection({ id: connectionId, service: wrongService, providerConnectionRef: `injected-${wrongService}-ref` })
          : undefined;
      },
    });
    const outcome = await executeReadIntegrationAction({
      workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-cal-1",
      action: { service: "google_calendar", operation: "availability_read", input: {} },
    }, deps);
    results.push(check(
      `[service match hardening] ${wrongService} connection cannot execute google_calendar or inject its provider ref`,
      outcome.status === "connection_unavailable" && calls.executeIntegrationActionCalls === 0 && calls.createRunCalls === 0
    ));
  }

  {
    const { deps, calls } = makeDeps({
      getConnection: async (connectionId, userId) => userId === OWNER_USER_ID
        ? makeConnection({ id: connectionId, status: "revoked", providerConnectionRef: "injected-revoked-ref" })
        : undefined,
    });
    const outcome = await executeReadIntegrationAction({
      workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-cal-1",
      action: { service: "google_calendar", operation: "availability_read", input: {} },
    }, deps);
    results.push(check(
      "[service match hardening] an inactive google_calendar connection cannot execute or inject its provider ref",
      outcome.status === "connection_unavailable" && calls.executeIntegrationActionCalls === 0 && calls.createRunCalls === 0
    ));
  }

  for (const action of [
    { service: "slack", operation: "list_channels", input: {} },
    { service: "gmail", operation: "search_messages", input: { query: "status" } },
    { service: "notion", operation: "search", input: { query: "plan" } },
    { service: "google_calendar", operation: "availability_read", input: {} },
  ] as const) {
    const { deps, calls } = makeDeps({
      getConnection: async (connectionId, userId) => userId === OWNER_USER_ID
        ? makeConnection({ id: connectionId, service: action.service, providerConnectionRef: `canonical-${action.service}-ref` })
        : undefined,
    });
    const outcome = await executeReadIntegrationAction({
      workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-matching-service",
      action,
    }, deps);
    results.push(check(
      `[service match regression] matching active ${action.service} connection continues to execute with its canonical provider ref`,
      outcome.status === "completed" && calls.executeIntegrationActionCalls === 1 &&
        calls.executeIntegrationActionArgs[0].providerConnectionRef === `canonical-${action.service}-ref`
    ));
  }

  {
    const { deps, calls } = makeDeps();
    const outcome = await executeReadIntegrationAction({
      workId: "work-1", userId: OWNER_USER_ID, accessToken: "token", taskId: "task-1", connectionId: "conn-cal-1",
      action: {
        service: "google_calendar",
        operation: "availability_read",
        input: { providerConnectionRef: "caller-controlled-ref" },
      },
    }, deps);
    results.push(check(
      "[provider ref hardening] a caller-supplied provider ref is ignored in favor of the canonical matching connection row",
      outcome.status === "completed" && calls.executeIntegrationActionArgs[0].providerConnectionRef === "ca_calendar_123"
    ));
  }

  return summarize("integration/googleCalendarWiring", results);

}
