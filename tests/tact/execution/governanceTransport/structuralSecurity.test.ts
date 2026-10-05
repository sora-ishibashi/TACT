// =========================
// SOR-138 Slice 3A-1 — Governance Transport Structural Security
// =========================
//
// Source-text scans (same technique as
// tests/tact/execution/governance/approvalRequestImmutability.test.ts and
// tests/tact/execution/runsCoreForbiddenDependency.test.ts) proving the new
// files this slice adds respect the dependency-direction and
// credential-isolation boundaries the design audit requires:
//
//   - the Composio provider adapter stays unaware that Runs governance
//     exists at all (core/tact-integration/execution.ts -> {gateway.ts,
//     runsGovernance.ts} as siblings; neither sibling imports the other)
//   - the root governance client never references the existing projection
//     bearer token, Composio, or provider-connection identifiers
//   - the standalone governance routes/auth never reference Composio or
//     the existing projection bearer token
//
// The broader, pre-existing bidirectional isolation guarantees (root never
// imports products/yolna-runs, products/yolna-runs never imports root
// Yolna application code, packages/runs-core never imports Yolna runtime)
// are already enforced by scripts/verify/rootForbiddenStandaloneImport.ts,
// scripts/verify/standaloneForbiddenImports.ts, and
// tests/tact/execution/runsCoreForbiddenDependency.test.ts respectively —
// this file does not duplicate those, it only adds the narrower checks
// specific to the new files this slice introduces.

import * as fs from "node:fs";
import * as path from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readIfExists(relPath: string): string {
  const abs = path.join(REPO_ROOT, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
}

// Strips // line comments and /* */ block comments before a forbidden-text
// scan. Without this, a file's own explanatory header comment — e.g. "this
// never compares against RUNS_PROJECTION_INGESTION_TOKEN" or "Yolna calls
// Composio and reports the result..." — would trip a naive substring check
// even though the comment is exactly the kind of cross-referencing
// documentation this codebase's existing files already rely on (see e.g.
// lib/projection/ingestionAuth.ts's own header, which names SOR-8 by
// number). A real forbidden CODE reference (import, process.env access,
// package specifier) survives this strip; a prose mention in a comment does
// not. Naive, not a full tokenizer (does not handle comment-like sequences
// inside string literals) — sufficient for this repo's own source style,
// consistent with the precision every other static scan test here already
// accepts (e.g. approvalRequestImmutability.test.ts's own line-window scan).
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function readCodeOnly(relPath: string): string {
  return stripComments(readIfExists(relPath));
}

function listFiles(relDir: string): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(childRel));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(childRel);
    }
  }
  return out;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const composioFiles = listFiles("core/tact-integration/providers/composio");
  const composioReferencesRunsGovernance = composioFiles.filter((f) => readCodeOnly(f).includes("runsGovernance"));
  results.push(check(
    "Composio provider adapter files never reference runsGovernance",
    composioFiles.length > 0 && composioReferencesRunsGovernance.length === 0,
    composioReferencesRunsGovernance.length > 0 ? composioReferencesRunsGovernance.join(", ") : undefined
  ));

  const rootClientRaw = readIfExists("core/tact-integration/runsGovernance.ts");
  const rootClient = readCodeOnly("core/tact-integration/runsGovernance.ts");
  results.push(check("root governance client file exists", rootClientRaw.length > 0));
  results.push(check("root governance client never references RUNS_PROJECTION_INGESTION_TOKEN outside comments", !rootClient.includes("RUNS_PROJECTION_INGESTION_TOKEN")));
  results.push(check("root governance client never references Composio outside comments", !/composio/i.test(rootClient)));
  results.push(check("root governance client never references providerConnectionRef", !rootClientRaw.includes("providerConnectionRef")));
  results.push(check("root governance client never references a Supabase service-role credential", !/service[_-]?role[_-]?key/i.test(rootClientRaw)));

  const preflightRouteRaw = readIfExists("products/yolna-runs/app/api/tact/runs/governance/preflight/route.ts");
  const completeRouteRaw = readIfExists("products/yolna-runs/app/api/tact/runs/governance/complete/route.ts");
  const governanceAuthRaw = readIfExists("products/yolna-runs/lib/governance/runsGovernanceAuth.ts");
  const preflightRoute = readCodeOnly("products/yolna-runs/app/api/tact/runs/governance/preflight/route.ts");
  const completeRoute = readCodeOnly("products/yolna-runs/app/api/tact/runs/governance/complete/route.ts");
  const governanceAuth = readCodeOnly("products/yolna-runs/lib/governance/runsGovernanceAuth.ts");

  results.push(check("standalone governance preflight route exists", preflightRouteRaw.length > 0));
  results.push(check("standalone governance complete route exists", completeRouteRaw.length > 0));
  results.push(check("standalone governance auth file exists", governanceAuthRaw.length > 0));

  results.push(check("governance preflight route never references Composio outside comments", !/composio/i.test(preflightRoute)));
  results.push(check("governance complete route never references Composio outside comments", !/composio/i.test(completeRoute)));
  results.push(check("governance auth never references RUNS_PROJECTION_INGESTION_TOKEN outside comments", !governanceAuth.includes("RUNS_PROJECTION_INGESTION_TOKEN")));
  results.push(check("governance preflight route never references RUNS_PROJECTION_INGESTION_TOKEN outside comments", !preflightRoute.includes("RUNS_PROJECTION_INGESTION_TOKEN")));
  results.push(check("governance complete route never references RUNS_PROJECTION_INGESTION_TOKEN outside comments", !completeRoute.includes("RUNS_PROJECTION_INGESTION_TOKEN")));

  // No new migration this slice (3A-1 scope — see both route/auth header
  // comments). A new tact_governance_callers/tact_governance_caller_keys
  // table is explicitly future work, not this slice's.
  const migrationsDir = path.join(REPO_ROOT, "products/yolna-runs/supabase/migrations");
  const migrationFiles = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir) : [];
  const newGovernanceCallerMigration = migrationFiles.some((f) => /governance_caller/i.test(f));
  results.push(check("no tact_governance_callers/caller_keys migration was added in this slice", !newGovernanceCallerMigration));

  return summarize("execution/governanceTransport/structuralSecurity", results);

}
