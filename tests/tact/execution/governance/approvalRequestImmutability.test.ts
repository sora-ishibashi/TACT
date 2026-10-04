// =========================
// SOR-138 Slice 2A — GovernanceDecision immutability invariant
// =========================
//
// Human Owner test requirement 14: no Slice-2 code performs
// update/upsert/delete against tact_governance_decisions. Mocking cannot
// prove an absence — this is a structural, source-level check (same
// technique as tests/tact/security/preLiveSecP0.test.ts), reading the
// actual governance module source and asserting the forbidden pattern
// never appears on a line that also touches the table name.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

const FORBIDDEN_MUTATIONS = [".update(", ".upsert(", ".delete("];

// store.ts is terse, mostly one function per line — still check every
// line window rather than the whole file as one combined string, so a
// forbidden mutation call elsewhere in the file (against a DIFFERENT
// table, possibly far below) cannot produce a false positive by being
// "somewhere in the same file". A WINDOW after the table-name line
// (not just that exact line) is required: a chained Supabase call can
// legally split `.from("table")` and `.update({...})` across lines — this
// scan's own sanity check below (which checks a mutation this file
// EXPECTS to find) exists specifically to prove the window is wide
// enough to catch that real shape, not just same-line calls.
const MUTATION_SCAN_WINDOW_LINES = 8;

function assertNoMutationOnTable(source: string, tableName: string, fileLabel: string, results: CheckResult[]): void {

  const lines = source.split("\n");
  let foundTableReference = false;
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {

    if (!lines[i].includes(tableName)) continue;
    foundTableReference = true;

    const window = lines.slice(i, i + MUTATION_SCAN_WINDOW_LINES);

    for (const forbidden of FORBIDDEN_MUTATIONS) {
      if (window.some((windowLine) => windowLine.includes(forbidden))) {
        violations.push(`line ${i + 1}: ${lines[i].trim()}`);
      }
    }

  }

  results.push(check(
    `${fileLabel}: references ${tableName} at least once (sanity check — a file that never mentions the table would trivially "pass")`,
    foundTableReference
  ));

  results.push(check(
    `${fileLabel}: no .update(/.upsert(/.delete( within ${MUTATION_SCAN_WINDOW_LINES} lines of any reference to ${tableName}`,
    violations.length === 0,
    violations.length > 0 ? violations.join(" | ") : undefined
  ));

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const storeSource = readRepoFile("packages/runs-core/tact-execution/governance/store.ts");
  const contractSource = readRepoFile("packages/runs-core/tact-execution/governance/contract.ts");

  assertNoMutationOnTable(storeSource, "tact_governance_decisions", "governance/store.ts", results);
  assertNoMutationOnTable(contractSource, "tact_governance_decisions", "governance/contract.ts", results);

  // The new approval-request table IS mutated (that is its whole purpose —
  // approve/reject are legitimate UPDATEs) — this is a sanity check that
  // the scan technique above actually detects mutations when they ARE
  // expected, so a silently-broken scan cannot produce a false "no
  // violations" result for the decisions table too.
  const storeLines = storeSource.split("\n");
  const approvalRequestMutationDetected = storeLines.some((line, index) => {
    if (!line.includes("tact_governance_approval_requests")) return false;
    return storeLines.slice(index, index + MUTATION_SCAN_WINDOW_LINES).some((windowLine) => windowLine.includes(".update("));
  });

  results.push(check(
    "sanity: governance/store.ts DOES mutate tact_governance_approval_requests (proves the windowed scan technique detects a real, multi-line .update( chain, not just same-line calls)",
    approvalRequestMutationDetected
  ));

  // decision.approvalId/approvalStatus/approverKind/approverId/approvedAt
  // (types.ts) stay legacy/reserved — confirm evaluate.ts (the only
  // production builder of a GovernanceDecisionInput) still hardcodes them
  // to null rather than deriving them from any approval-request state.
  const evaluateSource = readRepoFile("packages/runs-core/tact-execution/governance/evaluate.ts");
  results.push(check(
    "evaluate.ts still hardcodes the legacy approval fields to null (never sources them from GovernanceApprovalRequest)",
    evaluateSource.includes("approvalId: null, approvalStatus: null, approverKind: null, approverId: null, approvedAt: null")
  ));

  return summarize("SOR-138 Slice 2A — GovernanceDecision immutability invariant", results);

}
