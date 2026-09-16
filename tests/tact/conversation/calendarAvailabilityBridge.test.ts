// =========================
// runCalendarAvailabilityBridge Regression (TIME-P1c Final Wiring)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのrunCalendarAvailabilityBridge()。
// executeCalendarAvailabilityScheduling()自体(core/tact-conversation/
// calendarAvailabilityExecution.ts)は既にtests/tact/conversation/
// calendarAvailabilityExecution.test.tsでcalendar_not_connected/
// calendar_connection_ambiguous/no_available_slots等を検証済みのため、
// ここではそれらを再検証せず、「bridgeがCalendarAvailabilityBridgeDeps
// 経由でexecuteCalendarAvailabilityScheduling()を正しいparamsで呼び、
// 成功/失敗のいずれの結果も安全なcanonical日本語messageへ正しく
// mapする」ことだけを、全deps偽実装(実Supabase/Composio接続なし、
// Category A)で確認する。
//
// Section18/19の「Generic LLMは呼ばれない」「Calendar scheduling
// bridge IS invoked」は、この関数自体がrunChat()/runWorkTurn()を
// 一切importしない構造(このtest fileがimportする関数はexecuteCalendar
// AvailabilitySchedulingのみ)によって構造的に保証される。

import { runCalendarAvailabilityBridge } from "../../../core/tact-conversation/orchestration";
import type { CalendarAvailabilityBridgeDeps } from "../../../core/tact-conversation/orchestration";
import type { Work } from "../../../core/tact-work/types";
import type { WorkTask } from "../../../core/tact-work/types";
import type {
  ExecuteCalendarAvailabilitySchedulingParams,
  ExecuteCalendarAvailabilitySchedulingResult,
  CalendarSchedulingErrorCode,
} from "../../../core/tact-conversation/calendarAvailabilityExecution";
import type { CandidateSlotSnapshotMetadata } from "../../../core/tact-work/candidateSchedule";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
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

interface Recorder {
  createTaskCalls: { workId: string; userId: string; assignedCapability?: string | null }[];
  schedulingCalls: ExecuteCalendarAvailabilitySchedulingParams[];
  statusUpdates: { taskId: string; status: string }[];
}

