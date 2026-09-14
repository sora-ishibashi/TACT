// =========================
// TACT Conversation — TIME-P1c Calendar Wiring: bridge function regression
// (core/tact-conversation/calendarAvailabilityExecution.ts)
// =========================
//
// 対象: executeCalendarAvailabilityScheduling() — Work.metadataの
// TemporalRequirement + 実canonical Execution Boundary
// (executeReadIntegrationAction()) + Slot Engine/Snapshotを結びつける
// composition-root bridge。実Supabase・実Composio APIには一切接続
// しない(すべてDI fake)。
//
// 必須シナリオ(TIME-P1c Calendar Wiring Section20):
//   - 成功パス(mocked provider経由でcandidatesとsnapshotが得られる)
//   - 同じWorkでもConnectionが無い場合 -> calendar_not_connected
//   - 存在するConnectionが別userのものである場合 -> provider(=
//     executeReadIntegrationAction)呼び出しに到達する前にfail closed
//     (provider mockが呼ばれたかどうかを記録する)

import {
  executeCalendarAvailabilityScheduling,
  type ExecuteCalendarAvailabilitySchedulingDeps,
} from "../../../core/tact-conversation/calendarAvailabilityExecution";
import { toTemporalRequirementMetadata, type TemporalRequirement } from "../../../core/tact-work/temporalRequirements";
import type { Work, Run } from "../../../core/tact-work/types";
import type { Connection } from "../../../core/tact-integration/types";
import type { IntegrationActionExecutionOutcome } from "../../../core/tact-integration/execution";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const REFERENCE = "2026-09-14T00:00:00.000Z"; // Monday 09:00 JST — same fixture instant already proven by work/calendarAvailabilitySchedule.test.ts's own [reality] test

const REALITY_REQUIREMENT: TemporalRequirement = {
  durationMinutes: 30,
  date: { kind: "relative", value: "next_week" },
  candidateCount: 3,
  timezone: "Asia/Tokyo",
  dailyWindow: { startMinuteOfDay: 540, endMinuteOfDay: 1080 }, // 9:00-18:00
};

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    metadata: {
      temporalRequirement: toTemporalRequirementMetadata(REALITY_REQUIREMENT, { kind: "meeting_candidates", required: [] }),
    },
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
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
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
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
    status: "completed",
    startedAt: "2026-09-14T00:00:00.000Z",
    createdAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

interface BuildDepsOptions {
  work?: Work | undefined;
  connections?: Connection[];
  // "provider mock" — stands in for the real canonical Execution Boundary
  // (this file does not re-test executeReadIntegrationAction() itself;
  // see tests/tact/integration/googleCalendarWiring.test.ts's Reality Test
  // for that layer). Defaults to a realistic "completed, one busy interval"
  // outcome mirroring work/calendarAvailabilitySchedule.test.ts's own
  // proven [reality] fixture.
  executeReadIntegrationActionImpl?: ExecuteCalendarAvailabilitySchedulingDeps["executeReadIntegrationAction"];
  snapshotPersists?: boolean;
}

