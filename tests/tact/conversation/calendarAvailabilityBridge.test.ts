// =========================
// runCalendarAvailabilityBridge Regression
// (TIME-P1c Final Wiring / Final Blocker Fix)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのrunCalendarAvailabilityBridge()、
// および独立auditが指摘したWork lifecycle blocker修正の核心である
// core/tact-work/execution.tsのprepareDirectReadTaskExecution()
// (REAL関数、mockではない)。
//
// 2階層のtest戦略:
//   1. "Shallow" tests — bridge自身の責務(prepareDirectReadTaskExecution()
//      呼び出し・executeCalendarAvailabilityScheduling()呼び出し・結果
//      messageへのmapping)だけを、両方とも薄いfakeに差し替えて検証する
//      (executeCalendarAvailabilityScheduling()自体の内部ロジックは
//      tests/tact/conversation/calendarAvailabilityExecution.test.tsが、
//      Run/Connection lifecycleの深い部分はtests/tact/integration/
//      googleCalendarWiring.test.tsが、それぞれ既に検証済みのため
//      再検証しない)。
//   2. "Full chain" tests(独立audit Section13の明示的要求: "prove the
//      REAL lifecycle, not just a mocked bridge") — prepareDirectReadTaskExecution()
//      とexecuteCalendarAvailabilityScheduling()の両方を実関数のまま
//      使い、最下層(Supabase相当のgetWork/updateWorkStatus/createTask/
//      listClarificationsForWork/listConnectionsForUser/
//      executeReadIntegrationAction/updateWorkCandidateSnapshotMetadata)
//      だけをin-memory fakeに差し替える。Work.status
//      (created/waiting_for_input → running)が実際に遷移すること、
//      その遷移がRun/Provider呼び出しより必ず先に起こることを、mockの
//      戻り値ではなく共有state(sharedWork)への実際の書き込みとして
//      観測する。

