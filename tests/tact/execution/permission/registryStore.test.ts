// =========================
// TACT Canonical Execution — Permission Registry Store Regression (SOR-47)
// =========================
//
// 対象: core/tact-execution/permission/registryStore.tsのCRUD操作。
// tests/tact/execution/permission/store.test.tsと同じ方針(実Supabase
// 接続は一切行わない)だが、tenant isolation(所有権check)自体を
// 検証するには単純な「固定応答queue」では不十分なため、この file専用
// の最小限in-memory fake client(filters+union+unique制約simulation)
// をdeps injection(既存store.ts/attentionStore.tsと同じ既存pattern)
// 経由で実際のregistryStore.ts関数へ注入する——手動での再実装ではなく、
// 実際のcreatePermissionRule()/updatePermissionRule()等そのものを
// 検証する。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createPermissionRule,
  updatePermissionRule,
  disablePermissionRule,
  deletePermissionRule,
  listActivePermissionRulesForMatching,
  listOwnedPermissionRules,
  validatePermissionRuleInput,
  RegistryUnavailableError,
  type PermissionRegistryStoreDeps,
} from "../../../../core/tact-execution/permission/registryStore";
import type { PermissionRegistryRuleInput } from "../../../../core/tact-execution/permission/types";
import { check, summarize, type CheckResult } from "../../lib/check";

// =========================
// Minimal in-memory fake (filters + OR union + unique-identifier
// simulation)
// =========================

interface FakeRow {
  id: string;
  user_id: string | null;
  identifier: string;
  revision: number;
  enabled: boolean;
  [key: string]: unknown;
}

