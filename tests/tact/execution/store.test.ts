// =========================
// TACT Canonical Execution — Store Regression (SOR-50)
// =========================
//
// 対象: core/tact-execution/store.tsのcaptureExecution()の分岐ロジック
// (validation優先・fail closed・atomic claim/duplicate判定)。
// tests/tact/work/storeAuthorization.test.tsと同じ方針: 実Supabase
// 接続は一切行わない(CaptureExecutionDepsへ偽clientを注入する)。
// Migration自体のUNIQUE index/RLS/FK制約による実際の防止は、別途
// 一時スクリプト(scripts/verifyCanonicalExecutionCapture.ts)で確認
// する。
//
// SOR-50 Tests要件のうち、ここで検証するもの:
//   1. 正常なexternal event -> Canonical Execution(captured)
//   2. 必須値欠落(validation.test.tsで検証済み、ここではstore層が
//      DB呼び出し前にvalidationへ委譲することを確認する)
//   3. duplicate event(unique_violation 23505 -> 既存行を返す)
//   4. Work IDなし(workId省略 -> work_id: null)
//   5. Work IDあり(workId指定 -> work_id: 指定値)
//   6. failed execution(status/errorCode/errorMessageが保持される)
//   9. tenant boundary(userId別なら別行としてinsertされる —
//      idempotency keyが(user_id, provider, external_event_id)である
//      ことをinsert payloadから確認する)

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  captureExecution,
  type CaptureExecutionDeps,
  type ExecutionRow,
  type ResolveTargetWorkForCorrelationResult,
} from "../../../core/tact-execution/store";
import type { CaptureExecutionInput } from "../../../core/tact-execution/types";
import { check, summarize, type CheckResult } from "../lib/check";

// SOR-52 Closeout Hardening Part1: captureExecution()がworkId指定時に
// resolveTargetWorkForCorrelation()を呼ぶようになったため、既存のtest
// fixtureも明示的に偽実装を注入する。多くのtestはworkIdを指定しない
// ため実際には呼ばれない(captureExecution()自身がinput.workIdが
// truthyな場合のみ呼ぶ)——それでも型としては必須fieldなので、
// 「呼ばれたら必ずnot_foundを返す」安全側のdefaultを用意する。
const notFoundResolveTargetWorkForCorrelation: CaptureExecutionDeps["resolveTargetWorkForCorrelation"] =
  async (): Promise<ResolveTargetWorkForCorrelationResult> => ({ ok: false, reason: "not_found" });

function baseInput(overrides: Partial<CaptureExecutionInput> = {}): CaptureExecutionInput {
  return {
    userId: "user-1",
    actorKind: "human",
    actorId: "U123",
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev123",
    adapterVersion: "slack-app-mention-v1",
    actionCategory: "create",
    operation: "app_mention",
    ...overrides,
  };
}

function makeRowFixture(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: "exec-1",
    schema_version: 1,
    user_id: "user-1",
    organization_id: null,
    workspace_id: null,
    work_id: null,
    correlation_status: "pending",
    connection_id: null,
    actor_kind: "human",
    actor_id: "U123",
    agent_id: null,
    on_behalf_of_actor_kind: null,
    on_behalf_of_actor_id: null,
    provider: "slack",
    source_type: "webhook",
    external_event_id: "Ev123",
    adapter_version: "slack-app-mention-v1",
    source_metadata: null,
    raw_payload_ref: null,
    observation_mode: null,
    pre_execution_visible: false,
    action_category: "create",
    operation: "app_mention",
    resource_type: null,
    resource_identifier: null,
    target_provider: "slack",
    status: "succeeded",
    error_code: null,
    error_message: null,
    permission_status: "unknown",
    permission_reason_code: null,
    permission_evaluated_at: null,
    provider_occurred_at: null,
    observed_at: "2026-09-20T00:00:01.000Z",
    persisted_at: "2026-09-20T00:00:02.000Z",
    updated_at: "2026-09-20T00:00:02.000Z",
    ...overrides,
  };
}

