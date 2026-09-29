// =========================
// TACT Canonical Execution — Permission Decision Store Regression (SOR-51)
// =========================
//
// 対象: core/tact-execution/permission/store.tsのpersistPermissionDecision()
// の分岐ロジック。tests/tact/execution/store.test.tsと同じ方針: 実
// Supabase接続は一切行わない(偽clientを注入する)。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  persistPermissionDecision,
  type PersistPermissionDecisionDeps,
  type PermissionDecisionRow,
} from "../../../../core/tact-execution/permission/store";
import type { PermissionDecision } from "../../../../core/tact-execution/permission/types";
import type { UpdatePermissionContextOutcome } from "../../../../core/tact-execution/store";
import { check, summarize, type CheckResult } from "../../lib/check";

function baseDecision(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    executionId: "exec-1",
    status: "allowed",
    reasonCode: "human_slack_mention_allowed",
    policyId: "human-slack-mention-allowed",
    evaluatorVersion: "permission-evaluator-v1",
    evaluatedAt: "2026-09-20T00:00:01.000Z",
    ...overrides,
  };
}

function makeRowFixture(overrides: Partial<PermissionDecisionRow> = {}): PermissionDecisionRow {
  return {
    id: "decision-1",
    execution_id: "exec-1",
    status: "allowed",
    reason_code: "human_slack_mention_allowed",
    policy_id: "human-slack-mention-allowed",
    evaluator_version: "permission-evaluator-v1",
    metadata: null,
    evaluated_at: "2026-09-20T00:00:01.000Z",
    registry_rule_id: null,
    registry_rule_revision: null,
    ...overrides,
  };
}

function makeFakeClient(
  singleAndMaybeSingleResults: Array<{ data: unknown; error: unknown }>
) {

  let callIndex = 0;

  const builder = {
    from: () => builder,
    insert: () => builder,
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    single: async () => singleAndMaybeSingleResults[callIndex++],
    maybeSingle: async () => singleAndMaybeSingleResults[callIndex++],
  };

  return builder as unknown as SupabaseClient;

}

