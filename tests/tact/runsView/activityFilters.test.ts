// =========================
// TACT Runs UI — SOR-23 Activity Filters (OBS-UX-P1)
// =========================
//
// 対象: core/tact-runs-view/index.tsのfilterActivityItems()/
// distinctActivityFilterOptions()。DBアクセス無し、純粋なclient-side
// filter判定のみ(SOR-23指示「No business logic in React」の延長
// ——判定はcomponentではなくこのpure関数に集約する)。

import { filterActivityItems, distinctActivityFilterOptions } from "@tact/runs-core/tact-runs-view";
import type { ActivityItemView } from "@tact/runs-core/tact-runs-view";
import { check, summarize, type CheckResult } from "../lib/check";

function item(overrides: Partial<ActivityItemView> = {}): ActivityItemView {
  return {
    executionId: "exec-1",
    observedAt: "2026-09-24T12:00:00.000Z",
    principalLabel: "Sora",
    agentLabel: "Claude Test Agent",
    targetSystem: { label: "Notion", subLabel: "via MCP" },
    action: "READ",
    permissionEvaluation: "MATCH",
    executionStatus: "succeeded",
    workId: null,
    workTitle: null,
    correlationStatus: "UNASSIGNED",
    isHumanCorrected: false,
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const items: ActivityItemView[] = [
    item({ executionId: "e1", agentLabel: "Claude Test Agent", principalLabel: "Sora", targetSystem: { label: "Notion", subLabel: null }, correlationStatus: "CORRELATED", observedAt: "2026-09-20T00:00:00.000Z" }),
    item({ executionId: "e2", agentLabel: "Codex Agent", principalLabel: "Sora", targetSystem: { label: "Slack", subLabel: null }, correlationStatus: "AMBIGUOUS", observedAt: "2026-09-22T00:00:00.000Z" }),
    item({ executionId: "e3", agentLabel: "Claude Test Agent", principalLabel: "田中", targetSystem: { label: "Notion", subLabel: null }, correlationStatus: "UNASSIGNED", permissionEvaluation: "MISMATCH", executionStatus: "failed", observedAt: "2026-09-25T00:00:00.000Z" }),
  ];

  // ---- Empty filters returns everything unchanged ----
  results.push(check(
    "[SOR-23] no filters selected returns every item, order preserved",
    JSON.stringify(filterActivityItems(items, {})) === JSON.stringify(items)
  ));

  // ---- Single-dimension filters (Agent / Principal / SaaS / Permission / Result / Correlation status) ----
  results.push(check(
    "[SOR-23] agentLabel filter narrows to exactly the matching rows (Multi-dimensional traceability: same executions findable by Agent)",
    filterActivityItems(items, { agentLabel: "Claude Test Agent" }).map((i) => i.executionId).join(",") === "e1,e3"
  ));

  results.push(check(
    "[SOR-23] principalLabel filter (traceability by Principal/User)",
    filterActivityItems(items, { principalLabel: "田中" }).map((i) => i.executionId).join(",") === "e3"
  ));

  results.push(check(
    "[SOR-23] providerLabel filter (traceability by SaaS)",
    filterActivityItems(items, { providerLabel: "Slack" }).map((i) => i.executionId).join(",") === "e2"
  ));

  results.push(check(
    "[SOR-23] permissionEvaluation filter",
    filterActivityItems(items, { permissionEvaluation: "MISMATCH" }).map((i) => i.executionId).join(",") === "e3"
  ));

  results.push(check(
    "[SOR-23] executionStatus filter",
    filterActivityItems(items, { executionStatus: "failed" }).map((i) => i.executionId).join(",") === "e3"
  ));

  results.push(check(
    "[SOR-23/Priority 3] correlationStatus filter surfaces exactly the Ambiguous/Unassigned rows (Unassigned/Ambiguous discoverability, no separate ledger)",
    filterActivityItems(items, { correlationStatus: "AMBIGUOUS" }).map((i) => i.executionId).join(",") === "e2" &&
      filterActivityItems(items, { correlationStatus: "UNASSIGNED" }).map((i) => i.executionId).join(",") === "e3"
  ));

  // ---- Time range (inclusive both ends) ----
  results.push(check(
    "[SOR-23] observedFrom/observedTo date-range filter is inclusive of both boundary days",
    filterActivityItems(items, { observedFrom: "2026-09-20", observedTo: "2026-09-22" }).map((i) => i.executionId).join(",") === "e1,e2"
  ));

  // ---- Combined filters (AND semantics) ----
  results.push(check(
    "[SOR-23] multiple filters combine with AND semantics",
    filterActivityItems(items, { agentLabel: "Claude Test Agent", correlationStatus: "UNASSIGNED" }).map((i) => i.executionId).join(",") === "e3"
  ));

  // ---- No match -> empty array, never fabricated/never throws ----
  results.push(check(
    "[SOR-23] a filter combination matching nothing returns an empty array",
    filterActivityItems(items, { agentLabel: "Codex Agent", correlationStatus: "CORRELATED" }).length === 0
  ));

  // ---- distinctActivityFilterOptions: options come only from observed data ----
  const options = distinctActivityFilterOptions(items);
  results.push(check(
    "[SOR-23] filter options are derived only from currently-loaded items, sorted, deduplicated — never hardcoded",
    JSON.stringify(options.agentLabels) === JSON.stringify(["Claude Test Agent", "Codex Agent"]) &&
      JSON.stringify(options.principalLabels) === JSON.stringify(["Sora", "田中"]) &&
      JSON.stringify(options.providerLabels) === JSON.stringify(["Notion", "Slack"])
  ));

  results.push(check(
    "[SOR-23] distinctActivityFilterOptions on an empty list returns empty option sets, never throws",
    JSON.stringify(distinctActivityFilterOptions([])) === JSON.stringify({ agentLabels: [], principalLabels: [], providerLabels: [] })
  ));

  return summarize("TACT Runs UI — SOR-23 Activity Filters", results);

}