function buildDeps(options: BuildDepsOptions = {}) {

  const calls = {
    getWorkCalls: 0,
    listConnectionsForUserCalls: [] as { userId: string; service?: string; status?: string }[],
    executeReadIntegrationActionCalls: 0,
    updateWorkCandidateSnapshotMetadataCalls: 0,
  };

  const work = "work" in options ? options.work : makeWork();
  const connections = options.connections ?? [makeConnection()];
  const snapshotPersists = options.snapshotPersists ?? true;

  const defaultExecuteReadIntegrationActionImpl: ExecuteCalendarAvailabilitySchedulingDeps["executeReadIntegrationAction"] =
    async (params): Promise<IntegrationActionExecutionOutcome> => {

      const input = params.action.input as { rangeStartUtc: string; rangeEndUtc: string; timezone: string };

      return {
        status: "completed",
        run: makeRun({
          result: {
            success: true,
            output: JSON.stringify({
              rangeStartUtc: input.rangeStartUtc,
              rangeEndUtc: input.rangeEndUtc,
              timezone: input.timezone,
              busyIntervals: [{ startUtc: "2026-09-21T00:00:00.000Z", endUtc: "2026-09-21T01:00:00.000Z" }],
              sourceScope: "own_calendar",
            }),
          },
        }),
      };

    };

  const deps: ExecuteCalendarAvailabilitySchedulingDeps = {

    getWork: async (workId, userId) => {
      calls.getWorkCalls += 1;
      if (!work || work.userId !== userId) return undefined;
      return { ...work, id: workId };
    },

    listConnectionsForUser: async (userId, _accessToken, service, status) => {
      calls.listConnectionsForUserCalls.push({ userId, service, status });
      return connections.filter((c) => c.userId === userId && (!service || c.service === service) && (!status || c.status === status));
    },

    executeReadIntegrationAction: async (params, execDeps) => {
      calls.executeReadIntegrationActionCalls += 1;
      return (options.executeReadIntegrationActionImpl ?? defaultExecuteReadIntegrationActionImpl)(params, execDeps);
    },

    updateWorkCandidateSnapshotMetadata: async () => {
      calls.updateWorkCandidateSnapshotMetadataCalls += 1;
      return snapshotPersists;
    },

  };

  return { deps, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Scenario 1 (required, Section 20): successful mocked end-to-end flow
  // =========================

  {
    const { deps, calls } = buildDeps();

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[Scenario 1] mocked provider経由で成功し、candidatesとsnapshotが返る(実Supabase/実Composioは一切呼ばれない)",
      result.success === true && result.candidates.length === 3 && result.snapshot.version === 2
    ));

    results.push(check(
      "[Scenario 1] Connection解決はuserId-scopedで正確に1回、status=\"active\"付きで呼ばれる",
      calls.listConnectionsForUserCalls.length === 1 &&
        calls.listConnectionsForUserCalls[0].userId === OWNER_USER_ID &&
        calls.listConnectionsForUserCalls[0].status === "active" &&
        calls.listConnectionsForUserCalls[0].service === "google_calendar"
    ));

    results.push(check(
      "[Scenario 1] provider(executeReadIntegrationAction)は正確に1回だけ呼ばれる(温度計算の都度、複数回呼ばない)",
      calls.executeReadIntegrationActionCalls === 1
    ));

    results.push(check(
      "[Scenario 1] 成功時、候補スナップショットの永続化(updateWorkCandidateSnapshotMetadata)が正確に1回呼ばれる",
      calls.updateWorkCandidateSnapshotMetadataCalls === 1
    ));
  }

  // =========================
  // Scenario 2 (required, Section 20): same Work, but NO Calendar
  // connection exists -> calendar_not_connected, provider never called
  // =========================

  {
    const { deps, calls } = buildDeps({ connections: [] });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[Scenario 2] Connectionが1件も無い場合、calendar_not_connectedを返す",
      result.success === false && result.error.code === "calendar_not_connected"
    ));

    results.push(check(
      "[Scenario 2] Connectionが無い場合、provider(executeReadIntegrationAction)は一度も呼ばれない",
      calls.executeReadIntegrationActionCalls === 0
    ));

    results.push(check(
      "[Scenario 2] Connectionが無い場合、スナップショット永続化も一切呼ばれない",
      calls.updateWorkCandidateSnapshotMetadataCalls === 0
    ));
  }

  // =========================
  // Scenario 3 (required, Section 20): the only google_calendar connection
  // row belongs to a DIFFERENT user -> fail closed BEFORE provider
  // invocation, exactly like "no connection" from the caller's own
  // perspective (userId-scoped lookup structurally cannot see it).
  // =========================

  {
    const { deps, calls } = buildDeps({
      connections: [makeConnection({ id: "conn-other-user", userId: OTHER_USER_ID })],
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[Scenario 3] 存在するConnectionが別user所有の場合、calendar_not_connectedとしてfail closedする(このuserからは「未接続」と区別がつかない、意図通り)",
      result.success === false && result.error.code === "calendar_not_connected"
    ));

    results.push(check(
      "[Scenario 3] 別user所有のConnectionしか無い場合、provider(executeReadIntegrationAction)は一度も呼ばれない — fail closed BEFORE provider invocation",
      calls.executeReadIntegrationActionCalls === 0
    ));

    results.push(check(
      "[Scenario 3] listConnectionsForUserには常に呼び出し元自身のuserId(他user IDではない)が渡っている",
      calls.listConnectionsForUserCalls[0].userId === OWNER_USER_ID
    ));
  }

  // =========================
  // Additional required distinctions (Section 17 canonical error taxonomy)
  // =========================

  {
    const { deps } = buildDeps({ connections: [makeConnection(), makeConnection({ id: "conn-cal-2" })] });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[multiple] 複数のactive google_calendar connectionが同一userに存在する場合、calendar_connection_ambiguousとして区別される(not_connectedへ握り潰さない)",
      result.success === false && result.error.code === "calendar_connection_ambiguous"
    ));
  }

  {
    const { deps } = buildDeps({ work: undefined });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-missing", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[work not found] 存在しないWorkはwork_not_foundとして区別される",
      result.success === false && result.error.code === "work_not_found"
    ));
  }

  {
    const { deps, calls } = buildDeps({ work: makeWork({ status: "completed" }) });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[work not running] Workがrunning以外(completed)の場合、work_not_runningとしてfail closedし、Connection解決自体を試みない",
      result.success === false &&
        result.error.code === "work_not_running" &&
        calls.listConnectionsForUserCalls.length === 0
    ));
  }

  {
    const { deps } = buildDeps({
      work: makeWork({ metadata: {} }), // no temporalRequirement key at all
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[temporal incomplete] TemporalRequirementがWork.metadataに全く存在しない場合、temporal_requirement_incompleteとして区別される(hidden defaultを補わない)",
      result.success === false && result.error.code === "temporal_requirement_incomplete"
    ));
  }

  {
    const requirementMissingTimezone: TemporalRequirement = { ...REALITY_REQUIREMENT, timezone: undefined };
    const { deps } = buildDeps({
      work: makeWork({
        metadata: { temporalRequirement: toTemporalRequirementMetadata(requirementMissingTimezone, { kind: "meeting_candidates", required: [] }) },
      }),
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[timezone required] timezoneが無い場合、timezone_requiredとして区別される(daily_window_missing等へ握り潰さない)。No hidden default timezone.",
      result.success === false && result.error.code === "timezone_required"
    ));
  }

  {
    const requirementMissingWindow: TemporalRequirement = { ...REALITY_REQUIREMENT, dailyWindow: undefined };
    const { deps } = buildDeps({
      work: makeWork({
        metadata: { temporalRequirement: toTemporalRequirementMetadata(requirementMissingWindow, { kind: "meeting_candidates", required: [] }) },
      }),
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[daily window missing] dailyWindowが無い場合、daily_window_missingとして区別される(No hidden business-hours default)",
      result.success === false && result.error.code === "daily_window_missing"
    ));
  }

  {
    // Provider(=executeReadIntegrationAction)が明示的にpermission_denied
    // 相当のfailed outcomeを返した場合、calendar_permission_deniedへ
    // 正しく narrowing される(calendar_provider_failedへ握り潰さない)。
    const { deps } = buildDeps({
      executeReadIntegrationActionImpl: async (params) => ({
        status: "failed",
        run: makeRun({
          workId: params.workId,
          taskId: params.taskId,
          status: "failed",
          error: "アクセス権限がありません",
          externalRef: { errorCode: "authorization_denied", errorRetryable: false },
        }),
      }),
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[permission denied] providerがauthorization_deniedを返した場合、calendar_permission_deniedとして区別される",
      result.success === false && result.error.code === "calendar_permission_denied"
    ));
  }

  {
    // Providerが応答したが、Run.result.outputの形式がAvailabilityResultの
    // 検証済みcontractと一致しない場合(malformed) -> malformed_provider_result。
    const { deps } = buildDeps({
      executeReadIntegrationActionImpl: async (params) => ({
        status: "completed",
        run: makeRun({
          workId: params.workId,
          taskId: params.taskId,
          result: { success: true, output: JSON.stringify({ unexpected: "shape" }) },
        }),
      }),
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[malformed] Run.result.outputが検証済みcontractと一致しない場合、malformed_provider_resultとしてfail closed(free/busyを推測しない)",
      result.success === false && result.error.code === "malformed_provider_result"
    ));
  }

  {
    // connection_unavailable(executeReadIntegrationAction自身の再検証が
    // 拒否したケース)もcalendar_not_connectedへ正しく写像される。
    const { deps } = buildDeps({
      executeReadIntegrationActionImpl: async () => ({ status: "connection_unavailable" }),
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[connection unavailable] executeReadIntegrationAction自身がconnection_unavailableを返した場合もcalendar_not_connectedへ写像される",
      result.success === false && result.error.code === "calendar_not_connected"
    ));
  }

  {
    // 十分な空き時間が無い場合(候補0件) -> no_available_slots。
    const { deps } = buildDeps({
      executeReadIntegrationActionImpl: async (params) => {
        const input = params.action.input as { rangeStartUtc: string; rangeEndUtc: string; timezone: string };
        return {
          status: "completed",
          run: makeRun({
            workId: params.workId,
            taskId: params.taskId,
            result: {
              success: true,
              output: JSON.stringify({
                rangeStartUtc: input.rangeStartUtc,
                rangeEndUtc: input.rangeEndUtc,
                timezone: input.timezone,
                // Every daily window minute is busy -> zero candidates.
                busyIntervals: [{ startUtc: input.rangeStartUtc, endUtc: input.rangeEndUtc }],
                sourceScope: "own_calendar",
              }),
            },
          }),
        };
      },
    });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[no availability] 空き候補が0件の場合、no_available_slotsとして区別される(providerの失敗と混同しない)",
      result.success === false && result.error.code === "no_available_slots"
    ));
  }

  {
    // スナップショット永続化自体が失敗した場合(楽観的並行性の衝突等)、
    // 実際にはCalendar読み取り自体は成功していても、成功を主張しない。
    const { deps } = buildDeps({ snapshotPersists: false });

    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: REFERENCE },
      deps
    );

    results.push(check(
      "[snapshot persistence failed] updateWorkCandidateSnapshotMetadata()がfalseを返した場合、成功を主張せずsnapshot_persistence_failedを返す",
      result.success === false && result.error.code === "snapshot_persistence_failed"
    ));
  }

  for (const testCase of [
    {
      name: "missing timezone",
      requirement: { ...REALITY_REQUIREMENT, timezone: undefined },
      referenceInstantUtc: REFERENCE,
      expectedCode: "timezone_required",
    },
    {
      name: "missing daily window",
      requirement: { ...REALITY_REQUIREMENT, dailyWindow: undefined },
      referenceInstantUtc: REFERENCE,
      expectedCode: "daily_window_missing",
    },
    {
      name: "missing duration",
      requirement: { ...REALITY_REQUIREMENT, durationMinutes: undefined },
      referenceInstantUtc: REFERENCE,
      expectedCode: "temporal_requirement_incomplete",
    },
    {
      name: "missing date",
      requirement: { ...REALITY_REQUIREMENT, date: undefined },
      referenceInstantUtc: REFERENCE,
      expectedCode: "temporal_requirement_incomplete",
    },
    {
      name: "naive reference instant",
      requirement: REALITY_REQUIREMENT,
      referenceInstantUtc: "2026-09-14T00:00:00",
      expectedCode: "reference_instant_invalid",
    },
    {
      name: "DST-invalid local date",
      requirement: { ...REALITY_REQUIREMENT, date: { kind: "date" as const, date: "2026-09-06" }, timezone: "America/Santiago" },
      referenceInstantUtc: "2026-09-01T00:00:00Z",
      expectedCode: "dst_invalid_local_time",
    },
  ] as const) {
    const { deps, calls } = buildDeps({
      work: makeWork({
        metadata: {
          temporalRequirement: toTemporalRequirementMetadata(testCase.requirement, { kind: "meeting_candidates", required: [] }),
        },
      }),
    });
    const result = await executeCalendarAvailabilityScheduling(
      { workId: "work-1", taskId: "task-1", userId: OWNER_USER_ID, accessToken: "token", referenceInstantUtc: testCase.referenceInstantUtc },
      deps
    );
    results.push(check(
      `[temporal preflight] ${testCase.name} returns the specific error before resolver or provider invocation`,
      result.success === false && result.error.code === testCase.expectedCode &&
        calls.listConnectionsForUserCalls.length === 0 && calls.executeReadIntegrationActionCalls === 0
    ));
  }

  return summarize("conversation/calendarAvailabilityExecution", results);

}