function makeFakeRegistryClient(initialRows: FakeRow[] = []) {

  const rows = new Map<string, FakeRow>(initialRows.map((r) => [r.id, { ...r }]));
  let idCounter = 1;

  function identifierConflicts(candidate: FakeRow, excludeId?: string): boolean {
    for (const row of rows.values()) {
      if (excludeId && row.id === excludeId) continue;
      if (row.identifier !== candidate.identifier) continue;
      if (candidate.user_id === null && row.user_id === null) return true;
      if (candidate.user_id !== null && row.user_id === candidate.user_id) return true;
    }
    return false;
  }

  function fromTable() {

    const filters: Array<[string, unknown]> = [];
    let orClauses: Array<[string, string, string]> | null = null;
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertPayload: Record<string, unknown> | null = null;
    let updatePayload: Record<string, unknown> | null = null;

    function rowMatches(row: FakeRow): boolean {
      if (!filters.every(([col, val]) => (row as Record<string, unknown>)[col] === val)) return false;
      if (orClauses) {
        return orClauses.some(([field, op, value]) => {
          if (op === "is" && value === "null") return (row as Record<string, unknown>)[field] === null;
          if (op === "eq") return String((row as Record<string, unknown>)[field]) === value;
          return false;
        });
      }
      return true;
    }

    function resolveList(): { data: FakeRow[]; error: unknown } {

      if (mode === "insert" && insertPayload) {

        const candidate: FakeRow = {
          id: `row-${idCounter++}`,
          revision: 1,
          enabled: true,
          ...insertPayload,
        } as FakeRow;

        if (identifierConflicts(candidate)) {
          return { data: [], error: { code: "23505", message: "duplicate key" } };
        }

        rows.set(candidate.id, candidate);
        return { data: [candidate], error: null };

      }

      if (mode === "update" && updatePayload) {

        const found = [...rows.values()].find(rowMatches);

        if (!found) {
          return { data: [], error: null };
        }

        const candidate: FakeRow = { ...found, ...updatePayload };

        if (typeof updatePayload.identifier === "string" && identifierConflicts(candidate, found.id)) {
          return { data: [], error: { code: "23505", message: "duplicate key" } };
        }

        rows.set(found.id, candidate);
        return { data: [candidate], error: null };

      }

      if (mode === "delete") {

        const found = [...rows.values()].find(rowMatches);

        if (!found) {
          return { data: [], error: null };
        }

        rows.delete(found.id);
        return { data: [{ id: found.id } as FakeRow], error: null };

      }

      return { data: [...rows.values()].filter(rowMatches), error: null };

    }

    async function resolveSingle(): Promise<{ data: FakeRow | null; error: unknown }> {
      const { data, error } = resolveList();
      return { data: data[0] ?? null, error };
    }

    const builder = {
      select: () => builder,
      insert: (payload: Record<string, unknown>) => {
        mode = "insert";
        insertPayload = payload;
        return builder;
      },
      update: (payload: Record<string, unknown>) => {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      delete: () => {
        mode = "delete";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      or: (expr: string) => {
        orClauses = expr.split(",").map((clause) => {
          const [field, op, value] = clause.split(".");
          return [field, op, value] as [string, string, string];
        });
        return builder;
      },
      order: () => builder,
      single: () => resolveSingle(),
      maybeSingle: () => resolveSingle(),
      then: (resolve: (v: { data: FakeRow[]; error: unknown }) => unknown) => resolve(resolveList()),
    };

    return builder;

  }

  return {
    from: () => fromTable(),
    __rows: rows,
  } as unknown as SupabaseClient & { __rows: Map<string, FakeRow> };

}

function depsFor(client: SupabaseClient): PermissionRegistryStoreDeps {
  return { getClient: () => client };
}

function baseInput(overrides: Partial<PermissionRegistryRuleInput> = {}): PermissionRegistryRuleInput {
  return {
    identifier: "tenant-notion-write-allowed",
    decision: "allowed",
    reasonCode: "tenant_custom_notion_write_allowed",
    subjectKind: "ai_agent",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- validatePermissionRuleInput ----
  {
    results.push(check("[Validate] 最小限の必須fieldのみでも有効", validatePermissionRuleInput(baseInput()).ok));
    results.push(check("[Validate] 不正なdecision値は拒否される", validatePermissionRuleInput(baseInput({ decision: "maybe" as never })).ok === false));
    results.push(check("[Validate] 未知のsubjectKind値は拒否される", validatePermissionRuleInput(baseInput({ subjectKind: "robot" as never })).ok === false));
    results.push(
      check(
        "[Validate] validFrom >= validUntilは拒否される([valid_from, valid_until)半開区間の矛盾)",
        validatePermissionRuleInput(baseInput({ validFrom: "2026-01-02T00:00:00.000Z", validUntil: "2026-01-01T00:00:00.000Z" })).ok === false
      )
    );
    results.push(check("[Validate] 空identifierは拒否される", validatePermissionRuleInput(baseInput({ identifier: "" })).ok === false));
  }

  // ---- createPermissionRule: success, always user_id=caller, duplicate rejection ----
  {
    const client = makeFakeRegistryClient();
    const deps = depsFor(client);

    const created = await createPermissionRule("user-1", baseInput(), deps);
    results.push(check("[Create] 有効な入力はcreatedを返す", created.status === "created" && created.status === "created" && created.rule.userId === "user-1"));

    const dup = await createPermissionRule("user-1", baseInput(), deps);
    results.push(check("[Create/Duplicate-tenant] 同一userでの同一identifierはduplicate_identifierを返す", dup.status === "duplicate_identifier"));

    const otherUserSameIdentifier = await createPermissionRule("user-2", baseInput(), deps);
    results.push(check("[Create/Scope] 別userなら同一identifierでも作成できる(tenant-scoped uniqueness)", otherUserSameIdentifier.status === "created"));

    const invalid = await createPermissionRule("user-1", baseInput({ decision: "x" as never }), deps);
    results.push(check("[Create/Validate] 不正な入力はDBへ到達する前にinvalidを返す", invalid.status === "invalid"));
  }

  // ---- createPermissionRule never trusts a caller-supplied user_id (type-level: no such field exists on the input) ----
  {
    const client = makeFakeRegistryClient();
    const deps = depsFor(client);
    const outcome = await createPermissionRule("legit-user", baseInput({ identifier: "spoof-test" }), deps);
    results.push(
      check(
        "[Authz] createPermissionRuleは常にcaller引数のuserIdを行のuser_idとして使う(PermissionRegistryRuleInputにuserIdフィールド自体が無い)",
        outcome.status === "created" && outcome.rule.userId === "legit-user"
      )
    );
  }

  // ---- updatePermissionRule: ownership enforcement (tenant isolation) + revision increment ----
  {
    const client = makeFakeRegistryClient([
      { id: "rule-a", user_id: "user-1", identifier: "a", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
    ]);
    const deps = depsFor(client);

    const wrongOwner = await updatePermissionRule("attacker", "rule-a", { decision: "denied" }, deps);
    results.push(check("[Tenant isolation] 他userのruleへのupdateはnot_foundを返す(所有権チェック)", wrongOwner.status === "not_found"));

    const owner = await updatePermissionRule("user-1", "rule-a", { decision: "denied", reasonCode: "changed" }, deps);
    results.push(
      check(
        "[Update] 所有者によるupdateは内容を反映しrevisionを+1する",
        owner.status === "updated" && owner.rule.decision === "denied" && owner.rule.revision === 2
      )
    );

    const again = await updatePermissionRule("user-1", "rule-a", { priority: 5 }, deps);
    results.push(check("[Revision] 2回目のupdateはrevisionを3へ増分する(常に増分、特殊ケース分岐無し)", again.status === "updated" && again.rule.revision === 3));

    const empty = await updatePermissionRule("user-1", "rule-a", {}, deps);
    results.push(check("[Validate] 空patchはinvalidを返す", empty.status === "invalid"));

    const nonexistent = await updatePermissionRule("user-1", "does-not-exist", { decision: "denied" }, deps);
    results.push(check("[NotFound] 存在しないruleIdへのupdateはnot_foundを返す", nonexistent.status === "not_found"));
  }

  // ---- updatePermissionRule: identifier collision on rename ----
  {
    const client = makeFakeRegistryClient([
      { id: "rule-a", user_id: "user-1", identifier: "a", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
      { id: "rule-b", user_id: "user-1", identifier: "b", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
    ]);
    const deps = depsFor(client);

    const renameToExisting = await updatePermissionRule("user-1", "rule-b", { identifier: "a" }, deps);
    results.push(check("[Duplicate/rename] 既存の別ruleと同じidentifierへのrenameはduplicate_identifierを返す", renameToExisting.status === "duplicate_identifier"));
  }

  // ---- disablePermissionRule: soft-disable, ownership-enforced, revision increments ----
  {
    const client = makeFakeRegistryClient([
      { id: "rule-a", user_id: "user-1", identifier: "a", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
    ]);
    const deps = depsFor(client);

    const wrongOwner = await disablePermissionRule("attacker", "rule-a", deps);
    results.push(check("[Tenant isolation] 他userによるdisableはnot_foundを返す", wrongOwner.status === "not_found"));

    const disabled = await disablePermissionRule("user-1", "rule-a", deps);
    results.push(
      check(
        "[Disable] 所有者によるdisableはenabled=falseへ変更しrevisionを増分する(hard deleteせず監査証跡を残す)",
        disabled.status === "disabled" && disabled.rule.enabled === false && disabled.rule.revision === 2
      )
    );
  }

  // ---- deletePermissionRule: hard delete, ownership-enforced ----
  {
    const client = makeFakeRegistryClient([
      { id: "rule-a", user_id: "user-1", identifier: "a", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
    ]);
    const deps = depsFor(client);

    const wrongOwner = await deletePermissionRule("attacker", "rule-a", deps);
    results.push(check("[Tenant isolation] 他userによるdeleteはnot_foundを返す(実際には削除されない)", wrongOwner.status === "not_found"));

    const stillListed = await listOwnedPermissionRules("user-1", deps);
    results.push(check("[Tenant isolation] 他userによるdelete試行後もruleは存在し続ける", stillListed.length === 1));

    const owner = await deletePermissionRule("user-1", "rule-a", deps);
    results.push(check("[Delete] 所有者によるdeleteはdeletedを返す", owner.status === "deleted"));

    const afterDelete = await listOwnedPermissionRules("user-1", deps);
    results.push(check("[Delete] delete後は一覧から消える", afterDelete.length === 0));
  }

  // ---- listActivePermissionRulesForMatching: tenant + global union, other tenants excluded, disabled excluded ----
  {
    const client = makeFakeRegistryClient([
      { id: "rule-tenant", user_id: "user-1", identifier: "t", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
      { id: "rule-global", user_id: null, identifier: "g", revision: 1, enabled: true, decision: "denied", reason_code: "r" },
      { id: "rule-other-tenant", user_id: "user-2", identifier: "o", revision: 1, enabled: true, decision: "allowed", reason_code: "r" },
      { id: "rule-disabled", user_id: "user-1", identifier: "d", revision: 1, enabled: false, decision: "allowed", reason_code: "r" },
    ]);
    const deps = depsFor(client);

    const active = await listActivePermissionRulesForMatching("user-1", deps);
    const ids = active.map((r) => r.id).sort();

    results.push(
      check(
        "[Matching source] tenant行+global行のみ含み、他tenant行・disabled行は含まない",
        ids.length === 2 && ids.includes("rule-tenant") && ids.includes("rule-global")
      )
    );
  }

  // ---- SOR-47 Phase2(絶対条件): query自体のerror(network/DB障害の模擬)もRegistryUnavailableErrorをthrowする
  // (「0件match」(正常)と「読み込み自体が失敗した」を混同しない) ----
  {
    const erroringClient = {
      from: () => ({
        select: () => ({
          or: () => ({
            eq: async () => ({ data: null, error: { message: "simulated network failure" } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    let threwOnQueryError = false;
    try {
      await listActivePermissionRulesForMatching("user-1", depsFor(erroringClient));
    } catch (error) {
      threwOnQueryError = error instanceof RegistryUnavailableError;
    }

    results.push(
      check(
        "[Phase2/絶対条件] query自体のerror(network/DB障害)もRegistryUnavailableErrorをthrowする(空配列へ静かにfallbackしない)",
        threwOnQueryError
      )
    );
  }

  // ---- fail-closed: service role unavailable (getClient() -> null) ----
  {
    const deps: PermissionRegistryStoreDeps = { getClient: () => null };

    // SOR-47 Phase2(Evaluator Cutover、絶対条件): listActivePermissionRulesForMatching()は
    // live observation pathのdefault評価器が使う唯一の入力sourceであるため、Phase2からは
    // 空配列へfail closedせず、RegistryUnavailableErrorをthrowする——「registryが読めなかった」
    // ことを「matchするruleが無かった」(正当なunknown decision)へ静かに変換しないため
    // (listOwnedPermissionRules()はCRUD一覧用途でありPhase2のscope外、意図的に空配列のまま
    // 変更しない、下記参照)。
    let threwRegistryUnavailable = false;
    try {
      await listActivePermissionRulesForMatching("user-1", deps);
    } catch (error) {
      threwRegistryUnavailable = error instanceof RegistryUnavailableError;
    }
    results.push(
      check(
        "[Phase2/絶対条件] service role未設定環境ではlistActivePermissionRulesForMatchingはRegistryUnavailableErrorをthrowする(空配列を返さない)",
        threwRegistryUnavailable
      )
    );

    const owned = await listOwnedPermissionRules("user-1", deps);
    results.push(check("[Fail closed] service role未設定環境ではlistOwnedPermissionRulesは空配列を返す", owned.length === 0));

    const createOutcome = await createPermissionRule("user-1", baseInput(), deps);
    results.push(check("[Fail closed] service role未設定環境ではcreatePermissionRuleはunavailableを返す", createOutcome.status === "unavailable"));

    const updateOutcome = await updatePermissionRule("user-1", "rule-1", { enabled: false }, deps);
    results.push(check("[Fail closed] service role未設定環境ではupdatePermissionRuleはunavailableを返す", updateOutcome.status === "unavailable"));

    const deleteOutcome = await deletePermissionRule("user-1", "rule-1", deps);
    results.push(check("[Fail closed] service role未設定環境ではdeletePermissionRuleはunavailableを返す", deleteOutcome.status === "unavailable"));
  }

  return summarize("TACT Canonical Execution — Permission Registry Store", results);

}
