// =========================
// SOR-138 Slice 3A-2 pre-commit correction — Runtime Read Routing Decision
// =========================
//
// Pure, DI-free behavior tests for
// core/tact-conversation/orchestration.ts's decideIntegrationReadRoute().
// No Supabase, no network, no OpenAI, no Trigger.dev — every input here is
// a bare boolean/string, exactly what the review ("RUNTIME ROUTING
// TESTING" / "REQUIRED FLAG MATRIX" sections) asked for as a replacement
// for relying on source-text position alone (that structural guard still
// exists separately at
// tests/tact/execution/governanceTransport/directExecutionGateStructural.test.ts).
//
// The A-D matrix below corresponds exactly to the review's Section 9:
//   A. Governance OFF, Runtime OFF                -> legacy_direct
//   B. Governance OFF, Runtime ON + valid config   -> runtime
//   C. Governance ON,  Runtime OFF                 -> governed_direct
//   D. Governance ON,  Runtime ON                  -> governed_direct
// plus the misconfigured-runtime case (Governance OFF, Runtime ON + bad
// config -> runtime_misconfigured, fail closed, no silent direct fallback)
// and the non-eligible-action case (legacy_direct regardless of either
// flag — Runs Governance and Runtime routing are both scoped to
// slack.list_channels only).

import { decideIntegrationReadRoute } from "../../../../core/tact-conversation/orchestration";
import { check, summarize, type CheckResult } from "../../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A. Governance OFF, Runtime OFF -> legacy_direct ----
  results.push(check(
    "[A] Governance OFF, Runtime OFF -> legacy_direct",
    decideIntegrationReadRoute({
      isRuntimeEligible: true,
      isGovernanceEnabled: false,
      runtimeResolutionStatus: "disabled",
    }) === "legacy_direct"
  ));

  // ---- B. Governance OFF, Runtime ON + valid config -> runtime (existing Runtime path) ----
  results.push(check(
    "[B] Governance OFF, Runtime ON + valid config -> runtime",
    decideIntegrationReadRoute({
      isRuntimeEligible: true,
      isGovernanceEnabled: false,
      runtimeResolutionStatus: "enabled",
    }) === "runtime"
  ));

  // ---- C. Governance ON, Runtime OFF -> governed_direct ----
  results.push(check(
    "[C] Governance ON, Runtime OFF -> governed_direct (Runs Governance takes precedence)",
    decideIntegrationReadRoute({
      isRuntimeEligible: true,
      isGovernanceEnabled: true,
      runtimeResolutionStatus: "disabled",
    }) === "governed_direct"
  ));

  // ---- D. Governance ON, Runtime ON -> governed_direct ----
  results.push(check(
    "[D] Governance ON, Runtime ON -> governed_direct (Runs Governance still takes precedence over an otherwise-enabled Runtime path, until Slice 3B)",
    decideIntegrationReadRoute({
      isRuntimeEligible: true,
      isGovernanceEnabled: true,
      runtimeResolutionStatus: "enabled",
    }) === "governed_direct"
  ));

  // ---- Governance OFF, Runtime ON + bad config -> runtime_misconfigured (fail closed, no silent direct fallback) ----
  results.push(check(
    "[misconfigured] Governance OFF, Runtime flag=true but config invalid -> runtime_misconfigured (never silently legacy_direct)",
    decideIntegrationReadRoute({
      isRuntimeEligible: true,
      isGovernanceEnabled: false,
      runtimeResolutionStatus: "misconfigured",
    }) === "runtime_misconfigured"
  ));

  // ---- Not eligible for Runtime routing at all -> legacy_direct, regardless of either flag ----
  for (const isGovernanceEnabled of [false, true]) {
    for (const runtimeResolutionStatus of ["disabled", "misconfigured", "enabled"] as const) {
      results.push(check(
        `[not eligible] isRuntimeEligible=false, isGovernanceEnabled=${isGovernanceEnabled}, runtimeResolutionStatus=${runtimeResolutionStatus} -> legacy_direct`,
        decideIntegrationReadRoute({
          isRuntimeEligible: false,
          isGovernanceEnabled,
          runtimeResolutionStatus,
        }) === "legacy_direct"
      ));
    }
  }

  return summarize("execution/governanceTransport/integrationReadRoutingDecision", results);

}
