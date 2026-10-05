// =========================
// SOR-138 Slice 3A-1 — Governance Signature Canonical String
// =========================
//
// Tests buildGovernanceSignatureCanonicalString() (@tact/execution-contract)
// in isolation — a pure string-formatting function, no crypto, no network,
// no DB. The actual HMAC sign/verify round-trip is covered separately in
// rootClient.test.ts (root signer, via fake fetch) and in
// products/yolna-runs/scripts/runsGovernanceAuth.test.ts (standalone
// verifier) — this file only proves the shared format itself is
// deterministic and unambiguous.

import { buildGovernanceSignatureCanonicalString, type GovernanceSignatureCanonicalInput } from "@tact/execution-contract";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeInput(overrides: Partial<GovernanceSignatureCanonicalInput> = {}): GovernanceSignatureCanonicalInput {
  return {
    method: "POST",
    pathname: "/api/tact/runs/governance/preflight",
    callerId: "caller-a",
    keyId: "key-1",
    timestamp: "1735689600",
    bodySha256Hex: "a".repeat(64),
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // [1] deterministic output
  {
    const a = buildGovernanceSignatureCanonicalString(makeInput());
    const b = buildGovernanceSignatureCanonicalString(makeInput());
    results.push(check("[1] canonical string is deterministic for identical input", a === b));
  }

  // [2] method is uppercased/canonicalized exactly once
  {
    const lower = buildGovernanceSignatureCanonicalString(makeInput({ method: "post" }));
    const upper = buildGovernanceSignatureCanonicalString(makeInput({ method: "POST" }));
    const mixed = buildGovernanceSignatureCanonicalString(makeInput({ method: "PoSt" }));
    results.push(check(
      "[2] method is canonicalized (case-insensitive input) to the same output",
      lower === upper && upper === mixed && lower.includes("\nPOST\n")
    ));
  }

  // [3] pathname, not full host URL, is signed
  {
    const canonical = buildGovernanceSignatureCanonicalString(makeInput({ pathname: "/api/tact/runs/governance/preflight" }));
    results.push(check(
      "[3] canonical string carries only the pathname, never a host/origin",
      canonical.includes("/api/tact/runs/governance/preflight") &&
      !canonical.includes("http://") &&
      !canonical.includes("https://")
    ));
  }

  // [4] body digest participates in the canonical string
  {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const a = buildGovernanceSignatureCanonicalString(makeInput({ bodySha256Hex: digestA }));
    const b = buildGovernanceSignatureCanonicalString(makeInput({ bodySha256Hex: digestB }));
    results.push(check("[4] a changed body digest changes the canonical string", a !== b && a.includes(digestA) && b.includes(digestB)));
  }

  // [5] callerId / keyId / timestamp participate in the canonical string
  {
    const base = buildGovernanceSignatureCanonicalString(makeInput());
    const changedCaller = buildGovernanceSignatureCanonicalString(makeInput({ callerId: "caller-b" }));
    const changedKey = buildGovernanceSignatureCanonicalString(makeInput({ keyId: "key-2" }));
    const changedTimestamp = buildGovernanceSignatureCanonicalString(makeInput({ timestamp: "1735689601" }));
    results.push(check(
      "[5] callerId/keyId/timestamp each independently change the canonical string",
      base !== changedCaller && base !== changedKey && base !== changedTimestamp
    ));
  }

  return summarize("execution/governanceTransport/canonicalString", results);

}
