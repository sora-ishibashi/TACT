// =========================
// Yolna Runs Standalone — Env / Secret Allowlist Validator (SOR-135 Phase 4A)
// =========================
//
// Run at Standalone Runs startup or in CI/CD before a deploy:
//   npm run verify:env -- --mode=production   (inside products/yolna-runs)
//   npm run runs:verify:env   (from repo root, SOR-135 convention)
//
// Fails closed:
//   - any required var in RUNS_ENV_CONTRACT missing -> explicit error, FAIL
//   - any non-allowlisted sensitive/capability variable present -> FAIL
//   - otherwise -> PASS
//
// Never logs a secret VALUE — only variable NAMES, in every branch below.

import { loadEnvConfig } from "@next/env";
import { auditEnv, RUNS_ENV_CONTRACT } from "../lib/env/runtimeEnvContract";

type EnvMode = "development" | "production";

function parseMode(argv: string[]): EnvMode {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length);

  if (mode !== "development" && mode !== "production") {
    console.error(
      "[runsEnvAllowlist] FAIL: pass exactly one explicit mode: --mode=development or --mode=production"
    );
    process.exit(2);
  }

  return mode;
}

function main(): void {

  const mode = parseMode(process.argv.slice(2));

  // npm prebuild/prestart runs before Next.js loads .env files. Load them
  // with Next's own resolver first so a forbidden credential cannot bypass
  // this boundary merely by living in .env.local instead of process.env.
  // The mode is explicit rather than inferred from an inherited NODE_ENV;
  // this guarantees build/start audit the production file set and dev audits
  // the development file set with the same precedence Next.js uses.
  Object.assign(process.env, { NODE_ENV: mode });
  loadEnvConfig(process.cwd(), mode === "development");

  const result = auditEnv(process.env);

  if (result.missingRequired.length > 0) {
    console.error(
      `[runsEnvAllowlist] FAIL: required env var(s) missing: ${result.missingRequired.join(", ")}`
    );
  }

  if (result.unknownSensitivePresent.length > 0) {
    console.error(
      "[runsEnvAllowlist] FAIL: unknown sensitive env var(s) detected in Runs runtime " +
      `(names only, values never logged): ${result.unknownSensitivePresent.join(", ")}`
    );
  }

  if (!result.pass) {
    process.exit(1);
  }

  const requiredNames = RUNS_ENV_CONTRACT.filter((e) => e.required).map((e) => e.name).join(", ");
  console.log(
    `[runsEnvAllowlist] PASS (${mode}): all required env present (${requiredNames}), 0 unknown sensitive env vars detected`
  );

}

main();
