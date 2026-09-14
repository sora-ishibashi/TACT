// =========================
// TACT Work — Temporal State Persistence Regression (TIME-P1a)
// =========================
//
// 対象: core/tact-work/store.tsのtoWork()/toWorkTask()(deadline/
// wait_until/next_retry_atのround-trip)と、setWorkDeadline()/
// setTaskWaitUntil()/setTaskNextRetryAt()(validation/precondition部分
// だけ)。既存tests/tact/work/mapping.test.tsと同じ方針: 実Supabase
// 接続は一切行わない(実DB上のUPDATE成功パス自体の検証は、既存の
// completeRun()/failRun()の`.eq("status","running")`guardと同じ理由で、
// このtest fileのscope外——別途一時スクリプトで確認する)。ここでは
// deps経由でfakeできる範囲(getWork/listTasksForWork)と、実DB呼び出し
// (createRequestScopedClient())へ到達する前に安全にreturnする各種
// validation/precondition分岐だけを確認する。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toWork,
  toWorkTask,
  setWorkDeadline,
  setTaskWaitUntil,
  setTaskNextRetryAt,
  type WorkRow,
  type WorkTaskRow,
} from "../../../core/tact-work/store";
import type { Work, WorkTask } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

function makeWorkRow(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    id: "work-1",
    user_id: OWNER_USER_ID,
    organization_id: null,
    created_by_actor_kind: "user",
    created_by_actor_id: OWNER_USER_ID,
    title: null,
    objective: null,
    subject: null,
    request_type: null,
    completion_conditions: null,
    required_capabilities: null,
    evidence_refs: null,
    result_delivered_at: null,
    status: "running",
    primary_conversation_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    cost_summary: null,
    metadata: null,
    created_at: "2026-10-10T00:00:00.000Z",
    updated_at: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeWorkTaskRow(overrides: Partial<WorkTaskRow> = {}): WorkTaskRow {
  return {
    id: "task-1",
    work_id: "work-1",
    parent_task_id: null,
    description: "test",
    status: "pending",
    assigned_capability: null,
    table_schema: null,
    created_at: "2026-10-10T00:00:00.000Z",
    updated_at: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [round-trip 1] toWork(): 既存rowにdeadline列自体が無い
  // (このphase以前のfake/古いSELECT結果相当)場合、Work.deadlineは
  // undefinedのまま安全にtoWork()できる(ARCH-P1aのsubjectVersion等と
  // 同じ既存の後方互換パターン) ----
  {
    const row = makeWorkRow();
    delete (row as Partial<WorkRow>).deadline;

    const work = toWork(row);

    results.push(
      check(
        "[round-trip 1] deadline列自体が無いWorkRowも安全にtoWork()でき、Work.deadlineはundefinedのまま(後方互換)",
        work.deadline === undefined
      )
    );
  }

  // ---- [round-trip 2] toWork(): deadline列が明示的にNULLの場合はnull
  // をそのまま伝播する(余計な正規化をしない、既存パターン) ----
  {
    const work = toWork(makeWorkRow({ deadline: null }));

    results.push(
      check(
        "[round-trip 2] deadline=NULLはnullのまま伝播する(余計な正規化をしない)",
        work.deadline === null
      )
    );
  }

  // ---- [round-trip 3] toWork(): deadlineに実際の値がある場合、そのまま
  // 変換される(timezone-safe: timestamptz由来のZ付きISO文字列がそのまま
  // 保持される) ----
  {
    const work = toWork(makeWorkRow({ deadline: "2026-12-31T23:59:59.000Z" }));

    results.push(
      check(
        "[round-trip 3] deadlineに値がある場合、ISO文字列がそのまま(timezone情報を失わずに)domain型へ変換される",
        work.deadline === "2026-12-31T23:59:59.000Z"
      )
    );
  }

  // ---- [round-trip 4] toWorkTask(): wait_until/next_retry_atの
  // round-trip(列自体が無い場合はundefined、NULLはnull、値がある場合は
  // そのまま) ----
  {
    const withoutColumns = makeWorkTaskRow();
    delete (withoutColumns as Partial<WorkTaskRow>).wait_until;
    delete (withoutColumns as Partial<WorkTaskRow>).next_retry_at;

    const taskWithoutColumns = toWorkTask(withoutColumns);

    const taskWithNulls = toWorkTask(makeWorkTaskRow({ wait_until: null, next_retry_at: null }));

    const taskWithValues = toWorkTask(makeWorkTaskRow({
      wait_until: "2026-10-11T00:00:00.000Z",
      next_retry_at: "2026-10-10T13:00:00.000Z",
    }));

    results.push(
      check(
        "[round-trip 4] toWorkTask(): wait_until/next_retry_atが列自体無し->undefined、NULL->null、値あり->そのままdomain型へ変換される(round-trip正しい)",
        taskWithoutColumns.waitUntil === undefined &&
          taskWithoutColumns.nextRetryAt === undefined &&
          taskWithNulls.waitUntil === null &&
          taskWithNulls.nextRetryAt === null &&
          taskWithValues.waitUntil === "2026-10-11T00:00:00.000Z" &&
          taskWithValues.nextRetryAt === "2026-10-10T13:00:00.000Z"
      )
    );
  }

  // ---- [validation 1] setWorkDeadline(): 不正な形式(timezone無しの
  // ambiguousなlocal time文字列)はDB呼び出し(getWork())へ到達する前に
  // invalid_timestampとして拒否される(絶対条件Section10/11) ----
  {
    let getWorkCalls = 0;

    const outcome = await setWorkDeadline(
      "work-1", OWNER_USER_ID, "token", "2026-10-10 12:00:00",
      { getWork: async () => { getWorkCalls++; return undefined; } }
    );

    results.push(
      check(
        "[validation 1] setWorkDeadline(): timezone無しのambiguousな文字列(\"2026-10-10 12:00:00\")はinvalid_timestampとして拒否され、getWork()にすら到達しない(実DB呼び出し前に安全に停止)",
        outcome.status === "invalid_timestamp" && getWorkCalls === 0
      )
    );
  }

  // ---- [validation 2] setWorkDeadline(): 完全に不正な文字列
  // ("not-a-date")もinvalid_timestamp ----
  {
    const outcome = await setWorkDeadline(
      "work-1", OWNER_USER_ID, "token", "not-a-date",
      { getWork: async () => undefined }
    );

    results.push(
      check(
        '[validation 2] setWorkDeadline(): "not-a-date"もinvalid_timestamp',
        outcome.status === "invalid_timestamp"
      )
    );
  }

  // ---- [validation 3] setWorkDeadline(): null(clear)は常に有効な値
  // として扱われる(validation自体は通過し、Work所有権チェックへ進む) ----
  {
    const outcome = await setWorkDeadline(
      "work-1", OWNER_USER_ID, "token", null,
      { getWork: async () => undefined } // Work不明でnot_foundへ、= validationは通過したことの間接証拠
    );

    results.push(
      check(
        "[validation 3] setWorkDeadline(): null(clear)はinvalid_timestampにならない(validationを通過し、次の所有権チェックへ進む)",
        outcome.status === "not_found" // invalid_timestampではない
      )
    );
  }

  // ---- [validation 4] setWorkDeadline(): Work不明(所有者不一致/存在
  // しない) -> not_found、実DB更新へは到達しない ----
  {
    const outcome = await setWorkDeadline(
      "work-1", OWNER_USER_ID, "token", "2026-12-31T00:00:00.000Z",
      { getWork: async () => undefined }
    );

    results.push(
      check(
        "[validation 4] setWorkDeadline(): Work不明はnot_found",
        outcome.status === "not_found"
      )
    );
  }

  // ---- [validation 5] setTaskWaitUntil(): 同じvalidation/not_found
  // パターン(setWorkDeadline()と対称) ----
  {
    const invalidOutcome = await setTaskWaitUntil(
      "work-1", OWNER_USER_ID, "token", "task-1", "2026-10-10 12:00:00",
      { getWork: async () => undefined }
    );

    const notFoundOutcome = await setTaskWaitUntil(
      "work-1", OWNER_USER_ID, "token", "task-1", "2026-12-31T00:00:00.000Z",
      { getWork: async () => undefined }
    );

    results.push(
      check(
        "[validation 5] setTaskWaitUntil(): ambiguousな文字列はinvalid_timestamp、Work不明はnot_found",
        invalidOutcome.status === "invalid_timestamp" && notFoundOutcome.status === "not_found"
      )
    );
  }

  // ---- [validation 6] setTaskNextRetryAt(): 非nullの値を設定しようと
  // した場合、Task.status !== "waiting_for_retry" ならば
  // task_not_waiting_for_retryとして拒否される(絶対条件Section11
  // 「nextRetryAtはwaiting_for_retryに対してのみ意味を持つ」、実DB更新
  // へは到達しない) ----
  {
    const outcome = await setTaskNextRetryAt(
      "work-1", OWNER_USER_ID, "token", "task-1", "2026-12-31T00:00:00.000Z",
      {
        getWork: async () => ({ id: "work-1", userId: OWNER_USER_ID, createdByActorKind: "user", createdByActorId: OWNER_USER_ID, status: "running", createdAt: "x", updatedAt: "x" } as Work),
        listTasksForWork: async () => [{ id: "task-1", workId: "work-1", description: "test", status: "running", createdAt: "x", updatedAt: "x" } as WorkTask],
      }
    );

    results.push(
      check(
        '[validation 6] setTaskNextRetryAt(): Task.status="running"(waiting_for_retryではない)への非null設定はtask_not_waiting_for_retryとして拒否される',
        outcome.status === "task_not_waiting_for_retry" &&
          (outcome as { taskStatus?: string }).taskStatus === "running"
      )
    );
  }

  // ---- [validation 7] setTaskNextRetryAt(): precondition checkが
  // 実際にlistTasksForWork()を呼び出してTask実体を確認していること
  // (「Task.statusを確認せずに常にtask_not_waiting_for_retryを返す」
  // ような固定応答になっていないこと)の配線確認。Task.status===
  // "waiting_for_retry"の場合、precondition自体は通過して実DB更新へ
  // 進む(=このtest fileのscope外)ため、listTasksForWork()自体に
  // わざと例外を投げさせ、「実際に呼ばれた」ことだけを実DB到達前に
  // 安全に確認する(validation 6が「不一致を正しく検出する」ことを
  // 既に証明しているため、この関数は単純なif文1つだけであり、一致時に
  // 正しく通過することは別途実行時証明を必要としない——ここでは
  // 「呼ばれていること」自体の配線だけを確認する) ----
  {
    let listTasksForWorkCalls = 0;
    let threwFromListTasksForWork = false;

    try {

      await setTaskNextRetryAt(
        "work-1", OWNER_USER_ID, "token", "task-1", "2026-12-31T00:00:00.000Z",
        {
          getWork: async () => ({ id: "work-1", userId: OWNER_USER_ID, createdByActorKind: "user", createdByActorId: OWNER_USER_ID, status: "running", createdAt: "x", updatedAt: "x" } as Work),
          listTasksForWork: async () => {
            listTasksForWorkCalls++;
            // 意図的にここで停止させる(実DB更新へ到達させない、test-only)。
            throw new Error("test-only: stop before reaching the real DB client");
          },
        }
      );

    } catch {
      threwFromListTasksForWork = true;
    }

    results.push(
      check(
        "[validation 7] setTaskNextRetryAt(): nextRetryAtが非nullの場合、precondition checkが実際にlistTasksForWork()を呼び出す(固定応答ではない配線の確認)",
        listTasksForWorkCalls === 1 && threwFromListTasksForWork
      )
    );
  }

  // ---- [validation 8] setTaskNextRetryAt(): Task不明(waitTasksに
  // 含まれない) -> task_not_found ----
  {
    const outcome = await setTaskNextRetryAt(
      "work-1", OWNER_USER_ID, "token", "task-missing", "2026-12-31T00:00:00.000Z",
      {
        getWork: async () => ({ id: "work-1", userId: OWNER_USER_ID, createdByActorKind: "user", createdByActorId: OWNER_USER_ID, status: "running", createdAt: "x", updatedAt: "x" } as Work),
        listTasksForWork: async () => [],
      }
    );

    results.push(
      check(
        "[validation 8] setTaskNextRetryAt(): Task不明はtask_not_found",
        outcome.status === "task_not_found"
      )
    );
  }

  // ---- [validation 9] setTaskNextRetryAt(): null(clear)を渡した場合、
  // Task.statusに関わらずprecondition check(listTasksForWork呼び出し)
  // 自体をskipする(絶対条件Section17: clearは常に許可する、retry開始や
  // Task終了時にnextRetryAtを安全にclearできるようにするための設計) ----
  {
    let listTasksForWorkCalls = 0;

    const outcome = await setTaskNextRetryAt(
      "work-1", OWNER_USER_ID, "token", "task-1", null,
      {
        getWork: async () => undefined, // Work不明でnot_foundへ(実DB到達前に安全に停止)
        listTasksForWork: async () => {
          listTasksForWorkCalls++;
          return [{ id: "task-1", workId: "work-1", description: "test", status: "completed", createdAt: "x", updatedAt: "x" } as WorkTask];
        },
      }
    );

    results.push(
      check(
        "[validation 9] setTaskNextRetryAt(): null(clear)を渡した場合、Work不明のnot_foundまでは到達するがlistTasksForWork()(precondition check)は一切呼ばれない(clearはstatus precondition対象外)",
        outcome.status === "not_found" && listTasksForWorkCalls === 0
      )
    );
  }

  // ---- [source] store.tsのsetWorkDeadline()/setTaskWaitUntil()/
  // setTaskNextRetryAt()が、実際に正しい列名(deadline/wait_until/
  // next_retry_at)へUPDATEしていることのsource-level構造的証拠
  // (fakeベースのDIでは実DB query文自体を検証できないため、
  // tests/tact/integration/execution.test.tsの
  // completeRun()/failRun()guard確認と同じ手法を踏襲する) ----
  {
    const storeSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "store.ts"),
      "utf-8"
    );

    const setWorkDeadlineBody = storeSource.slice(
      storeSource.indexOf("export async function setWorkDeadline"),
      storeSource.indexOf("// This is intentionally called only after")
    );

    const setTaskWaitUntilBody = storeSource.slice(
      storeSource.indexOf("export async function setTaskWaitUntil"),
      storeSource.indexOf("export interface SetTaskNextRetryAtDeps")
    );

    const setTaskNextRetryAtBody = storeSource.slice(
      storeSource.indexOf("export async function setTaskNextRetryAt"),
      storeSource.indexOf("// =========================\n// Task Dependency")
    );

    results.push(
      check(
        "[source] setWorkDeadline()/setTaskWaitUntil()/setTaskNextRetryAt()はそれぞれ正しい列(deadline/wait_until/next_retry_at)を対象にUPDATEする",
        setWorkDeadlineBody.includes("deadline:") &&
          setTaskWaitUntilBody.includes("wait_until:") &&
          setTaskNextRetryAtBody.includes("next_retry_at:")
      )
    );
  }

  // ---- TIME-P1a FIX1(Step3、nextRetryAt cleanup): updateTaskStatus()
  // が、status!=="waiting_for_retry"への遷移(retry claim成功時の
  // waiting_for_retry→running含む、およびcompleted/failed/cancelledの
  // いずれも)で next_retry_at を null にする、という不変条件のsource
  // レベル構造的証拠(実DB接続なしにquery文自体を検証できないため、
  // 上のsetter guard確認と同じ手法)。 ----
  {
    const storeSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "tact-work", "store.ts"),
      "utf-8"
    );

    const updateTaskStatusBody = storeSource.slice(
      storeSource.indexOf("export async function updateTaskStatus"),
      storeSource.indexOf("// TIME-P1a: WorkTask.waitUntil")
    );

    results.push(
      check(
        '[TIME-P1a FIX1 source] updateTaskStatus()はstatus!=="waiting_for_retry"の場合にnext_retry_at:nullをUPDATEへ含める(単一の中央集約点、waiting_for_retry→running/completed/failed/cancelledいずれの遷移でも自動的にクリアされる)',
        updateTaskStatusBody.includes('status !== "waiting_for_retry"') &&
          updateTaskStatusBody.includes("next_retry_at = null")
      )
    );
  }

  // ---- TIME-P1a FIX1: updateTaskStatus()呼び出しがWork不明で安全に
  // 停止する場合(実DB到達前)でも、例外を投げずreturnする既存挙動が
  // このcommitで壊れていないことの最小確認(実DB接続なしで到達できる
  // 唯一のupdateTaskStatus()経路) ----
  {
    const { updateTaskStatus } = await import("../../../core/tact-work/store");

    let threw = false;

    try {
      await updateTaskStatus("work-1", OWNER_USER_ID, "token", "task-1", "completed", {
        getWork: async () => undefined,
      });
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[TIME-P1a FIX1] updateTaskStatus(): Work不明の場合、例外を投げず安全にreturnする(next_retry_at clear追加後も既存のfail-safe挙動は不変)",
        !threw
      )
    );
  }

  return summarize("work/temporalPersistence", results);

}
