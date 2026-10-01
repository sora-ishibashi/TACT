// =========================
// Yolna Runs Standalone — Env / Secret Allowlist Validator (SOR-135 Phase 4A)
// =========================
//
// Run at Standalone Runs startup or in CI/CD before a deploy:
//   npm run verify:env   (inside products/yolna-runs)
//   npm run runs:verify:env   (from repo root, SOR-135 convention)
//
// Fails closed:
//   - any required var in RUNS_ENV_CONTRACT missing -> explicit error, FAIL
//   - any Yolna-owned forbidden secret present -> FAIL
//   - otherwise -> PASS
//
// Never logs a secret VALUE — only variable NAMES, in every branch below.

import { auditEnv, RUNS_ENV_CONTRACT } from "../lib/env/runtimeEnvContract";

function main(): void {

  const result = auditEnv(process.env);

  if (result.missingRequired.length > 0) {
    console.error(
      `[runsEnvAllowlist] FAIL: required env var(s) missing: ${result.missingRequired.join(", ")}`
    );
  }

  if (result.forbiddenPresent.length > 0) {
    console.error(
      "[runsEnvAllowlist] FAIL: forbidden Yolna-owned secret(s) detected in Runs runtime " +
      `(names only, values never logged): ${result.forbiddenPresent.join(", ")}`
    );
  }

  if (!result.pass) {
    process.exit(1);
  }

  const requiredNames = RUNS_ENV_CONTRACT.filter((e) => e.required).map((e) => e.name).join(", ");
  console.log(
    `[runsEnvAllowlist] PASS: all required env present (${requiredNames}), 0 forbidden Yolna secrets detected`
  );

}

main();
