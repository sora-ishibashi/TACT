// =========================
// SOR-138 Slice 3A-2 — Direct Execution Gate Structural Checks
// =========================
//
// Source-text scans (same technique as
// tests/tact/execution/governanceTransport/structuralSecurity.test.ts and
// tests/tact/execution/governance/approvalRequestImmutability.test.ts)
// proving two invariants this slice introduces that are not otherwise
// enforced by any existing automated check:
//
//   1. core/tact-integration/execution.ts imports the Runs governance
//      client only from ./runsGovernance — never packages/runs-core or
//      products/yolna-runs, and never duplicates HMAC/transport logic
//      itself — and never calls callRunsGovernanceComplete() (Slice 3A-3).
//   2. core/tact-conversation/orchestration.ts's
//      executeReadIntegrationActionWithRuntimeRouting() checks the
//      governance gate BEFORE resolving the Trigger.dev runtime adapter —
//      this ordering is the entire mechanism by which governance takes
//      precedence over Runtime routing (SOR-138 Slice 3A-2 Section 3), and
//      nothing else in the type system enforces it; a future reordering
//      would silently resurrect ungoverned Trigger.dev dispatch for this
//      action.
//
// The broader, pre-existing import-direction guarantees (root never
// imports products/yolna-runs, packages/runs-core never imports Yolna
// runtime) are already enforced by scripts/verify/rootForbiddenStandaloneImport.ts
// and tests/tact/execution/runsCoreForbiddenDependency.test.ts — this file
// only adds the narrower checks specific to this slice's new call sites.

import * as fs from "node:fs";
import * as path from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function read(relPath: string): string {
  const abs = path.join(REPO_ROOT, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const executionTs = read("core/tact-integration/execution.ts");
  results.push(check("execution.ts exists", executionTs.length > 0));

  const importLines = executionTs
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line));

  const runsGovernanceImportLines = importLines.filter((line) => line.includes("runsGovernance"));
  results.push(check(
    "execution.ts has exactly one runtime import line referencing runsGovernance, and it is a relative ./runsGovernance import",
    runsGovernanceImportLines.length === 1 && /from\s+["']\.\/runsGovernance["']/.test(runsGovernanceImportLines[0])
  ));

  const forbiddenRuntimeImports = importLines.filter((line) =>
    /from\s+["'][^"']*(packages\/runs-core|@tact\/runs-core|products\/yolna-runs)[^"']*["']/.test(line)
  );
  results.push(check(
    "execution.ts has zero runtime imports of packages/runs-core or products/yolna-runs",
    forbiddenRuntimeImports.length === 0
  ));

  const executionCodeOnly = stripComments(executionTs);
  results.push(check(
    "execution.ts never references callRunsGovernanceComplete (Slice 3A-3, not this slice)",
    !executionCodeOnly.includes("callRunsGovernanceComplete")
  ));
  results.push(check(
    "execution.ts's governance Preflight envelope construction never references providerConnectionRef in the same statement context",
    !/runsGovernancePreflight\(\{[\s\S]{0,600}providerConnectionRef/.test(executionCodeOnly)
  ));
  results.push(check(
    "execution.ts does not itself implement HMAC/createHmac (must call through runsGovernance.ts, never duplicate transport logic)",
    !executionCodeOnly.includes("createHmac")
  ));

  const orchestrationTs = read("core/tact-conversation/orchestration.ts");
  results.push(check("orchestration.ts exists", orchestrationTs.length > 0));

  const orchestrationCodeOnly = stripComments(orchestrationTs);
  const fnMatch = orchestrationCodeOnly.match(
    /executeReadIntegrationActionWithRuntimeRouting[\s\S]*?=\s*async\s*\([\s\S]*?\)\s*=>\s*\{([\s\S]*?)\n\};/
  );
  const fnBody = fnMatch ? fnMatch[1] : "";

  results.push(check(
    "executeReadIntegrationActionWithRuntimeRouting() body was located for the ordering check",
    fnBody.length > 0
  ));

  const governanceCheckIndex = fnBody.indexOf("isRunsGovernanceSlackListChannelsEnabled(");
  const runtimeResolveIndex = fnBody.indexOf("resolveRuntimeIntegrationReadAdapter(");

  results.push(check(
    "isRunsGovernanceSlackListChannelsEnabled() is checked BEFORE resolveRuntimeIntegrationReadAdapter() — the entire mechanism by which governance preempts Trigger.dev routing for this action",
    governanceCheckIndex >= 0 && runtimeResolveIndex >= 0 && governanceCheckIndex < runtimeResolveIndex
  ));

  return summarize("execution/governanceTransport/directExecutionGateStructural", results);

}
