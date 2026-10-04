// =========================
// TACT Canonical Execution — Attention Store Regression (SOR-52)
// =========================
//
// 対象: core/tact-execution/permission/attentionStore.tsの
// persistExecutionAttention()/listExecutionAttentions()/
// getExecutionAttention()。tests/tact/execution/permission/store.test.ts
// と同じ方針: 実Supabase接続は一切行わない(偽clientを注入する)。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  persistExecutionAttention,
  listExecutionAttentions,
  getExecutionAttention,
  type AttentionRow,
  type PersistExecutionAttentionDeps,
  type ReadExecutionAttentionsDeps,
} from "@tact/runs-core/tact-execution/permission/attentionStore";
import type { ExecutionAttentionCandidate } from "@tact/runs-core/tact-execution/permission/attention";
import type { ExecutionRow } from "@tact/runs-core/tact-execution/store";
import type { PermissionDecisionRow } from "@tact/runs-core/tact-execution/permission/store";
import { check, summarize, type CheckResult } from "../../lib/check";

function baseCandidate(overrides: Partial<ExecutionAttentionCandidate> = {}): ExecutionAttentionCandidate {
  return {
    executionId: "exec-1",
    userId: "user-1",
    provider: "mcp",
    operation: "notion_update_page",
    reason: "approval_required",
    reasonCode: "notion_m0_update_page_approval_required",
    policyId: "notion-ai-agent-update-page-approval-required",
    occurredAt: "2026-09-20T00:00:01.000Z",
    ...overrides,
  };
}

function makeAttentionRowFixture(overrides: Partial<AttentionRow> = {}): AttentionRow {
  return {
    id: "attention-1",
    user_id: "user-1",
    execution_id: "exec-1",
    permission_decision_id: "decision-1",
    reason: "approval_required",
    status: "open",
    created_at: "2026-09-20T00:00:01.000Z",
    updated_at: "2026-09-20T00:00:01.000Z",
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
}

function makeExecutionRowFixture(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: "exec-1",
    schema_version: 1,
    user_id: "user-1",
    organization_id: null,
    workspace_id: null,
    work_id: null,
    correlation_status: "pending",
    connection_id: null,
    actor_kind: "ai_agent",
    actor_id: "principal-1",
    agent_id: "agent-1",
    on_behalf_of_actor_kind: null,
    on_behalf_of_actor_id: null,
    provider: "mcp",
    source_type: "sdk_callback",
    external_event_id: "invocation-1",
    adapter_version: "notion-mcp-v1",
    source_metadata: null,
    raw_payload_ref: null,
    observation_mode: "instrumented",
    pre_execution_visible: false,
    action_category: "update",
    operation: "notion_update_page",
    resource_type: "notion_page",
    resource_identifier: "page-1",
    target_provider: "notion",
    status: "succeeded",
    error_code: null,
    error_message: null,
    permission_status: "approval_required",
    permission_reason_code: "notion_m0_update_page_approval_required",
    permission_evaluated_at: "2026-09-20T00:00:01.000Z",
    outcome_status: "unknown",
    outcome_kind: null,
    provider_occurred_at: null,
    observed_at: "2026-09-20T00:00:00.000Z",
    persisted_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  } as ExecutionRow;
}

function makeDecisionRowFixture(overrides: Partial<PermissionDecisionRow> = {}): PermissionDecisionRow {
  return {
    id: "decision-1",
    execution_id: "exec-1",
    status: "approval_required",
    reason_code: "notion_m0_update_page_approval_required",
    policy_id: "notion-ai-agent-update-page-approval-required",
    evaluator_version: "permission-evaluator-v1",
    metadata: null,
    evaluated_at: "2026-09-20T00:00:01.000Z",
    registry_rule_id: null,
    registry_rule_revision: null,
    ...overrides,
  };
}

