// =========================
// TACT Canonical Execution — Integration & Observation Registry Store Regression (SOR-14)
// =========================
//
// 対象: core/tact-execution/registry/store.tsのlistObservationCapabilities()
// /getObservationCapability()。実Supabase接続は行わず、tests/tact/
// execution/permission/registryStore.test.tsと同じ既存pattern
// (deps injection経由の最小限in-memory fake client)で検証する。

import {
  listObservationCapabilities,
  getObservationCapability,
  type ObservationRegistryStoreDeps,
} from "@tact/runs-core/tact-execution/registry/store";
import { check, summarize, type CheckResult } from "../../lib/check";

interface FakeCapabilityRow {
  id: string;
  provider: string;
  provider_label: string | null;
  observation_path: string;
  action_category: string;
  observation_mode: string | null;
  pre_execution_visible: boolean;
  can_block_or_require_approval: boolean;
  principal_attribution_available: boolean;
  principal_attribution_confidence: string | null;
  agent_attribution_available: boolean;
  agent_attribution_confidence: string | null;
  work_context_carrier: string;
  reconciliation_available: boolean;
  excludes_raw_payload: boolean;
  privacy_notes: string | null;
  credential_custody: string | null;
  verification_status: string;
  verification_note: string | null;
  connection_id: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

interface FakeRuleRow {
  id: string;
  user_id: string | null;
  enabled: boolean;
  provider: string | null;
  action_category: string | null;
  [key: string]: unknown;
}

function baseCapabilityRow(overrides: Partial<FakeCapabilityRow>): FakeCapabilityRow {
  return {
    id: `cap-${Math.random().toString(36).slice(2)}`,
    provider: "notion",
    provider_label: null,
    observation_path: "notion-mcp-v1",
    action_category: "read",
    observation_mode: "instrumented",
    pre_execution_visible: false,
    can_block_or_require_approval: true,
    principal_attribution_available: true,
    principal_attribution_confidence: "high",
    agent_attribution_available: true,
    agent_attribution_confidence: "high",
    work_context_carrier: "explicit_claim",
    reconciliation_available: false,
    excludes_raw_payload: true,
    privacy_notes: null,
    credential_custody: "user OAuth via Composio",
    verification_status: "live_verified",
    verification_note: "SOR-130",
    connection_id: null,
    created_at: "2026-09-30T00:00:00.000Z",
    updated_at: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeFakeClient(capabilityRows: FakeCapabilityRow[], ruleRows: FakeRuleRow[]) {

  function capabilityBuilder() {
    const eqFilters: Array<[string, unknown]> = [];

    const builder = {
      select() { return builder; },
      order() { return builder; },
      eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder; },
      is(col: string, val: unknown) {
        if (val === null) eqFilters.push([col, null]);
        return builder;
      },
      async maybeSingle() {
        const match = capabilityRows.find((row) =>
          eqFilters.every(([col, val]) => (row as Record<string, unknown>)[col] === val)
        );
        return { data: match ?? null, error: null };
      },
      then(resolve: (v: { data: FakeCapabilityRow[]; error: null }) => void) {
        const matches = capabilityRows.filter((row) =>
          eqFilters.every(([col, val]) => (row as Record<string, unknown>)[col] === val)
        );
        resolve({ data: matches, error: null });
      },
    };

    return builder;
  }

  function ruleBuilder() {
    const eqFilters: Array<[string, unknown]> = [];
    const orGroups: Array<[string, string, string | null]> = [];

    const builder = {
      select() { return builder; },
      eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder; },
      is(col: string, val: unknown) { eqFilters.push([col, val]); return builder; },
      or(clause: string) {
        // 例: "provider.eq.notion,provider.is.null" -> [["provider","eq","notion"],["provider","is",null]]
        const parts = clause.split(",").map((p) => {
          const [field, op, ...rest] = p.split(".");
          const value = rest.join(".");
          return [field, op, op === "is" ? null : value] as [string, string, string | null];
        });
        orGroups.push(...parts);
        return builder;
      },
      limit() { return builder; },
      then(resolve: (v: { data: Array<{ id: string }>; error: null }) => void) {

        const orByField = new Map<string, Array<[string, string | null]>>();
        for (const [field, op, value] of orGroups) {
          const list = orByField.get(field) ?? [];
          list.push([op, value]);
          orByField.set(field, list);
        }

        const matches = ruleRows.filter((row) => {
          if (!eqFilters.every(([col, val]) => (row as Record<string, unknown>)[col] === val)) {
            return false;
          }
          for (const [field, clauses] of orByField) {
            const rowVal = (row as Record<string, unknown>)[field];
            const satisfied = clauses.some(([op, value]) => (op === "is" ? rowVal === null : String(rowVal) === value));
            if (!satisfied) return false;
          }
          return true;
        });

        resolve({ data: matches.map((r) => ({ id: r.id })), error: null });
      },
    };

    return builder;
  }

  return {
    from(table: string) {
      if (table === "tact_execution_observation_registry") return capabilityBuilder();
      if (table === "tact_execution_permission_rules") return ruleBuilder();
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: 部分的coverage(Slack READ live_verified / SEND unverified)を同時に表現できる ----
  {
    const rows = [
      baseCapabilityRow({ provider: "slack", observation_path: "slack-web-api-v1", action_category: "read", verification_status: "live_verified" }),
      baseCapabilityRow({ provider: "slack", observation_path: "slack-web-api-v1", action_category: "send", verification_status: "unverified" }),
    ];

    const deps: ObservationRegistryStoreDeps = { getClient: () => makeFakeClient(rows, []) as never };
    const capabilities = await listObservationCapabilities({ provider: "slack" }, deps);

    const read = capabilities.find((c) => c.actionCategory === "read");
    const send = capabilities.find((c) => c.actionCategory === "send");

    results.push(
      check(
        "[Test1] Slack READ=live_verified / SEND=unverifiedを同一provider内で別行として同時に表現できる",
        capabilities.length === 2 && read?.verificationStatus === "live_verified" && send?.verificationStatus === "unverified"
      )
    );
  }

  // ---- Test2: GitHubのprovider='custom'はobservation failureではなく、provider_labelで実体を表現する ----
  {
    const rows = [
      baseCapabilityRow({ provider: "custom", provider_label: "github", observation_path: "github-issue-v1", action_category: "create", verification_status: "live_verified" }),
    ];

    const deps: ObservationRegistryStoreDeps = { getClient: () => makeFakeClient(rows, []) as never };
    const capabilities = await listObservationCapabilities({ provider: "custom" }, deps);

    results.push(
      check(
        "[Test2] GitHubはprovider='custom'+providerLabel='github'として表現され、verificationStatus='live_verified'を保持する(provider gapをfailure扱いしない)",
        capabilities.length === 1 && capabilities[0].providerLabel === "github" && capabilities[0].verificationStatus === "live_verified"
      )
    );
  }

  // ---- Test3: permissionPolicyConfiguredは別クエリで導出され、observationの成否とは独立 ----
  {
    const rows = [
      baseCapabilityRow({ provider: "custom", provider_label: "github", observation_path: "github-issue-v1", action_category: "read", verification_status: "live_verified" }),
    ];
    // GitHubに対するglobal ruleは1件も無い(SOR-130の実際の発見と一致)。
    const rules: FakeRuleRow[] = [
      { id: "rule-1", user_id: null, enabled: true, provider: "notion", action_category: null },
    ];

    const deps: ObservationRegistryStoreDeps = { getClient: () => makeFakeClient(rows, rules) as never };
    const capabilities = await listObservationCapabilities({ provider: "custom" }, deps);

    results.push(
      check(
        "[Test3] GitHubにpermission ruleが無い場合、permissionPolicyConfigured=falseとなり、observation自体(verification_status)には影響しない",
        capabilities.length === 1 &&
          capabilities[0].permissionPolicyConfigured === false &&
          capabilities[0].verificationStatus === "live_verified"
      )
    );
  }

  // ---- Test4: permissionPolicyConfigured=trueのケース(global wildcard ruleが存在) ----
  {
    const rows = [
      baseCapabilityRow({ provider: "notion", observation_path: "notion-mcp-v1", action_category: "read", verification_status: "live_verified" }),
    ];
    const rules: FakeRuleRow[] = [
      { id: "rule-1", user_id: null, enabled: true, provider: null, action_category: null },
    ];

    const deps: ObservationRegistryStoreDeps = { getClient: () => makeFakeClient(rows, rules) as never };
    const capabilities = await listObservationCapabilities({ provider: "notion" }, deps);

    results.push(
      check(
        "[Test4] wildcard(provider=null, action_category=null)のglobal ruleが存在すればpermissionPolicyConfigured=true",
        capabilities.length === 1 && capabilities[0].permissionPolicyConfigured === true
      )
    );
  }

  // ---- Test5: getObservationCapability()は単一rowを返す ----
  {
    const rows = [
      baseCapabilityRow({ provider: "notion", observation_path: "notion-mcp-v1", action_category: "delete", verification_status: "live_verified" }),
    ];

    const deps: ObservationRegistryStoreDeps = { getClient: () => makeFakeClient(rows, []) as never };
    const capability = await getObservationCapability("notion", "notion-mcp-v1", "delete", deps);

    results.push(
      check(
        "[Test5] getObservationCapability()は(provider, observationPath, actionCategory)で単一行を返す",
        capability !== undefined && capability.actionCategory === "delete"
      )
    );
  }

  // ---- Test6: serviceロールclientが利用不可の場合は空配列(fail closed、guessしない) ----
  {
    const deps: ObservationRegistryStoreDeps = { getClient: () => null };
    const capabilities = await listObservationCapabilities({}, deps);

    results.push(check("[Test6] service role client不可時は空配列を返す(fail closed)", Array.isArray(capabilities) && capabilities.length === 0));
  }

  return summarize("SOR-14 — Integration & Observation Registry Store", results);

}
