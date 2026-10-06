// =========================
// SOR-138 Slice 3A-2/3A-3 — Direct Execution Gate Structural Checks
// =========================
//
// Source-text scans (same technique as
// tests/tact/execution/governanceTransport/structuralSecurity.test.ts and
// tests/tact/execution/governance/approvalRequestImmutability.test.ts)
// proving invariants these slices introduce that are not otherwise
// enforced by any existing automated check:
//
//   1. core/tact-integration/execution.ts imports the Runs governance
//      client only from ./runsGovernance — never packages/runs-core or
//      products/yolna-runs, and never duplicates HMAC/transport logic
//      itself.
//   2. core/tact-conversation/orchestration.ts's
//      executeReadIntegrationActionWithRuntimeRouting() checks the
//      governance gate BEFORE resolving the Trigger.dev runtime adapter —
//      this ordering is the entire mechanism by which governance takes
//      precedence over Runtime routing (SOR-138 Slice 3A-2 Section 3), and
//      nothing else in the type system enforces it; a future reordering
//      would silently resurrect ungoverned Trigger.dev dispatch for this
//      action.
//   3. (Slice 3A-3) execution.ts's single runsGovernanceComplete() call
//      site never references providerConnectionRef or raw provider
//      output/result fields, and is reachable only through an optional
//      RunsGovernanceExecutionContext guard — never unconditionally.
//
// The broader, pre-existing import-direction guarantees (root never
// imports products/yolna-runs, packages/runs-core never imports Yolna
// runtime) are already enforced by scripts/verify/rootForbiddenStandaloneImport.ts
// and tests/tact/execution/runsCoreForbiddenDependency.test.ts — this file
// only adds the narrower checks specific to these slices' new call sites.

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
  results.push(check(
    "(Slice 3A-3) that single runsGovernance import line includes callRunsGovernanceComplete — the already-landed Slice 3A-1 client, reused as-is, never a second import statement",
    runsGovernanceImportLines.length === 1 && runsGovernanceImportLines[0].includes("callRunsGovernanceComplete")
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
    "execution.ts's governance Preflight envelope construction never references providerConnectionRef in the same statement context",
    !/runsGovernancePreflight\(\{[\s\S]{0,600}providerConnectionRef/.test(executionCodeOnly)
  ));
  results.push(check(
    "execution.ts does not itself implement HMAC/createHmac (must call through runsGovernance.ts, never duplicate transport logic)",
    !executionCodeOnly.includes("createHmac")
  ));

  // (Slice 3A-3) Runs Complete call-site checks.
  results.push(check(
    "(Slice 3A-3) execution.ts calls deps.runsGovernanceComplete( exactly once — a single, identifiable call site",
    (executionCodeOnly.match(/deps\.runsGovernanceComplete\(/g) || []).length === 1
  ));
  results.push(check(
    "(Slice 3A-3) execution.ts's Runs Complete call site never references providerConnectionRef in the same statement context",
    !/deps\.runsGovernanceComplete\(\{[\s\S]{0,800}providerConnectionRef/.test(executionCodeOnly)
  ));
  results.push(check(
    "(Slice 3A-3) execution.ts's Runs Complete call site never references raw provider output/result fields (result.output, providerExecutionRef) in the same statement context",
    !/deps\.runsGovernanceComplete\(\{[\s\S]{0,1200}(result\.output|providerExecutionRef)/.test(executionCodeOnly)
  ));

  const completeHelperMatch = executionCodeOnly.match(
    /async function completeRunsGovernanceBestEffort\([\s\S]*?\n}\n/
  );
  const completeHelperBody = completeHelperMatch ? completeHelperMatch[0] : "";

  results.push(check(
    "(Slice 3A-3) completeRunsGovernanceBestEffort() helper was located",
    completeHelperBody.length > 0
  ));

  const governanceContextGuardIndex = completeHelperBody.search(/if\s*\(\s*!\s*governanceContext\s*\)/);
  const completeCallIndexInHelper = completeHelperBody.indexOf("deps.runsGovernanceComplete(");

  results.push(check(
    "(Slice 3A-3) Runs Complete is reachable only through an optional governance execution context guard — an undefined governanceContext returns before the Complete call, never an unconditional call",
    governanceContextGuardIndex >= 0 &&
    completeCallIndexInHelper >= 0 &&
    governanceContextGuardIndex < completeCallIndexInHelper
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
