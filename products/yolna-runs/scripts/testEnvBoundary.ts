import assert from "node:assert/strict";
import { auditEnv, classifyEnvName, RUNS_ALLOWED_ENV } from "../lib/env/runtimeEnvContract";

const SYNTHETIC_VALUE = "synthetic-test-value";
const allowedRunsEnv: NodeJS.ProcessEnv = Object.fromEntries(
  RUNS_ALLOWED_ENV.map((name) => [name, SYNTHETIC_VALUE])
) as NodeJS.ProcessEnv;

const benignAmbientEnv: NodeJS.ProcessEnv = {
  ...allowedRunsEnv,
  PATH: "synthetic-path",
  HOME: "synthetic-home",
  NODE_ENV: "production",
  npm_lifecycle_event: "build",
  npm_package_name: "@tact/yolna-runs",
  npm_config_user_agent: "synthetic-npm-agent",
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "preview",
  VERCEL_URL: "synthetic-preview.example.invalid",
  VERCEL_BRANCH_URL: "synthetic-branch.example.invalid",
  VERCEL_PROJECT_PRODUCTION_URL: "synthetic-production.example.invalid",
  VERCEL_PROJECT_ID: "synthetic-project-id",
  VERCEL_ORG_ID: "synthetic-org-id",
  VERCEL_REGION: "hnd1",
  VERCEL_DEPLOYMENT_ID: "synthetic-deployment-id",
  VERCEL_GIT_PROVIDER: "github",
  VERCEL_GIT_REPO_SLUG: "synthetic-repo",
  VERCEL_GIT_COMMIT_REF: "synthetic-branch",
  VERCEL_GIT_COMMIT_SHA: "synthetic-sha",
};

assert.equal(auditEnv(allowedRunsEnv).pass, true, "Runs allowlist must pass");
assert.equal(auditEnv(benignAmbientEnv).pass, true, "trusted ambient metadata must pass");

for (const name of [
  "OPENAI_API_KEY",
  "CUSTOMER_SAAS_WRITE_TOKEN",
  "SALESFORCE_ACCESS_TOKEN",
  "DROPBOX_API_KEY",
  "RANDOM_VENDOR_SECRET",
  "CUSTOMER_DB_PASSWORD",
]) {
  const result = auditEnv({ ...benignAmbientEnv, [name]: SYNTHETIC_VALUE });
  assert.equal(result.pass, false, `${name} must fail closed`);
  assert.deepEqual(result.unknownSensitivePresent, [name]);
  assert.equal(classifyEnvName(name), "UNKNOWN_SENSITIVE_ENV");
}

assert.equal(classifyEnvName("VERCEL_CUSTOMER_TOKEN"), "UNKNOWN_SENSITIVE_ENV");
assert.equal(classifyEnvName("npm_config_auth_token"), "UNKNOWN_SENSITIVE_ENV");

for (const name of [
  "TURBO_CI_VENDOR_ENV_KEY",
  "VERCEL_ARTIFACTS_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_DEPLOYMENT_KEY",
  "VERCEL_ENV_ENC_KEY",
  "VERCEL_OIDC_TOKEN",
]) {
  assert.equal(
    auditEnv({ ...benignAmbientEnv, [name]: SYNTHETIC_VALUE }).pass,
    true,
    `${name} is permitted only in a verified non-Production Vercel environment`
  );
  assert.equal(
    auditEnv({ ...allowedRunsEnv, [name]: SYNTHETIC_VALUE }).pass,
    false,
    `${name} must fail without Vercel platform context`
  );
  assert.equal(
    auditEnv({
      ...benignAmbientEnv,
      VERCEL_ENV: "production",
      [name]: SYNTHETIC_VALUE,
    }).pass,
    false,
    `${name} must not be authorized in a Production deployment`
  );
}

console.log(
  "[runsEnvBoundaryTest] PASS: Runs allowlist and trusted ambient metadata accepted; known and unknown credentials rejected; exact Vercel build credentials allowed only in non-Production Vercel context"
);
