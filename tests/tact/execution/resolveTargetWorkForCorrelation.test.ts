// =========================
// TACT Canonical Execution — resolveTargetWorkForCorrelation Regression
// (SOR-52 Closeout Hardening Part1)
// =========================
//
// 対象: core/tact-execution/store.tsのresolveTargetWorkForCorrelation()。
// captureExecution()(workId指定時)とcorrelateExecutionToWork()の両方が
// 使う共有tenant/state validation helper。実Supabase接続は一切行わない。

import {
  resolveTargetWorkForCorrelation,
  WORK_TERMINAL_STATUSES,
  type ResolveTargetWorkForCorrelationDeps,
} from "../../../core/tact-execution/store";
import type { Work } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 正常系: activeなWorkはokを返す ----
  {
    const deps: ResolveTargetWorkForCorrelationDeps = {
      getWork: async () => makeWork({ status: "running" }),
      getServiceRoleKey: () => "service-role-key",
    };

    const result = await resolveTargetWorkForCorrelation("work-1", "user-1", deps);

    results.push(check("[OK] activeなWorkはok:trueを返す", result.ok === true));
  }

  // ---- Test1/cross-user: getWork()がundefinedを返す(存在しない/所有者
  // 不一致のいずれも同じ結果、既存getConversation()等と同じ規約) ----
  {
    let calledWith: { workId: string; userId: string } | undefined;

    const deps: ResolveTargetWorkForCorrelationDeps = {
      getWork: async (workId, userId) => {
        calledWith = { workId, userId };
        return undefined;
      },
      getServiceRoleKey: () => "service-role-key",
    };

    const result = await resolveTargetWorkForCorrelation("work-other-tenant", "user-1", deps);

    results.push(
      check(
        "[Test1/cross-user] 他userのWork(getWork()がundefinedを返す)はnot_foundとなる(存在有無を漏らさない既存規約)",
        result.ok === false && !result.ok && result.reason === "not_found" &&
          calledWith?.workId === "work-other-tenant" && calledWith?.userId === "user-1"
      )
    );
  }

  // ---- Test2/3/4: completed/failed/cancelledはnot_correlatable ----
  for (const status of WORK_TERMINAL_STATUSES) {

    const deps: ResolveTargetWorkForCorrelationDeps = {
      getWork: async () => makeWork({ status }),
      getServiceRoleKey: () => "service-role-key",
    };

    const result = await resolveTargetWorkForCorrelation("work-1", "user-1", deps);

    results.push(
      check(
        `[Test2-4] status=${status}のWorkはnot_correlatableを返す(auto correlationの対象外)`,
        result.ok === false && !result.ok && result.reason === "not_correlatable"
      )
    );

  }

  // ---- 非terminal statusはすべて許容される ----
  for (const status of ["created", "planning", "waiting_for_input", "waiting_for_approval"] as const) {

    const deps: ResolveTargetWorkForCorrelationDeps = {
      getWork: async () => makeWork({ status }),
      getServiceRoleKey: () => "service-role-key",
    };

    const result = await resolveTargetWorkForCorrelation("work-1", "user-1", deps);

    results.push(check(`[Non-terminal] status=${status}のWorkはokを返す`, result.ok === true));

  }

  // ---- service role未設定 -> fail closedでnot_found ----
  {
    const deps: ResolveTargetWorkForCorrelationDeps = {
      getWork: async () => makeWork(),
      getServiceRoleKey: () => null,
    };

    const result = await resolveTargetWorkForCorrelation("work-1", "user-1", deps);

    results.push(check("[Ref] service role未設定時はfail closedでnot_foundを返す", result.ok === false));
  }

  // ---- SOR-74/malformed workId: getWork()がthrowする(実DBでは
  // 「不正なUUID構文」のPostgresエラー)場合も、呼び出し元(captureExecution())
  // へ例外を伝播させず、他のnot_foundケースと同じくfail closedする
  // (絶対条件: 不正なworkIdがExecution captureそのものを落としてはならない)。
  {
    const deps: ResolveTargetWorkForCorrelationDeps = {
      getWork: async () => {
        throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
      },
      getServiceRoleKey: () => "service-role-key",
    };

    const result = await resolveTargetWorkForCorrelation("not-a-uuid", "user-1", deps);

    results.push(
      check(
        "[SOR-74/malformed] getWork()がthrowするmalformed workIdはnot_foundとしてfail closedし、例外を伝播しない",
        result.ok === false && !result.ok && result.reason === "not_found"
      )
    );
  }

  return summarize("TACT Canonical Execution — resolveTargetWorkForCorrelation", results);

}