function makeAlwaysUpdatedSummaryFn(): PersistPermissionDecisionDeps["updateExecutionPermissionContext"] {
  return (async () => ({
    status: "updated",
    execution: {} as never,
  })) as unknown as PersistPermissionDecisionDeps["updateExecutionPermissionContext"];
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 正常な評価 -> persisted ----
  {
    const rowFixture = makeRowFixture();

    const deps: PersistPermissionDecisionDeps = {
      getClient: () => makeFakeClient([{ data: rowFixture, error: null }]),
      updateExecutionPermissionContext: makeAlwaysUpdatedSummaryFn(),
    };

    const outcome = await persistPermissionDecision(baseDecision(), "user-1", deps);

    results.push(
      check(
        "[Test1] 正常なdecisionはstatus=persistedを返す",
        outcome.status === "persisted" && outcome.decision.executionId === "exec-1"
      )
    );
  }

  // ---- Test10: duplicate evaluation(同一evaluator_version×policy_id) -> already_evaluated ----
  {
    const existingRow = makeRowFixture({ id: "decision-existing" });

    const deps: PersistPermissionDecisionDeps = {
      getClient: () =>
        makeFakeClient([
          { data: null, error: { code: "23505", message: "duplicate key" } },
          { data: existingRow, error: null },
        ]),
      updateExecutionPermissionContext: makeAlwaysUpdatedSummaryFn(),
    };

    const outcome = await persistPermissionDecision(baseDecision(), "user-1", deps);

    results.push(
      check(
        "[Test10/Idempotency] 同一evaluator_version×policy_idでの再評価はstatus=already_evaluatedとして既存decisionを返す(新規行を作らない)",
        outcome.status === "already_evaluated" && outcome.decision.executionId === "exec-1"
      )
    );
  }

  // ---- Test14: 既存finalized decisionへの再評価ポリシー(unknown, policy_id="none"のsentinel往復) ----
  {
    const unknownDecision = baseDecision({ status: "unknown", policyId: null, reasonCode: "no_matching_policy" });
    const rowFixture = makeRowFixture({ status: "unknown", policy_id: "none", reason_code: "no_matching_policy" });

    const deps: PersistPermissionDecisionDeps = {
      getClient: () => makeFakeClient([{ data: rowFixture, error: null }]),
      updateExecutionPermissionContext: makeAlwaysUpdatedSummaryFn(),
    };

    const outcome = await persistPermissionDecision(unknownDecision, "user-1", deps);

    results.push(
      check(
        "[Test14] policy未マッチ(unknown)のdecisionはDB上sentinel('none')で一意性判定されつつ、公開domain型ではpolicyId=nullへ戻る",
        outcome.status === "persisted" && outcome.decision.policyId === null
      )
    );
  }

  // ---- Test9: execution not found(FK違反 23503) ----
  {
    const deps: PersistPermissionDecisionDeps = {
      getClient: () => makeFakeClient([{ data: null, error: { code: "23503", message: "fk violation" } }]),
      updateExecutionPermissionContext: makeAlwaysUpdatedSummaryFn(),
    };

    const outcome = await persistPermissionDecision(baseDecision({ executionId: "does-not-exist" }), "user-1", deps);

    results.push(check("[Test9] 存在しないexecutionIdはstatus=execution_not_foundを返す", outcome.status === "execution_not_found"));
  }

  // ---- Test: invalid(巨大metadata) ----
  {
    const deps: PersistPermissionDecisionDeps = {
      getClient: () => makeFakeClient([]),
      updateExecutionPermissionContext: makeAlwaysUpdatedSummaryFn(),
    };

    const outcome = await persistPermissionDecision(
      baseDecision({ metadata: { note: "x".repeat(5000) } }),
      "user-1",
      deps
    );

    results.push(check("[Validation] 巨大なmetadataを持つdecisionはstatus=invalidを返す(DB到達前)", outcome.status === "invalid"));
  }

  // ---- Test: unavailable ----
  {
    const deps: PersistPermissionDecisionDeps = {
      getClient: () => null,
      updateExecutionPermissionContext: makeAlwaysUpdatedSummaryFn(),
    };

    const outcome = await persistPermissionDecision(baseDecision(), "user-1", deps);

    results.push(check("[Ref] service role client不可時はstatus=unavailableを返す(fail closed)", outcome.status === "unavailable"));
  }

  // ---- Test8: tenant mismatch(summary更新がnot_foundでも、decision自体は既に確定済みのため取り消されない) ----
  {
    const rowFixture = makeRowFixture();

    const mismatchedSummaryUpdate: PersistPermissionDecisionDeps["updateExecutionPermissionContext"] = (async () => {
      const outcome: UpdatePermissionContextOutcome = { status: "not_found" };
      return outcome;
    }) as unknown as PersistPermissionDecisionDeps["updateExecutionPermissionContext"];

    const deps: PersistPermissionDecisionDeps = {
      getClient: () => makeFakeClient([{ data: rowFixture, error: null }]),
      updateExecutionPermissionContext: mismatchedSummaryUpdate,
    };

    const outcome = await persistPermissionDecision(baseDecision(), "wrong-user", deps);

    results.push(
      check(
        "[Test8/tenant mismatch/SOR-52 Closeout Hardening Part7] summary列の更新が(userId不一致等で)not_foundになった場合、" +
          "decision(history)自体は失われないが、単純なpersistedとは区別されるpersisted_summary_sync_failedを返す(呼び出し元が不整合を識別できる)",
        outcome.status === "persisted_summary_sync_failed" &&
          outcome.decision.executionId === "exec-1" &&
          outcome.summarySyncStatus === "not_found"
      )
    );
  }

  return summarize("TACT Canonical Execution — Permission Decision Store", results);

}