import { runCalendarAvailabilityBridge } from "../../../core/tact-conversation/orchestration";
import type { CalendarAvailabilityBridgeDeps } from "../../../core/tact-conversation/orchestration";
import {
  prepareDirectReadTaskExecution,
  type PrepareDirectReadTaskExecutionDeps,
  type PrepareDirectReadTaskExecutionResult,
} from "../../../core/tact-work/execution";
import type { Work, WorkTask, Clarification } from "../../../core/tact-work/types";
import {
  extractTemporalRequirement,
  deriveTemporalRequirementPolicy,
  toTemporalRequirementMetadata,
} from "../../../core/tact-work/temporalRequirements";
import {
  executeCalendarAvailabilityScheduling,
  type ExecuteCalendarAvailabilitySchedulingDeps,
  type ExecuteCalendarAvailabilitySchedulingParams,
  type ExecuteCalendarAvailabilitySchedulingResult,
  type CalendarSchedulingErrorCode,
} from "../../../core/tact-conversation/calendarAvailabilityExecution";
import type { CandidateSlotSnapshotMetadata } from "../../../core/tact-work/candidateSchedule";
import type { Connection } from "../../../core/tact-integration/types";
import type { IntegrationActionExecutionOutcome } from "../../../core/tact-integration/execution";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    status: "pending",
    description: "Googleカレンダーの空き時間を確認する",
    assignedCapability: "integration.google_calendar.availability_read",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeClarification(overrides: Partial<Clarification> = {}): Clarification {
  return {
    id: "clarification-1",
    workId: "work-1",
    requestedByActorKind: "ai",
    requestedByActorId: "temporal-understanding",
    status: "pending",
    reasonCode: "missing_required_input",
    question: "テスト質問",
    requestedAt: "2026-09-16T00:00:00.000Z",
    createdAt: "2026-09-16T00:00:00.000Z",
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
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

// =========================
// Shallow deps: bridge自身の責務だけを検証する(prepare/scheduling両方
// を薄いfakeへ差し替える)。
// =========================

interface ShallowRecorder {
  prepareCalls: number;
  schedulingCalls: ExecuteCalendarAvailabilitySchedulingParams[];
}

function buildShallowDeps(
  schedulingResult: ExecuteCalendarAvailabilitySchedulingResult,
  options: { prepareFails?: boolean } = {}
): { deps: CalendarAvailabilityBridgeDeps; recorder: ShallowRecorder } {

  const recorder: ShallowRecorder = { prepareCalls: 0, schedulingCalls: [] };

  const deps: CalendarAvailabilityBridgeDeps = {

    prepareDirectReadTaskExecution: (async (): Promise<PrepareDirectReadTaskExecutionResult> => {
      recorder.prepareCalls += 1;
      return options.prepareFails
        ? { success: false, error: { code: "task_creation_failed", message: "n/a" } }
        : { success: true, task: makeTask() };
    }) as typeof prepareDirectReadTaskExecution,

    executeCalendarAvailabilityScheduling: (async (params: ExecuteCalendarAvailabilitySchedulingParams) => {
      recorder.schedulingCalls.push(params);
      return schedulingResult;
    }) as typeof executeCalendarAvailabilityScheduling,

  };

  return { deps, recorder };

}

// =========================
// Full-chain deps: prepareDirectReadTaskExecution()と
// executeCalendarAvailabilityScheduling()の両方をREAL関数のまま使い、
// 最下層(Supabase相当)だけをin-memory fakeへ差し替える。sharedWorkは
// 両方のfake群から参照される、可変な単一の「DB行」。
// =========================

interface FullChainOptions {
  connections?: Connection[];
  executeReadIntegrationActionImpl?: ExecuteCalendarAvailabilitySchedulingDeps["executeReadIntegrationAction"];
  clarifications?: Clarification[];
}

interface FullChainRecorder {
  workStatusUpdates: string[];
  createTaskCalls: number;
  executeReadIntegrationActionCalls: number;
}

function buildFullChainDeps(
  sharedWork: Work,
  options: FullChainOptions = {}
): { deps: CalendarAvailabilityBridgeDeps; recorder: FullChainRecorder } {

  const recorder: FullChainRecorder = { workStatusUpdates: [], createTaskCalls: 0, executeReadIntegrationActionCalls: 0 };
  const connections = options.connections ?? [makeConnection()];

  const lowLevelPrepareDeps: PrepareDirectReadTaskExecutionDeps = {
    getWork: (async () => ({ ...sharedWork })) as PrepareDirectReadTaskExecutionDeps["getWork"],
    updateWorkStatus: (async (_workId: string, _userId: string, _accessToken: string, status: string) => {
      recorder.workStatusUpdates.push(status);
      sharedWork.status = status as Work["status"];
    }) as PrepareDirectReadTaskExecutionDeps["updateWorkStatus"],
    createTask: (async (workId: string, _userId: string, _accessToken: string, params) => {
      recorder.createTaskCalls += 1;
      return makeTask({ workId, description: params.description, assignedCapability: params.assignedCapability });
    }) as PrepareDirectReadTaskExecutionDeps["createTask"],
    listClarificationsForWork: (async () => options.clarifications ?? []) as PrepareDirectReadTaskExecutionDeps["listClarificationsForWork"],
  };

  const defaultExecuteReadIntegrationActionImpl: ExecuteCalendarAvailabilitySchedulingDeps["executeReadIntegrationAction"] =
    async (params): Promise<IntegrationActionExecutionOutcome> => {

      const input = params.action.input as { rangeStartUtc: string; rangeEndUtc: string; timezone: string };

      return {
        status: "completed",
        run: {
          id: "run-1",
          workId: sharedWork.id,
          taskId: params.taskId,
          attempt: 1,
          capability: "integration.google_calendar.availability_read",
          provider: "composio",
          status: "completed",
          startedAt: "2026-09-16T00:00:00.000Z",
          createdAt: "2026-09-16T00:00:00.000Z",
          result: {
            success: true,
            output: JSON.stringify({
              rangeStartUtc: input.rangeStartUtc,
              rangeEndUtc: input.rangeEndUtc,
              timezone: input.timezone,
              busyIntervals: [],
              sourceScope: "own_calendar",
            }),
          },
        },
      };

    };

  const lowLevelSchedulingDeps: ExecuteCalendarAvailabilitySchedulingDeps = {

    getWork: (async (workId: string, userId: string) =>
      sharedWork.userId === userId ? { ...sharedWork, id: workId } : undefined) as ExecuteCalendarAvailabilitySchedulingDeps["getWork"],

    listConnectionsForUser: (async (userId: string) =>
      userId === sharedWork.userId ? connections : []) as ExecuteCalendarAvailabilitySchedulingDeps["listConnectionsForUser"],

    executeReadIntegrationAction: (async (params, execDeps) => {
      recorder.executeReadIntegrationActionCalls += 1;
      return (options.executeReadIntegrationActionImpl ?? defaultExecuteReadIntegrationActionImpl)(params, execDeps);
    }) as ExecuteCalendarAvailabilitySchedulingDeps["executeReadIntegrationAction"],

    updateWorkCandidateSnapshotMetadata: (async () => true) as ExecuteCalendarAvailabilitySchedulingDeps["updateWorkCandidateSnapshotMetadata"],

  };

  const deps: CalendarAvailabilityBridgeDeps = {

    prepareDirectReadTaskExecution: ((params) =>
      prepareDirectReadTaskExecution(params, lowLevelPrepareDeps)) as typeof prepareDirectReadTaskExecution,

    executeCalendarAvailabilityScheduling: ((params) =>
      executeCalendarAvailabilityScheduling(params, lowLevelSchedulingDeps)) as typeof executeCalendarAvailabilityScheduling,

  };

  return { deps, recorder };

}

const EXACT_PRODUCTION_REQUEST =
  "2026年9月17日、Asia/Tokyoで、10:00〜18:00の間から30分空いている時間を3つ探して。Google Calendarの予定を確認して。";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Section13-A/F: fresh request — Work created -> running -> Task
  // persisted -> Run created -> Run completed -> result returned. Uses
  // the exact production request's own extracted requirement, so this is
  // simultaneously the Section6/13-F "real canonical execution path"
  // regression. ----
  {
    const requirement = extractTemporalRequirement(EXACT_PRODUCTION_REQUEST);
    const policy = deriveTemporalRequirementPolicy(EXACT_PRODUCTION_REQUEST);

    const sharedWork = makeWork({
      status: "created",
      metadata: { temporalRequirement: toTemporalRequirementMetadata(requirement, policy) },
    });

    const { deps, recorder } = buildFullChainDeps(sharedWork);

    const answer = await runCalendarAvailabilityBridge(sharedWork.id, sharedWork.userId, "token-1", deps);

    results.push(check(
      "[Section13-A] a fresh (\"created\") Work is transitioned to \"running\" BEFORE the Task is created and the scheduler dispatches",
      recorder.workStatusUpdates.join(",") === "running" && sharedWork.status === "running"
    ));

    results.push(check(
      "[Section13-A] exactly one ad-hoc Task is persisted and exactly one canonical Run is dispatched (executeReadIntegrationAction)",
      recorder.createTaskCalls === 1 && recorder.executeReadIntegrationActionCalls === 1
    ));

    results.push(check(
      "[Section13-F] the exact production request reaches the real canonical execution path end-to-end and returns a formatted result (never generic chat)",
      answer.includes("Google Calendarを確認しました") && answer.includes("空いている候補")
    ));
  }

  // ---- Section13-B: fresh provider failure — distinct, safe message;
  // never silently treated as success ----
  {
    const requirement = extractTemporalRequirement(EXACT_PRODUCTION_REQUEST);
    const policy = deriveTemporalRequirementPolicy(EXACT_PRODUCTION_REQUEST);

    const sharedWork = makeWork({
      status: "created",
      metadata: { temporalRequirement: toTemporalRequirementMetadata(requirement, policy) },
    });

    const { deps, recorder } = buildFullChainDeps(sharedWork, {
      executeReadIntegrationActionImpl: async () => ({ status: "failed", run: { id: "run-1", workId: sharedWork.id, taskId: "task-1", attempt: 1, capability: "integration.google_calendar.availability_read", status: "failed", startedAt: "2026-09-16T00:00:00.000Z", createdAt: "2026-09-16T00:00:00.000Z", error: "provider error" } }),
    });

    const answer = await runCalendarAvailabilityBridge(sharedWork.id, sharedWork.userId, "token-1", deps);

    results.push(check(
      "[Section13-B] a Run failure still transitions Work to running first, dispatches exactly once, and returns a curated failure message (never a fabricated success)",
      recorder.workStatusUpdates.join(",") === "running" &&
        recorder.executeReadIntegrationActionCalls === 1 &&
        !answer.includes("Google Calendarを確認しました") &&
        answer.length > 0
    ));
  }

  // ---- Section13-C / Section7: clarification resume — waiting_for_input
  // with no remaining pending Clarification transitions to running, THEN
  // dispatches. ----
  {
    const requirement = extractTemporalRequirement("明日30分空いてるところ探して Asia/Tokyo 10:00〜18:00");
    const policy = deriveTemporalRequirementPolicy("明日30分空いてるところ探して");

    const sharedWork = makeWork({
      status: "waiting_for_input",
      metadata: { temporalRequirement: toTemporalRequirementMetadata(requirement, policy) },
    });

    const { deps, recorder } = buildFullChainDeps(sharedWork, {
      clarifications: [makeClarification({ status: "answered" })],
    });

    const answer = await runCalendarAvailabilityBridge(sharedWork.id, sharedWork.userId, "token-1", deps);

    results.push(check(
      "[Section13-C] a resumed (\"waiting_for_input\", nothing else pending) Work transitions to running and then reaches the scheduler",
      recorder.workStatusUpdates.join(",") === "running" &&
        recorder.executeReadIntegrationActionCalls === 1 &&
        answer.includes("Google Calendarを確認しました")
    ));
  }

  // ---- Section7 (required regression): the resumed flow must NOT call
  // the scheduler while Work is still waiting_for_input (another
  // Clarification is still pending). ----
  {
    const sharedWork = makeWork({ status: "waiting_for_input" });

    const { deps, recorder } = buildFullChainDeps(sharedWork, {
      clarifications: [makeClarification({ id: "still-pending", status: "pending" })],
    });

    const answer = await runCalendarAvailabilityBridge(sharedWork.id, sharedWork.userId, "token-1", deps);

    results.push(check(
      "[Section7] Work still \"waiting_for_input\" (another Clarification unanswered) never transitions to running and NEVER dispatches to the scheduler",
      recorder.workStatusUpdates.length === 0 &&
        recorder.executeReadIntegrationActionCalls === 0 &&
        sharedWork.status === "waiting_for_input" &&
        typeof answer === "string" && answer.length > 0
    ));
  }

  // ---- Section11/13-H: an invalid (but IANA-shaped) timezone never
  // reaches the provider — fails closed with a distinct, safe message. ----
  {
    const requirement = extractTemporalRequirement("2026年9月17日、10:00〜18:00の間から30分空いている時間を3つ探して。");
    const policy = deriveTemporalRequirementPolicy("空いている時間を探して");

    const sharedWork = makeWork({
      status: "created",
      metadata: {
        temporalRequirement: toTemporalRequirementMetadata(
          { ...requirement, timezone: "Asia/NotARealZone" },
          policy
        ),
      },
    });

    const { deps, recorder } = buildFullChainDeps(sharedWork);

    const answer = await runCalendarAvailabilityBridge(sharedWork.id, sharedWork.userId, "token-1", deps);

    results.push(check(
      "[Section11/13-H] an invalid IANA-shaped timezone (\"Asia/NotARealZone\") never reaches the provider (executeReadIntegrationAction is never called)",
      recorder.executeReadIntegrationActionCalls === 0
    ));

    results.push(check(
      "[Section11/13-H] the failure is surfaced as a curated, distinct message (timezone-related), never a generic/fabricated success",
      answer.includes("タイムゾーン") && !answer.includes("Google Calendarを確認しました")
    ));
  }

  // ---- Shallow: successful mocked result is formatted per the documented
  // template (candidate formatting itself, independent of lifecycle) ----
  {
    const { deps, recorder } = buildShallowDeps({
      success: true,
      candidates: [
        { index: 1, startUtc: "2026-09-17T01:30:00.000Z", endUtc: "2026-09-17T02:00:00.000Z", timezone: "Asia/Tokyo" },
        { index: 2, startUtc: "2026-09-17T04:00:00.000Z", endUtc: "2026-09-17T04:30:00.000Z", timezone: "Asia/Tokyo" },
        { index: 3, startUtc: "2026-09-17T07:15:00.000Z", endUtc: "2026-09-17T07:45:00.000Z", timezone: "Asia/Tokyo" },
      ],
      snapshot: {} as CandidateSlotSnapshotMetadata,
    });

    const answer = await runCalendarAvailabilityBridge("work-1", "user-1", "token-1", deps);

    results.push(check(
      "[format] a successful scheduling result is formatted with the documented Japanese template and local (Asia/Tokyo) clock times",
      answer.includes("Google Calendarを確認しました") &&
        answer.includes("空いている候補は次の3つです") &&
        answer.includes("1. 10:30〜11:00") &&
        answer.includes("2. 13:00〜13:30") &&
        answer.includes("3. 16:15〜16:45")
    ));

    results.push(check(
      "[format] never claims attendee availability (\"参加者全員が空いています\" must not appear)",
      !answer.includes("参加者")
    ));

    results.push(check(
      "[wiring] executeCalendarAvailabilityScheduling() is invoked exactly once with an explicit referenceInstantUtc",
      recorder.prepareCalls === 1 &&
        recorder.schedulingCalls.length === 1 &&
        typeof recorder.schedulingCalls[0].referenceInstantUtc === "string" &&
        !Number.isNaN(Date.parse(recorder.schedulingCalls[0].referenceInstantUtc))
    ));
  }

  // ---- Shallow: distinct CalendarSchedulingErrorCode values map to
  // distinct, curated Japanese messages (Section15) ----
  {
    const codes: { code: CalendarSchedulingErrorCode; mustInclude: string }[] = [
      { code: "calendar_not_connected", mustInclude: "接続されていません" },
      { code: "calendar_connection_ambiguous", mustInclude: "複数" },
      { code: "calendar_permission_denied", mustInclude: "権限" },
      { code: "timezone_required", mustInclude: "タイムゾーン" },
      { code: "daily_window_missing", mustInclude: "時間帯" },
      { code: "no_available_slots", mustInclude: "見つかりませんでした" },
    ];

    let allDistinctAndSafe = true;
    const seenMessages = new Set<string>();

    for (const { code, mustInclude } of codes) {
      const { deps } = buildShallowDeps({ success: false, error: { code, message: "internal detail that must not leak" } });
      const answer = await runCalendarAvailabilityBridge("work-1", "user-1", "token-1", deps);
      if (!answer.includes(mustInclude) || answer.includes("internal detail") || seenMessages.has(answer)) {
        allDistinctAndSafe = false;
      }
      seenMessages.add(answer);
    }

    results.push(check(
      "[Section15] distinct CalendarSchedulingErrorCode values map to distinct, curated, safe Japanese messages (never the raw internal message, never collapsed into one generic string)",
      allDistinctAndSafe
    ));
  }

  // ---- Shallow: prepareDirectReadTaskExecution() failing (Work vanished,
  // or not resumable) never crashes and never calls the scheduler ----
  {
    const { deps, recorder } = buildShallowDeps(
      { success: true, candidates: [], snapshot: {} as CandidateSlotSnapshotMetadata },
      { prepareFails: true }
    );

    const answer = await runCalendarAvailabilityBridge("work-1", "user-1", "token-1", deps);

    results.push(check(
      "[defensive] prepareDirectReadTaskExecution() failing yields a safe message and never calls executeCalendarAvailabilityScheduling()",
      typeof answer === "string" && answer.length > 0 && recorder.schedulingCalls.length === 0
    ));
  }

  // ---- Section5/13-D: no duplicate Task terminal-state write — the
  // bridge itself must never call updateTaskStatus() (Run/Task terminal
  // state is owned exclusively by executeReadIntegrationAction(), inside
  // executeCalendarAvailabilityScheduling()). Structural source check,
  // matching the existing precedent in tests/tact/work/temporalRequirements.test.ts. ----
  {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-conversation", "orchestration.ts"),
      "utf8"
    );

    const bridgeStart = source.indexOf("export async function runCalendarAvailabilityBridge");
    const bridgeEnd = source.indexOf("\nfunction makeCalendarAvailabilityBridgeResult", bridgeStart);
    const bridgeBody = source.slice(bridgeStart, bridgeEnd);

    results.push(check(
      "[Section5/13-D] runCalendarAvailabilityBridge() never calls updateTaskStatus() itself — Task terminal state has exactly one owner",
      bridgeStart !== -1 && bridgeEnd !== -1 && !bridgeBody.includes("updateTaskStatus(")
    ));
  }

  return summarize("conversation/calendarAvailabilityBridge", results);

}
