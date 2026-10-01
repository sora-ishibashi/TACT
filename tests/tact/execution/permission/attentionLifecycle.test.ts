// =========================
// TACT Canonical Execution — Attention Lifecycle Transition Regression (SOR-48)
// =========================
//
// 対象: core/tact-execution/permission/attentionStore.tsの
// transitionExecutionAttention()(単一conditional UPDATE文によるCAS
// pattern)。fake clientは「id + user_id + status∈allowedFromStatuses」
// というWHERE句を実際に評価する最小限のin-memory実装にし、単なる
// 固定応答のmockにはしない——CAS自体の正しさ(race時にresolvedが
// 後退しないこと等)を、実際のfilter評価を通じて検証するため。

import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionExecutionAttention, type TransitionExecutionAttentionDeps } from "@tact/runs-core/tact-execution/permission/attentionStore";
import type { AttentionStatus } from "@tact/runs-core/tact-execution/permission/attentionStore";
import type { AttentionReason } from "@tact/runs-core/tact-execution/permission/attention";
import { check, summarize, type CheckResult } from "../../lib/check";

interface FakeAttentionRow {
  id: string;
  user_id: string;
  execution_id: string;
  permission_decision_id: string;
  reason: AttentionReason;
  status: AttentionStatus;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

function makeFakeRow(overrides: Partial<FakeAttentionRow> = {}): FakeAttentionRow {
  return {
    id: "attention-1",
    user_id: "user-1",
    execution_id: "exec-1",
    permission_decision_id: "decision-1",
    reason: "approval_required",
    status: "open",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
}

// 単一conditional UPDATE文(CAS)を、実際にfilterを評価するin-memory
// storeとして再現する——固定応答queueではなく、id/user_id/statusの
// 実際の一致を見て0件 or 1件を返す(Postgresの行レベルlock下での
// UPDATE意味論と同じ挙動を単体test上で模す)。
function makeFakeAttentionClient(initialRows: FakeAttentionRow[]) {

  const rows = new Map<string, FakeAttentionRow>(initialRows.map((r) => [r.id, { ...r }]));

  function fromTable() {

    const filters: Array<[string, unknown]> = [];
    let inFilter: { col: string; values: readonly unknown[] } | null = null;
    let mode: "select" | "update" = "select";
    let updatePayload: Record<string, unknown> | null = null;

    function rowMatches(row: FakeAttentionRow): boolean {
      if (!filters.every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val)) return false;
      if (inFilter && !inFilter.values.includes((row as unknown as Record<string, unknown>)[inFilter.col])) return false;
      return true;
    }

    const builder = {
      select: () => builder,
      update: (payload: Record<string, unknown>) => {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      in: (col: string, values: readonly unknown[]) => {
        inFilter = { col, values };
        return builder;
      },
      maybeSingle: async () => {

        const found = [...rows.values()].find(rowMatches);

        if (mode === "update") {

          if (!found || !updatePayload) {
            return { data: null, error: null };
          }

          const updated: FakeAttentionRow = { ...found, ...updatePayload };
          rows.set(found.id, updated);
          return { data: updated, error: null };

        }

        return { data: found ?? null, error: null };

      },
    };

    return builder;

  }

  return { from: () => fromTable(), __rows: rows } as unknown as SupabaseClient & { __rows: Map<string, FakeAttentionRow> };

}

function depsFor(client: SupabaseClient): TransitionExecutionAttentionDeps {
  return { getClient: () => client };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- open -> acknowledged ----
  {
    const client = makeFakeAttentionClient([makeFakeRow()]);
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "acknowledge", depsFor(client));

    results.push(
      check(
        "[open->acknowledged] acknowledgeはstatusをacknowledgedへ変え、acknowledged_at/byを設定する",
        outcome.status === "transitioned" &&
          outcome.attention.status === "acknowledged" &&
          outcome.attention.acknowledgedAt !== null &&
          outcome.attention.acknowledgedBy === "user-1" &&
          outcome.attention.resolvedAt === null
      )
    );
  }

  // ---- acknowledged -> resolved ----
  {
    const client = makeFakeAttentionClient([makeFakeRow({ status: "acknowledged", acknowledged_at: "2026-09-20T00:01:00.000Z", acknowledged_by: "user-1" })]);
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "resolve", depsFor(client));

    results.push(
      check(
        "[acknowledged->resolved] resolveはstatusをresolvedへ変え、resolved_at/byを設定し、既存acknowledged_at/byは保持する",
        outcome.status === "transitioned" &&
          outcome.attention.status === "resolved" &&
          outcome.attention.resolvedBy === "user-1" &&
          outcome.attention.acknowledgedAt === "2026-09-20T00:01:00.000Z"
      )
    );
  }

  // ---- open -> resolved (direct, acknowledgeをskip) ----
  {
    const client = makeFakeAttentionClient([makeFakeRow()]);
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "resolve", depsFor(client));