// persistExecutionAttention向け: from().insert().select().single() /
// from().select().eq().maybeSingle() のみ。
function makeInsertFakeClient(
  singleResults: Array<{ data: unknown; error: unknown }>
) {

  let callIndex = 0;

  const builder = {
    from: () => builder,
    insert: () => builder,
    select: () => builder,
    eq: () => builder,
    single: async () => singleResults[callIndex++],
    maybeSingle: async () => singleResults[callIndex++],
  };

  return builder as unknown as SupabaseClient;

}

interface TableResult { data: unknown; error?: unknown }

// listExecutionAttentions/getExecutionAttention向け: table名ごとに
// awaitされた時の結果を切り替える、汎用query builder fake。
// select/eq/in/order/limitはすべて自分自身を返す(実supabase-jsの
// chainable builderと同じ形)。
function makeReadFakeClient(resultsByTable: Record<string, TableResult | TableResult[]>) {

  const callIndexByTable: Record<string, number> = {};

  function nextResult(table: string): TableResult {
    const configured = resultsByTable[table];
    if (Array.isArray(configured)) {
      const index = callIndexByTable[table] ?? 0;
      callIndexByTable[table] = index + 1;
      return configured[index] ?? { data: null };
    }
    return configured ?? { data: null };
  }

  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => nextResult(table),
        then: (resolve: (value: TableResult) => unknown) => resolve(nextResult(table)),
      };
      return builder;
    },
  } as unknown as SupabaseClient;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 正常なpersist ----
  {
    const rowFixture = makeAttentionRowFixture();
    const deps: PersistExecutionAttentionDeps = { getClient: () => makeInsertFakeClient([{ data: rowFixture, error: null }]) };

    const outcome = await persistExecutionAttention(baseCandidate(), "decision-1", deps);

    results.push(check(
      "persistExecutionAttention(): 正常なcandidateはstatus=persistedを返す",
      outcome.status === "persisted" && outcome.attention.executionId === "exec-1" && outcome.attention.reason === "approval_required"
    ));
  }

  // ---- Required test 6/7: duplicate/retry -> already_exists(二重生成しない) ----
  {
    const existingRow = makeAttentionRowFixture({ id: "attention-existing" });
    const deps: PersistExecutionAttentionDeps = {
      getClient: () => makeInsertFakeClient([
        { data: null, error: { code: "23505", message: "duplicate key" } },
        { data: existingRow, error: null },
      ]),
    };

    const outcome = await persistExecutionAttention(baseCandidate(), "decision-1", deps);

    results.push(check(
      "[Required test 6/7] 同一executionIdの再挿入はstatus=already_existsとして既存行をそのまま返す(新規行を作らない)",
      outcome.status === "already_exists" && outcome.attention.id === "attention-existing"
    ));
  }

  // ---- unavailable ----
  {
    const deps: PersistExecutionAttentionDeps = { getClient: () => null };
    const outcome = await persistExecutionAttention(baseCandidate(), "decision-1", deps);

    results.push(check("[Ref] service role client不可時はstatus=unavailableを返す(fail closed)", outcome.status === "unavailable"));
  }

  // ---- Required test 12/13: read boundary — newest-first, workId/executionStatusはExecutionのcurrent値から ----
  {
    const rows = [
      makeAttentionRowFixture({ id: "attention-new", execution_id: "exec-new", permission_decision_id: "decision-new", created_at: "2026-09-20T02:00:00.000Z" }),
      makeAttentionRowFixture({ id: "attention-old", execution_id: "exec-1", permission_decision_id: "decision-1", created_at: "2026-09-20T01:00:00.000Z" }),
    ];
    const executions = [
      makeExecutionRowFixture({ id: "exec-new", work_id: "work-123" }),
      makeExecutionRowFixture({ id: "exec-1", work_id: null }),
    ];
    const decisions = [
      makeDecisionRowFixture({ id: "decision-new", execution_id: "exec-new" }),
      makeDecisionRowFixture({ id: "decision-1" }),
    ];

    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: rows },
        tact_canonical_executions: { data: executions },
        tact_execution_permission_decisions: { data: decisions },
      }),
    };

    const items = await listExecutionAttentions("user-1", {}, deps);

    results.push(check(
      "[Required test 12/13] listExecutionAttentions()はnewest-first(created_at desc)の順を保ち、workIdをExecutionの現在値から都度読む",
      items.length === 2 &&
        items[0].attentionId === "attention-new" &&
        items[0].workId === "work-123" &&
        items[1].attentionId === "attention-old" &&
        items[1].workId === null
    ));

    results.push(check(
      "[Section10] read boundaryはpermissionEvaluation/actor/agent/action等、UI向けの必要fieldをすべて含む",
      items[1].permissionEvaluation.status === "approval_required" &&
        items[1].permissionEvaluation.reasonCode === "notion_m0_update_page_approval_required" &&
        items[1].actor.kind === "ai_agent" &&
        items[1].actor.id === "principal-1" &&
        items[1].agentId === "agent-1" &&
        items[1].targetProvider === "notion" &&
        items[1].action.actionCategory === "update" &&
        items[1].executionStatus === "succeeded" &&
        items[1].reason === "approval_required" &&
        items[1].status === "open"
    ));
  }

  // ---- SOR-18: Work title enrichment(存在し、tenantが一致する場合) ----
  {
    const rows = [makeAttentionRowFixture({ id: "attention-with-work", execution_id: "exec-with-work" })];
    const executions = [makeExecutionRowFixture({ id: "exec-with-work", work_id: "work-abc" })];

    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: rows },
        tact_canonical_executions: { data: executions },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
        tact_works: { data: [{ id: "work-abc", title: "Q3 renewal outreach" }] },
      }),
    };

    const items = await listExecutionAttentions("user-1", {}, deps);

    results.push(check(
      "[SOR-18] workIdが確定しているAttentionは、tenant一致するWorkのtitleをworkTitleとして読み時に付与する",
      items.length === 1 && items[0].workId === "work-abc" && items[0].workTitle === "Q3 renewal outreach"
    ));
  }

  // ---- SOR-18(絶対条件、Human Owner指示「Tenant-safe Work title enrichment」):
  // work_idが破損/他tenant参照であってもWork titleを漏らさない(`.eq(user_id)`で除外) ----
  {
    const rows = [makeAttentionRowFixture({ id: "attention-cross-tenant-work", execution_id: "exec-cross-tenant-work" })];
    const executions = [makeExecutionRowFixture({ id: "exec-cross-tenant-work", work_id: "work-not-mine" })];

    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: rows },
        tact_canonical_executions: { data: executions },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
        // tact_worksのuser_id絞り込みで除外された状態を模す(他tenantのWork)。
        tact_works: { data: [] },
      }),
    };

    const items = await listExecutionAttentions("user-1", {}, deps);

    results.push(check(
      "[SOR-18/絶対条件] work_idが他tenantのWorkを指していても(worksクエリのuser_id絞り込みで除外される)、" +
        "workTitleはnullのまま(workId自体は保持、No-Fabrication)であり、決して他tenantのtitleを漏らさない",
      items.length === 1 && items[0].workId === "work-not-mine" && items[0].workTitle === null
    ));
  }

  // ---- Required test 11: tenant isolation — 他tenantのExecutionは
  // (RLS/query時のuser_id filterをbypassするfakeでも)推測で埋めない ----
  {
    const rows = [makeAttentionRowFixture({ id: "attention-cross-tenant", execution_id: "exec-1" })];
    // このExecution行は他user("user-2")のものとして返ってくる想定
    // (fakeはuser_id filterそのものを模擬しないため、application層が
    // 「返ってきたExecutionのuser_idを信用してよいか」に依存しない
    // ことを直接は検証できない——ただし実装は`.eq("user_id", userId)`を
    // 常にexecutions queryへ付ける、という契約をコードレビュー可能な
    // 形で固定している、attentionStore.ts参照)。
    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: rows },
        tact_canonical_executions: { data: [] }, // 他tenant→user_id filterでexcludeされた状態を模す
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
      }),
    };

    const items = await listExecutionAttentions("user-1", {}, deps);

    results.push(check(
      "[Required test 11] tenant isolation: 対応するExecutionがuser_id filterで見えない場合、そのAttentionはlistから除外される(他tenantのデータを漏らさない)",
      items.length === 0
    ));
  }

  // ---- Required test 14: 後からWork contextが付与されても同一Attentionのまま(新しいAttentionを作らない) ----
  {
    const row = makeAttentionRowFixture({ id: "attention-1", execution_id: "exec-1" });

    const beforeDeps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: row },
        tact_canonical_executions: { data: [makeExecutionRowFixture({ work_id: null })] },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
      }),
    };
    const afterDeps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: row },
        tact_canonical_executions: { data: [makeExecutionRowFixture({ work_id: "work-later" })] },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
      }),
    };

    const before = await getExecutionAttention("attention-1", "user-1", beforeDeps);
    const after = await getExecutionAttention("attention-1", "user-1", afterDeps);

    results.push(check(
      "[Required test 14] SOR-53がExecutionへWorkを紐づけた後も、同じattentionIdのまま最新workIdを読める" +
        "(Attention行自体は一切変更しない設計、section7)",
      before?.attentionId === "attention-1" && before.workId === null &&
        after?.attentionId === "attention-1" && after.workId === "work-later"
    ));
  }

  // ---- open-only filter ----
  {
    const openRow = makeAttentionRowFixture({ id: "attention-open", status: "open" });

    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: [openRow] },
        tact_canonical_executions: { data: [makeExecutionRowFixture()] },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
      }),
    };

    const items = await listExecutionAttentions("user-1", { status: "open" }, deps);

    results.push(check(
      "[Section11] status='open' filterはopen以外を除外したlistを返す(このfakeではqueryそのものはmockされ、結果セットの整形経路を確認する)",
      items.length === 1 && items[0].status === "open"
    ));
  }

  // ---- 対応するExecution/Decisionが読めない行は除外する(No-Fabrication) ----
  {
    const rows = [makeAttentionRowFixture({ execution_id: "exec-missing" })];

    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: rows },
        tact_canonical_executions: { data: [] },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
      }),
    };

    const items = await listExecutionAttentions("user-1", {}, deps);

    results.push(check(
      "[No-Fabrication] 対応するExecutionが読めない(他tenant/削除済み等)行は、推測で埋めずlistから除外する",
      items.length === 0
    ));
  }

  // ---- getExecutionAttention: 単一item取得 ----
  {
    const row = makeAttentionRowFixture();

    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({
        tact_execution_attentions: { data: row },
        tact_canonical_executions: { data: [makeExecutionRowFixture()] },
        tact_execution_permission_decisions: { data: [makeDecisionRowFixture()] },
      }),
    };

    const item = await getExecutionAttention("attention-1", "user-1", deps);

    results.push(check(
      "getExecutionAttention(): 単一Attentionを、対応するExecution/Decisionと組み立てて返す",
      item !== undefined && item.attentionId === "attention-1" && item.workId === null
    ));
  }

  // ---- getExecutionAttention: 見つからない場合 ----
  {
    const deps: ReadExecutionAttentionsDeps = {
      getClient: () => makeReadFakeClient({ tact_execution_attentions: { data: null } }),
    };

    const item = await getExecutionAttention("attention-missing", "user-1", deps);

    results.push(check("getExecutionAttention(): 見つからないattentionIdはundefinedを返す", item === undefined));
  }

  return summarize("TACT Canonical Execution — Attention Store", results);

}