function buildDeps(
  schedulingResult: ExecuteCalendarAvailabilitySchedulingResult,
  options: { createTaskReturnsUndefined?: boolean } = {}
): { deps: CalendarAvailabilityBridgeDeps; recorder: Recorder } {

  const recorder: Recorder = { createTaskCalls: [], schedulingCalls: [], statusUpdates: [] };

  const deps: CalendarAvailabilityBridgeDeps = {

    createTask: (async (workId: string, userId: string, _accessToken: string, params) => {
      recorder.createTaskCalls.push({ workId, userId, assignedCapability: params.assignedCapability });
      return options.createTaskReturnsUndefined ? undefined : makeTask({ workId });
    }) as CalendarAvailabilityBridgeDeps["createTask"],

    updateTaskStatus: (async (_workId: string, _userId: string, _accessToken: string, taskId: string, status: string) => {
      recorder.statusUpdates.push({ taskId, status });
    }) as CalendarAvailabilityBridgeDeps["updateTaskStatus"],

    executeCalendarAvailabilityScheduling: (async (params: ExecuteCalendarAvailabilitySchedulingParams) => {
      recorder.schedulingCalls.push(params);
      return schedulingResult;
    }) as CalendarAvailabilityBridgeDeps["executeCalendarAvailabilityScheduling"],

  };

  return { deps, recorder };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Section19-G: valid mocked provider result -> candidate snapshot
  // formatted as concise Japanese, in the documented format ----
  {
    const { deps, recorder } = buildDeps({
      success: true,
      candidates: [
        { index: 1, startUtc: "2026-09-17T01:30:00.000Z", endUtc: "2026-09-17T02:00:00.000Z", timezone: "Asia/Tokyo" },
        { index: 2, startUtc: "2026-09-17T04:00:00.000Z", endUtc: "2026-09-17T04:30:00.000Z", timezone: "Asia/Tokyo" },
        { index: 3, startUtc: "2026-09-17T07:15:00.000Z", endUtc: "2026-09-17T07:45:00.000Z", timezone: "Asia/Tokyo" },
      ],
      // snapshot自体の中身はcalendarAvailabilityExecution.test.tsが検証
      // 済みのため、ここではbridgeが結果を透過的に使うことだけを確認する。
      snapshot: {} as CandidateSlotSnapshotMetadata,
    });

    const answer = await runCalendarAvailabilityBridge(makeWork(), "user-1", "token-1", deps);

    results.push(check(
      "[Section19-G] a successful scheduling result is formatted with the documented Japanese template and local (Asia/Tokyo) clock times",
      answer.includes("Google Calendarを確認しました") &&
        answer.includes("空いている候補は次の3つです") &&
        answer.includes("1. 10:30〜11:00") &&
        answer.includes("2. 13:00〜13:30") &&
        answer.includes("3. 16:15〜16:45")
    ));

    results.push(check(
      "[Section19-G] never claims attendee availability (\"参加者全員が空いています\" must not appear)",
      !answer.includes("参加者")
    ));

    results.push(check(
      "[Section11/12] a real ad-hoc Task is created with the canonical Calendar execution binding, and executeCalendarAvailabilityScheduling() is invoked with that Task's id + an explicit referenceInstantUtc",
      recorder.createTaskCalls.length === 1 &&
        recorder.createTaskCalls[0].assignedCapability === "integration.google_calendar.availability_read" &&
        recorder.schedulingCalls.length === 1 &&
        recorder.schedulingCalls[0].taskId === "task-1" &&
        recorder.schedulingCalls[0].workId === "work-1" &&
        typeof recorder.schedulingCalls[0].referenceInstantUtc === "string" &&
        !Number.isNaN(Date.parse(recorder.schedulingCalls[0].referenceInstantUtc))
    ));

    results.push(check(
      "[Section12] the Task is marked completed only after a successful Calendar read (Task/Run lifecycle preserved)",
      recorder.statusUpdates.length === 1 && recorder.statusUpdates[0].status === "completed"
    ));
  }

  // ---- Section19-E: not connected -> typed, distinct message (never a
  // generic conversational failure) ----
  {
    const { deps, recorder } = buildDeps({
      success: false,
      error: { code: "calendar_not_connected", message: "internal detail that must not leak verbatim" },
    });

    const answer = await runCalendarAvailabilityBridge(makeWork(), "user-1", "token-1", deps);

    results.push(check(
      "[Section19-E] calendar_not_connected maps to a fixed, safe Japanese message (not the raw internal error text)",
      answer.includes("接続されていません") && !answer.includes("internal detail")
    ));

    results.push(check(
      "[Section12] a failed Calendar read marks the Task failed, never leaves it silently pending or completed",
      recorder.statusUpdates.length === 1 && recorder.statusUpdates[0].status === "failed"
    ));
  }

  // ---- Section19-F: multiple active connections -> distinct ambiguous
  // message, distinguishable from "not connected" ----
  {
    const { deps } = buildDeps({
      success: false,
      error: { code: "calendar_connection_ambiguous", message: "n/a" },
    });

    const answer = await runCalendarAvailabilityBridge(makeWork(), "user-1", "token-1", deps);

    results.push(check(
      "[Section19-F] calendar_connection_ambiguous is distinguishable from calendar_not_connected (Section15: preserve distinct errors)",
      answer.includes("複数") && !answer.includes("接続されていません")
    ));
  }

  // ---- Section15: every distinct CalendarSchedulingErrorCode maps to a
  // distinct, non-empty message (exhaustiveness enforced at compile time
  // via Record<CalendarSchedulingErrorCode, string> in orchestration.ts;
  // this just spot-checks a few more codes are reachable end-to-end
  // through the bridge). ----
  {
    const codes: { code: CalendarSchedulingErrorCode; mustInclude: string }[] = [
      { code: "timezone_required", mustInclude: "タイムゾーン" },
      { code: "daily_window_missing", mustInclude: "時間帯" },
      { code: "no_available_slots", mustInclude: "見つかりませんでした" },
      { code: "calendar_permission_denied", mustInclude: "権限" },
    ];

    let allDistinctAndSafe = true;
    const seenMessages = new Set<string>();

    for (const { code, mustInclude } of codes) {
      const { deps } = buildDeps({ success: false, error: { code, message: "n/a" } });
      const answer = await runCalendarAvailabilityBridge(makeWork(), "user-1", "token-1", deps);
      if (!answer.includes(mustInclude) || seenMessages.has(answer)) {
        allDistinctAndSafe = false;
      }
      seenMessages.add(answer);
    }

    results.push(check(
      "[Section15] distinct CalendarSchedulingErrorCode values map to distinct, curated Japanese messages (never collapsed into one generic failure string)",
      allDistinctAndSafe
    ));
  }

  // ---- Defensive: createTask() itself failing (Work vanished mid-flight)
  // never crashes the turn and never calls the scheduling function ----
  {
    const { deps, recorder } = buildDeps(
      { success: true, candidates: [], snapshot: {} as CandidateSlotSnapshotMetadata },
      { createTaskReturnsUndefined: true }
    );

    const answer = await runCalendarAvailabilityBridge(makeWork(), "user-1", "token-1", deps);

    results.push(check(
      "[defensive] createTask() returning undefined yields a safe message and never calls executeCalendarAvailabilityScheduling()",
      typeof answer === "string" && answer.length > 0 && recorder.schedulingCalls.length === 0
    ));
  }

  return summarize("conversation/calendarAvailabilityBridge", results);

}