    results.push(
      check(
        "[open->resolved(直接)] resolveはacknowledgeを経由せず直接resolvedへ遷移できる。" +
          "acknowledged_at/byは(起きていない事象として)nullのまま(No-Fabrication)",
        outcome.status === "transitioned" &&
          outcome.attention.status === "resolved" &&
          outcome.attention.acknowledgedAt === null &&
          outcome.attention.acknowledgedBy === null
      )
    );
  }

  // ---- 繰り返しのacknowledge(idempotent no-op、acknowledged_at/byは上書きされない) ----
  {
    const client = makeFakeAttentionClient([makeFakeRow({ status: "acknowledged", acknowledged_at: "2026-09-20T00:01:00.000Z", acknowledged_by: "user-1" })]);
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "acknowledge", depsFor(client));

    results.push(
      check(
        "[繰り返しacknowledge] 既にacknowledgedの行への再度のacknowledgeはno_op(元のacknowledged_atを保持、上書きしない)",
        outcome.status === "no_op" &&
          outcome.attention.status === "acknowledged" &&
          outcome.attention.acknowledgedAt === "2026-09-20T00:01:00.000Z"
      )
    );
  }

  // ---- 繰り返しのresolve(idempotent no-op) ----
  {
    const client = makeFakeAttentionClient([makeFakeRow({ status: "resolved", resolved_at: "2026-09-20T00:02:00.000Z", resolved_by: "user-1" })]);
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "resolve", depsFor(client));

    results.push(
      check(
        "[繰り返しresolve] 既にresolvedの行への再度のresolveはno_op(元のresolved_atを保持)",
        outcome.status === "no_op" &&
          outcome.attention.status === "resolved" &&
          outcome.attention.resolvedAt === "2026-09-20T00:02:00.000Z"
      )
    );
  }

  // ---- 絶対条件: resolved後のacknowledgeはno_op(後退しない、reopeningはM0.5で未実装) ----
  {
    const client = makeFakeAttentionClient([makeFakeRow({ status: "resolved", resolved_at: "2026-09-20T00:02:00.000Z", resolved_by: "user-1" })]);
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "acknowledge", depsFor(client));

    results.push(
      check(
        "[絶対条件] resolved状態でのacknowledge試行はno_opであり、statusをacknowledgedへ後退させない",
        outcome.status === "no_op" && outcome.attention.status === "resolved"
      )
    );
  }

  // ---- 絶対条件(race再現): open状態から、Aがresolveへ、続けてBがacknowledgeへ「読んだ古いstatusに基づいて」試みても、
  // 単一conditional UPDATE文自体がCAS条件であるため、resolvedは後退しない ----
  {
    const client = makeFakeAttentionClient([makeFakeRow()]); // open

    // A: open -> resolved (成功、実際にstatusがresolvedへ変わる)
    const outcomeA = await transitionExecutionAttention("attention-1", "user-1", "resolve", depsFor(client));

    // B: 「openだった時点を見て」acknowledgeを計画していたが、実際に書き込む時点では
    // Aのresolveが既にcommit済み——BのUPDATE文自身のWHERE句(status='open')は
    // 今のDBの実際の状態(resolved)に対して評価されるため、0件affectedになる。
    const outcomeB = await transitionExecutionAttention("attention-1", "user-1", "acknowledge", depsFor(client));

    results.push(
      check(
        "[絶対条件/race] read-then-writeではなく単一conditional UPDATE(CAS)であるため、" +
          "先に確定したresolvedが後から到着したacknowledge試行によって後退しない",
        outcomeA.status === "transitioned" && outcomeA.attention.status === "resolved" &&
          outcomeB.status === "no_op" && outcomeB.attention.status === "resolved" &&
          outcomeB.attention.id === outcomeA.attention.id
      )
    );
  }

  // ---- tenant isolation: 他userによる遷移試行はnot_found ----
  {
    const client = makeFakeAttentionClient([makeFakeRow({ user_id: "user-1" })]);
    const outcome = await transitionExecutionAttention("attention-1", "attacker", "acknowledge", depsFor(client));

    results.push(check("[Tenant isolation] 他userによる遷移試行はnot_foundを返す(所有権チェック、存在有無を漏らさない)", outcome.status === "not_found"));

    // 実際に変更されていないことも確認する。
    const stillOpen = (client as unknown as { __rows: Map<string, FakeAttentionRow> }).__rows.get("attention-1");
    results.push(check("[Tenant isolation] 他userの試行は実際には何も変更しない", stillOpen?.status === "open"));
  }

  // ---- 存在しないattentionId ----
  {
    const client = makeFakeAttentionClient([]);
    const outcome = await transitionExecutionAttention("does-not-exist", "user-1", "acknowledge", depsFor(client));

    results.push(check("[NotFound] 存在しないattentionIdはnot_foundを返す", outcome.status === "not_found"));
  }

  // ---- 同一Attention idがtransitioned/no_opいずれでも常に保持される ----
  {
    const client = makeFakeAttentionClient([makeFakeRow({ id: "attention-fixed" })]);
    const first = await transitionExecutionAttention("attention-fixed", "user-1", "acknowledge", depsFor(client));
    const second = await transitionExecutionAttention("attention-fixed", "user-1", "resolve", depsFor(client));
    const third = await transitionExecutionAttention("attention-fixed", "user-1", "resolve", depsFor(client));

    results.push(
      check(
        "[絶対条件] 遷移によって新しいAttention行が作られることはなく、同一idが常に保持される",
        first.status === "transitioned" && first.attention.id === "attention-fixed" &&
          second.status === "transitioned" && second.attention.id === "attention-fixed" &&
          third.status === "no_op" && third.attention.id === "attention-fixed"
      )
    );
  }

  // ---- fail closed: service role未設定 ----
  {
    const deps: TransitionExecutionAttentionDeps = { getClient: () => null };
    const outcome = await transitionExecutionAttention("attention-1", "user-1", "acknowledge", deps);
    results.push(check("[Fail closed] service role未設定環境ではunavailableを返す", outcome.status === "unavailable"));
  }

  return summarize("SOR-48 — Attention Lifecycle Transition (CAS)", results);

}