// insertが呼ばれた際の最終Payloadを観測しつつ、singleAndMaybeSingleResults
// を呼び出し順に返す最小限の偽client。実SupabaseClientの型とは構造的に
// 一致しないため、呼び出し側で`as unknown as SupabaseClient`する
// (storeAuthorization.test.tsのnotFoundDepsと同じ「偽DIで分岐だけを
// 決定論的に検証する」考え方)。
function makeFakeClient(
  singleAndMaybeSingleResults: Array<{ data: unknown; error: unknown }>,
  onInsert?: (payload: Record<string, unknown>) => void
) {

  let callIndex = 0;

  const builder = {
    from: () => builder,
    insert: (payload: Record<string, unknown>) => {
      onInsert?.(payload);
      return builder;
    },
    select: () => builder,
    eq: () => builder,
    update: () => builder,
    is: () => builder,
    order: () => builder,
    single: async () => singleAndMaybeSingleResults[callIndex++],
    maybeSingle: async () => singleAndMaybeSingleResults[callIndex++],
  };

  return builder as unknown as SupabaseClient;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 正常なexternal event -> captured ----
  {
    const rowFixture = makeRowFixture();
    let insertedPayload: Record<string, unknown> | undefined;

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([{ data: rowFixture, error: null }], (payload) => {
          insertedPayload = payload;
        }),
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(baseInput(), deps);

    results.push(
      check(
        "[Test1] 正常なexternal eventはstatus=capturedを返す",
        outcome.status === "captured" && outcome.execution.id === "exec-1"
      )
    );

    results.push(
      check(
        "[Test9] idempotency keyの構成要素(user_id/provider/external_event_id)がinsert payloadへ含まれる",
        insertedPayload?.user_id === "user-1" &&
          insertedPayload?.provider === "slack" &&
          insertedPayload?.external_event_id === "Ev123"
      )
    );
  }

  // ---- Test2: 必須値欠落 -> DB呼び出し前にinvalidを返す ----
  {
    let clientRequested = false;

    const deps: CaptureExecutionDeps = {
      getClient: () => {
        clientRequested = true;
        return makeFakeClient([]);
      },
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(baseInput({ externalEventId: "" }), deps);

    results.push(
      check(
        "[Test2] 必須値欠落時はstatus=invalidを返し、DB clientへ一切到達しない",
        outcome.status === "invalid" && clientRequested === false
      )
    );
  }

  // ---- Test3: duplicate event(unique_violation 23505) ----
  {
    const existingRow = makeRowFixture({ id: "exec-existing" });

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([
          { data: null, error: { code: "23505", message: "duplicate key" } },
          { data: existingRow, error: null },
        ]),
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(baseInput(), deps);

    results.push(
      check(
        "[Test3] unique_violation(23505)はstatus=duplicateとして既存行を返す(新規行を作らない)",
        outcome.status === "duplicate" && outcome.execution.id === "exec-existing"
      )
    );
  }

  // ---- Test4: Work IDなし ----
  {
    const rowFixture = makeRowFixture({ work_id: null });
    let insertedPayload: Record<string, unknown> | undefined;

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([{ data: rowFixture, error: null }], (payload) => {
          insertedPayload = payload;
        }),
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(baseInput({ workId: undefined }), deps);

    results.push(
      check(
        "[Test4] workId省略時、insert payloadのwork_idはnull(Work未確定でも記録できる)",
        outcome.status === "captured" && insertedPayload?.work_id === null
      )
    );
  }

  // ---- Test5: Work IDあり(tenant/state validationを通過する場合) ----
  {
    const rowFixture = makeRowFixture({ work_id: "work-1" });
    let insertedPayload: Record<string, unknown> | undefined;

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([{ data: rowFixture, error: null }], (payload) => {
          insertedPayload = payload;
        }),
      resolveTargetWorkForCorrelation: async () => ({ ok: true, work: { id: "work-1" } as never }),
    };

    const outcome = await captureExecution(baseInput({ workId: "work-1" }), deps);

    results.push(
      check(
        "[Test5] workId指定時、tenant/state validationを通過すればinsert payloadのwork_idへそのまま渡る",
        outcome.status === "captured" && insertedPayload?.work_id === "work-1"
      )
    );
  }

  // ---- Test5b(SOR-52 Closeout Hardening Part1): workId指定時、tenant/
  // state validationに失敗した場合はcapture自体を拒否せずworkIdだけを
  // 落とす(Capture First原則を優先しつつ、誤ったtenant/terminal-status
  // Workへの自動紐付けは防ぐ) ----
  {
    const rowFixture = makeRowFixture({ work_id: null });
    let insertedPayload: Record<string, unknown> | undefined;
    let resolveCalledWith: { workId: string; userId: string } | undefined;

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([{ data: rowFixture, error: null }], (payload) => {
          insertedPayload = payload;
        }),
      resolveTargetWorkForCorrelation: async (workId, userId) => {
        resolveCalledWith = { workId, userId };
        return { ok: false, reason: "not_correlatable" };
      },
    };

    const outcome = await captureExecution(baseInput({ workId: "work-completed-1" }), deps);

    results.push(
      check(
        "[Test5b] workIdのtenant/state validationに失敗した場合、captureは成功するがworkIdは落とされる(insert payloadのwork_idはnull)",
        outcome.status === "captured" &&
          insertedPayload?.work_id === null &&
          resolveCalledWith?.workId === "work-completed-1" &&
          resolveCalledWith?.userId === "user-1"
      )
    );
  }

  // ---- Test6: failed execution ----
  {
    const rowFixture = makeRowFixture({
      status: "failed",
      error_code: "provider_timeout",
      error_message: "upstream timed out",
    });
    let insertedPayload: Record<string, unknown> | undefined;

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([{ data: rowFixture, error: null }], (payload) => {
          insertedPayload = payload;
        }),
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(
      baseInput({ status: "failed", errorCode: "provider_timeout", errorMessage: "upstream timed out" }),
      deps
    );

    results.push(
      check(
        "[Test6] failed executionのstatus/error情報が失われずinsert・返却される",
        outcome.status === "captured" &&
          outcome.execution.status === "failed" &&
          outcome.execution.errorCode === "provider_timeout" &&
          insertedPayload?.status === "failed"
      )
    );
  }

  // ---- 参考: service roleが利用不可の場合はfail closedでunavailableを
  // 返す(silent successにしない)。環境変数の実際の設定状況に依存させ
  // ない(「実DB接続=0」絶対条件、getClientを直接nullへ差し替える) ----
  {
    const deps: CaptureExecutionDeps = {
      getClient: () => null,
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(baseInput(), deps);

    results.push(
      check(
        "[Ref] service role client不可時はstatus=unavailableを返す(fail closed)",
        outcome.status === "unavailable"
      )
    );
  }

  // ---- Test7 (SOR-45): schemaVersion常に1・observationMode/
  // preExecutionVisibleがinsert payload/戻り値へ正しく伝わる ----
  {
    const rowFixture = makeRowFixture({
      schema_version: 1,
      observation_mode: "instrumented",
      pre_execution_visible: false,
    });
    let insertedPayload: Record<string, unknown> | undefined;

    const deps: CaptureExecutionDeps = {
      getClient: () =>
        makeFakeClient([{ data: rowFixture, error: null }], (payload) => {
          insertedPayload = payload;
        }),
      resolveTargetWorkForCorrelation: notFoundResolveTargetWorkForCorrelation,
    };

    const outcome = await captureExecution(baseInput({ observationMode: "instrumented" }), deps);

    results.push(
      check(
        "[Test7a] captureExecution()は呼び出し元の指定に関わらず常にschema_version=1をinsertする",
        insertedPayload?.schema_version === 1
      )
    );

    results.push(
      check(
        "[Test7b] observationModeがinsert payloadへそのまま伝わる",
        insertedPayload?.observation_mode === "instrumented"
      )
    );

    results.push(
      check(
        "[Test7c] preExecutionVisible省略時はfalseがinsert payloadへ入る(現在の全adapterの実態と一致)",
        insertedPayload?.pre_execution_visible === false
      )
    );

    results.push(
      check(
        "[Test7d] 戻り値のCanonicalExecutionにschemaVersion/observationMode/preExecutionVisibleが反映される",
        outcome.status === "captured" &&
          outcome.execution.schemaVersion === 1 &&
          outcome.execution.observationMode === "instrumented" &&
          outcome.execution.preExecutionVisible === false
      )
    );
  }

  // 注記(SOR-52 Final Consistency & Concurrency Hardening): 旧
  // updateExecutionCorrelationStatus()/correlateExecutionToWork()/
  // reclassifyExecutionWork()(app層での複数query構成)はここにあったが、
  // apply_execution_work_correlation()/reclassify_execution_work()
  // (単一transaction RPC)へ置き換えたため削除した。その分岐ロジックの
  // regressionはtests/tact/execution/correlation/store.test.ts・
  // manualOverride.test.ts(RPC呼び出しを偽装してoutcomeを検証する)
  // が担う。

  return summarize("TACT Canonical Execution — Store", results);

}
