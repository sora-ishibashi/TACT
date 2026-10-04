// =========================
// TACT Canonical Execution — Outcome Store Regression (SOR-119)
// =========================
//
// 対象: core/tact-execution/outcome/store.tsのassertExecutionOutcome()の
// 分岐ロジック(validation優先・fail closed・tenant boundary・insert履歴
// + update summaryの2-step)。実Supabase接続は一切行わない
// (core/tact-execution/store.test.tsと同じDI-only方針)。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertExecutionOutcome,
  toExecutionOutcome,
  type AssertExecutionOutcomeDeps,
  type ExecutionOutcomeRow,
} from "@tact/runs-core/tact-execution/outcome/store";
import type { AssertExecutionOutcomeInput } from "@tact/runs-core/tact-execution/outcome/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function baseInput(overrides: Partial<AssertExecutionOutcomeInput> = {}): AssertExecutionOutcomeInput {
  return {
    executionId: "exec-1",
    status: "asserted",
    outcomeKind: "page_updated",
    method: "adapter_asserted",
    ...overrides,
  };
}

function makeRowFixture(overrides: Partial<ExecutionOutcomeRow> = {}): ExecutionOutcomeRow {
  return {
    id: "outcome-1",
    execution_id: "exec-1",
    status: "asserted",
    outcome_kind: "page_updated",
    summary: null,
    artifact_id: null,
    method: "adapter_asserted",
    reason_code: null,
    asserted_by_actor_kind: null,
    asserted_by_actor_id: null,
    metadata: null,
    asserted_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

// existenceCheckResult: 対象executionが呼び出し元userIdの所有かの確認
// (maybeSingle)。insertResult: tact_execution_outcomesへのinsert(single)。
// updateCalled/updatePayloadは summary列更新の.update()呼び出しを観測する
// (これ自体はterminal callを持たずbuilderをそのままawaitするだけなので、
// builder自身がthenableである必要がある——store.tsの実装通り)。
function makeFakeClient(options: {
  existenceCheckResult: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  onInsert?: (payload: Record<string, unknown>) => void;
  onUpdate?: (payload: Record<string, unknown>) => void;
}) {

  let selectCallIndex = 0;
  let insertCalled = false;
  let updateCalled = false;

  const builder = {
    from: () => builder,
    select: (columns?: string) => {
      // insert(...).select(...).single() 経路と、素のselect(existence
      // check).maybeSingle() 経路の両方から呼ばれる——insertCalled
      // flagで分岐する必要はなく、single/maybeSingleの呼び出し側が
      // どちらの結果queueを見るかを決める(下記参照)。
      void columns;
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      insertCalled = true;
      options.onInsert?.(payload);
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      updateCalled = true;
      options.onUpdate?.(payload);
      return builder;
    },
    eq: () => builder,
    maybeSingle: async () => {
      // insert直後のexistence checkではなく、update後の余計な呼び出しは
      // 無い設計(store.tsはupdateにterminal callを付けない)ため、
      // maybeSingle()は常にexistence check用。
      selectCallIndex++;
      return options.existenceCheckResult;
    },
    single: async () => {
      // insert(...).select(...).single() の結果。
      return options.insertResult ?? { data: null, error: { message: "no insertResult configured" } };
    },
    // store.tsは summary update を `await client.from().update().eq().eq()`
    // のようにterminal callなしでawaitする——builder自身がthenableである
    // 必要がある(supabase-jsの実際のquery builderと同じ挙動)。
    then: (resolve: (value: { data: null; error: null }) => void) => {
      resolve({ data: null, error: null });
    },
  };

  return {
    builder,
    wasInsertCalled: () => insertCalled,
    wasUpdateCalled: () => updateCalled,
    selectCallCount: () => selectCallIndex,
    client: builder as unknown as SupabaseClient,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 正常なasserted入力 -> persisted、summary列も更新される ----
  {
    let insertedPayload: Record<string, unknown> | undefined;
    let updatedPayload: Record<string, unknown> | undefined;

    const fake = makeFakeClient({
      existenceCheckResult: { data: { id: "exec-1" }, error: null },
      insertResult: { data: makeRowFixture(), error: null },
      onInsert: (p) => { insertedPayload = p; },
      onUpdate: (p) => { updatedPayload = p; },
    });

    const deps: AssertExecutionOutcomeDeps = { getClient: () => fake.client };

    const outcome = await assertExecutionOutcome(baseInput(), "user-1", deps);

    results.push(
      check(
        "[Test1] 正常なasserted入力はstatus=persistedを返す",
        outcome.status === "persisted" && outcome.outcome.outcomeKind === "page_updated"
      )
    );

    results.push(
      check(
        "[Test1] tact_execution_outcomesへのinsert payloadが正しい(status/outcome_kind/method)",
        insertedPayload?.status === "asserted" &&
          insertedPayload?.outcome_kind === "page_updated" &&
          insertedPayload?.method === "adapter_asserted"
      )
    );

    results.push(
      check(
        "[Test1] 親tact_canonical_executionsのoutcome_status/outcome_kind(要約列)も同じ値で更新される",
        updatedPayload?.outcome_status === "asserted" && updatedPayload?.outcome_kind === "page_updated"
      )
    );
  }

  // ---- Test2: 正常なunknown入力 -> summary列もunknown/nullで更新される ----
  {
    let updatedPayload: Record<string, unknown> | undefined;

    const fake = makeFakeClient({
      existenceCheckResult: { data: { id: "exec-1" }, error: null },
      insertResult: { data: makeRowFixture({ status: "unknown", outcome_kind: null }), error: null },
      onUpdate: (p) => { updatedPayload = p; },
    });

    const deps: AssertExecutionOutcomeDeps = { getClient: () => fake.client };

    const outcome = await assertExecutionOutcome(
      baseInput({ status: "unknown", outcomeKind: undefined }),
      "user-1",
      deps
    );

    results.push(
      check(
        "[Test2] status='unknown'(確認したが判断できない)もpersistedを返す(UNKNOWNは正常な状態)",
        outcome.status === "persisted" && outcome.outcome.outcomeKind === null
      )
    );

    results.push(
      check(
        "[Test2] 親summary列はoutcome_status='unknown'/outcome_kind=nullで更新される",
        updatedPayload?.outcome_status === "unknown" && updatedPayload?.outcome_kind === null
      )
    );
  }

  // ---- Test3: validation失敗 -> DB呼び出し前にinvalidを返す ----
  {
    const fake = makeFakeClient({ existenceCheckResult: { data: null, error: null } });
    const deps: AssertExecutionOutcomeDeps = { getClient: () => fake.client };

    const outcome = await assertExecutionOutcome(
      baseInput({ status: "asserted", outcomeKind: undefined }),
      "user-1",
      deps
    );

    results.push(
      check(
        "[Test3] validation失敗(asserted状態でoutcomeKind欠落)はstatus=invalidを返し、insertを呼ばない",
        outcome.status === "invalid" && !fake.wasInsertCalled()
      )
    );
  }

  // ---- Test4 (絶対条件、tenant boundary): 対象executionが呼び出し元userIdの所有でない場合はnot_found ----
  {
    const fake = makeFakeClient({ existenceCheckResult: { data: null, error: null } });
    const deps: AssertExecutionOutcomeDeps = { getClient: () => fake.client };

    const outcome = await assertExecutionOutcome(baseInput(), "user-other-tenant", deps);

    results.push(
      check(
        "[Test4] 対象executionが見つからない/他tenant所有の場合はstatus=not_foundを返し、insertを呼ばない(他tenantのExecutionへ書き込めない)",
        outcome.status === "not_found" && !fake.wasInsertCalled()
      )
    );
  }

  // ---- 参考: service roleが利用不可の場合はfail closedでunavailableを返す ----
  {
    const deps: AssertExecutionOutcomeDeps = { getClient: () => null };

    const outcome = await assertExecutionOutcome(baseInput(), "user-1", deps);

    results.push(
      check(
        "[Ref] service role client不可時はstatus=unavailableを返す(fail closed)",
        outcome.status === "unavailable"
      )
    );
  }

  // ---- 参考: toExecutionOutcome()のfield mapping ----
  {
    const row = makeRowFixture({
      id: "outcome-2",
      artifact_id: "artifact-1",
      method: "manual_override",
      reason_code: "human_reviewed_and_corrected",
      asserted_by_actor_kind: "human",
      asserted_by_actor_id: "U123",
    });

    const outcome = toExecutionOutcome(row);

    results.push(
      check(
        "[Ref] toExecutionOutcome(): artifactId/method/reasonCode/assertedByActorKind/Idが変換される(human correction経路)",
        outcome.artifactId === "artifact-1" &&
          outcome.method === "manual_override" &&
          outcome.reasonCode === "human_reviewed_and_corrected" &&
          outcome.assertedByActorKind === "human" &&
          outcome.assertedByActorId === "U123"
      )
    );
  }

  return summarize("SOR-119 — Canonical Execution Outcome Store", results);

}
