// =========================
// SOR-130 Reality Test — reporting / privacy sweep helpers
// =========================

export interface RealityTestCheck {
  label: string;
  pass: boolean;
  detail?: string;
}

export function check(label: string, pass: boolean, detail?: string): RealityTestCheck {
  return { label, pass, detail };
}

export function printReport(providerLabel: string, checks: RealityTestCheck[]): { pass: number; fail: number } {

  let pass = 0;
  let fail = 0;

  console.log(`\n=== SOR-130 Reality Test — ${providerLabel} ===`);

  for (const c of checks) {
    if (c.pass) {
      pass++;
    } else {
      fail++;
    }
    console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.label}${c.detail ? ` (${c.detail})` : ""}`);
  }

  console.log(`${providerLabel}: ${pass} passed, ${fail} failed`);

  return { pass, fail };

}

/**
 * Privacy sweep: confirms none of the given forbidden substrings (raw page
 * titles, message text, tokens, issue bodies, etc.) leaked into the
 * persisted canonical execution row.
 */
export function privacySweep(row: unknown, forbiddenSubstrings: string[]): RealityTestCheck {

  const serialized = JSON.stringify(row ?? {});
  const leaked = forbiddenSubstrings.filter((s) => s.length > 0 && serialized.includes(s));

  return check(
    "[privacy sweep] persisted execution row contains no raw payload substrings",
    leaked.length === 0,
    leaked.length > 0 ? `leaked substrings found: ${leaked.length}` : undefined
  );

}
