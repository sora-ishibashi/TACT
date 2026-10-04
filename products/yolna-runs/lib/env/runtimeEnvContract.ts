// =========================
// Yolna Runs Standalone — Production Env / Secret Contract (SOR-135 Phase 4A)
// =========================
//
// Single source of truth for which product-owned environment variables the
// Standalone Runs runtime may hold. OS, npm, CI, and Vercel also provide
// non-product metadata; those names are classified separately so an unknown
// credential cannot hide among otherwise harmless ambient variables.
//
// RUNS_ENV_CONTRACT was built by auditing actual `process.env.*` reads
// across products/yolna-runs, packages/runs-core, and packages/
// execution-contract (SOR-135 Phase 4A audit, 2026-10-01) — not guessed.
// Nothing is added "because it might be needed later" (explicit
// instruction). Each entry's justification:
//   - NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY:
//     products/yolna-runs/core/database/supabase.ts (browser client).
//   - SUPABASE_SERVICE_ROLE_KEY:
//     packages/runs-core/database/supabaseServiceRole.ts (server-only
//     client used by every Runs Core store/RPC call site).
//   - RUNS_PROJECTION_INGESTION_TOKEN:
//     products/yolna-runs/lib/projection/ingestionAuth.ts — the explicit
//     authentication seam for the Yolna -> Runs projection ingestion API
//     added this same phase (see app/api/tact/runs/ingest/**). This is the
//     "telemetry ingestion / signing credential" the parent SOR-135 issue's
//     allowlist candidates already name. Request signing / nonce / replay
//     prevention remain SOR-8's responsibility (not implemented here).

export interface EnvContractEntry {
  name: string;
  visibility: "public" | "server-only";
  required: boolean;
  description: string;
}

export const RUNS_ENV_CONTRACT: readonly EnvContractEntry[] = [

  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    visibility: "public",
    required: true,
    description: "Runs-owned Supabase project URL. Safe to expose to the browser bundle.",
  },

  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    visibility: "public",
    required: true,
    description: "Runs-owned Supabase anon key (RLS-scoped). Safe to expose to the browser bundle.",
  },

  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    visibility: "server-only",
    required: true,
    description:
      "Runs-owned Supabase service-role key. Must only be read by server-side modules — " +
      "see scripts/verify/runsClientServerBoundary.ts for the enforced client/server import boundary.",
  },

  {
    name: "RUNS_PROJECTION_INGESTION_TOKEN",
    visibility: "server-only",
    required: false,
    description:
      "Shared-secret bearer credential for POST /api/tact/runs/ingest/** (Yolna -> Runs projection " +
      "write path). Optional: unset means those endpoints reject every request (fail-closed), not " +
      "that they accept unauthenticated writes. Request signing / nonce / replay prevention are " +
      "SOR-8's responsibility, not implemented by this token.",
  },
  {
    name: "RUNS_TELEMETRY_HMAC_KEYS_JSON",
    visibility: "server-only",
    required: false,
    description: "Runs-owned HMAC verification keys for signed inbound execution telemetry; never a downstream capability credential.",
  },

];

export const RUNS_ALLOWED_ENV: readonly string[] = RUNS_ENV_CONTRACT.map((entry) => entry.name);

// Exact names only. Do not replace this with broad prefixes such as VERCEL_
// or npm_config_: both namespaces can also contain credentials (for example
// an OIDC token or registry auth token). These entries are runtime/build
// metadata observed or documented for the supported local, npm, CI, and
// Vercel execution paths.
export const TRUSTED_AMBIENT_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "NODE_ENV",
  "NODE_OPTIONS",
  "CI",
  "INIT_CWD",
  "npm_command",
  "npm_config_cache",
  "npm_config_prefix",
  "npm_config_user_agent",
  "npm_execpath",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_node_execpath",
  "npm_package_json",
  "npm_package_name",
  "npm_package_version",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID",
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_SKEW_PROTECTION_ENABLED",
  "VERCEL_GIT_PROVIDER",
  "VERCEL_GIT_REPO_SLUG",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_ID",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "VERCEL_GIT_PULL_REQUEST_ID",
];

// =========================
// Forbidden Yolna-owned secrets
// =========================
//
// Exact names confirmed present in the Yolna root codebase (core/, app/,
// tests/, experiments/) by `grep -rhoE "process\\.env\\.[A-Z_]+"` as of the
// SOR-135 Phase 4A audit. Each one grants a capability Runs must never
// hold: LLM execution, Composio SaaS execution, Slack bot credentials,
// Trigger.dev execution, GitHub write access, or Yolna's own dev/test
// fixtures.

export const FORBIDDEN_SECRET_NAMES: readonly string[] = [

  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  // Not found in current Yolna code — forbidden pre-emptively per SOR-135
  // Phase 4A instructions as a known model-provider key family.
  "GEMINI_API_KEY",

  "COMPOSIO_API_KEY",
  "COMPOSIO_SLACK_AUTH_CONFIG_ID",
  "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
  "COMPOSIO_NOTION_AUTH_CONFIG_ID",
  "COMPOSIO_SLACK_TOOLKIT_VERSION",
  "COMPOSIO_GMAIL_TOOLKIT_VERSION",
  "COMPOSIO_NOTION_TOOLKIT_VERSION",

  "TAVILY_API_KEY",
  "BRAVE_SEARCH_API_KEY",

  "SLACK_BOT_TOKEN",
  "SLACK_BOT_USER_ID",
  "SLACK_SIGNING_SECRET",

  "TRIGGER_SECRET_KEY",
  "TRIGGER_PROJECT_REF",

  "GITHUB_TOKEN",

  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CLAUDE_MODEL",

  // Yolna's own experiments/sor130-reality-test dev/test fixtures — not
  // production secrets, but still Yolna-only and must never appear in a
  // Runs deployment's environment.
  "NOTION_TEST_HOST_TOKEN",
  "SOR130_SLACK_TEST_CHANNEL",
  "SOR130_GITHUB_TEST_REPO",
  "SOR130_LOCAL_SUPABASE_URL",
  "SOR130_LOCAL_SUPABASE_SERVICE_ROLE_KEY",

];

// Prefix families for defense-in-depth against *future* Yolna secrets not
// yet enumerated above (the instruction's "他にもYolna-only secretがあれば
// 追加してください" extends forward in time, not just to today's grep
// results). Deliberately excludes GITHUB_ and CLAUDE_ as prefixes: both
// collide with harmless ambient platform/tooling vars that are not secrets
// and must not fail a legitimate deployment or local dev shell —
// GitHub Actions sets GITHUB_ACTIONS/GITHUB_REPOSITORY/GITHUB_SHA/... as
// plain CI metadata, and Claude Code's own IDE integration sets
// CLAUDE_CODE_*/CLAUDE_PID/... for session plumbing (confirmed present in
// this very development shell during the Phase 4A audit). GITHUB_TOKEN and
// CLAUDE_MODEL stay forbidden by exact name above instead.
export const FORBIDDEN_SECRET_PREFIXES: readonly string[] = [
  "OPENAI_",
  "ANTHROPIC_",
  "GEMINI_",
  "COMPOSIO_",
  "TAVILY_",
  "BRAVE_",
  "SLACK_",
  "TRIGGER_",
  "NOTION_",
  "SOR130_",
];

// Credential/capability vocabulary for providers that do not exist yet.
// Normalize punctuation before matching so FOO-ACCESS-TOKEN and
// FOO_ACCESS_TOKEN receive the same classification. Exact trusted ambient
// names are checked first; arbitrary VERCEL_*/npm_* variables do not bypass
// this detector.
const SENSITIVE_ENV_NAME =
  /(^|_)(TOKEN|SECRET|API_KEY|KEY|PASSWORD|CREDENTIAL|CREDENTIALS|SERVICE_ROLE|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SIGNING|WEBHOOK_SECRET|DATABASE_URL|DB_PASSWORD)($|_)/;

export type EnvClassification =
  | "RUNS_ALLOWED_ENV"
  | "TRUSTED_AMBIENT_ENV"
  | "UNKNOWN_SENSITIVE_ENV"
  | "OTHER_NON_SENSITIVE_ENV";

export function classifyEnvName(name: string): EnvClassification {
  if (RUNS_ALLOWED_ENV.includes(name)) {
    return "RUNS_ALLOWED_ENV";
  }

  if (TRUSTED_AMBIENT_ENV.includes(name)) {
    return "TRUSTED_AMBIENT_ENV";
  }

  if (
    FORBIDDEN_SECRET_NAMES.includes(name) ||
    FORBIDDEN_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return "UNKNOWN_SENSITIVE_ENV";
  }

  const normalized = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return SENSITIVE_ENV_NAME.test(normalized)
    ? "UNKNOWN_SENSITIVE_ENV"
    : "OTHER_NON_SENSITIVE_ENV";
}

const TRUSTED_VERCEL_BUILD_CREDENTIAL_ENV: readonly string[] = [
  "TURBO_CI_VENDOR_ENV_KEY",
  "VERCEL_ARTIFACTS_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_DEPLOYMENT_KEY",
  "VERCEL_ENV_ENC_KEY",
  "VERCEL_OIDC_TOKEN",
];

function isTrustedVercelBuildCredential(name: string, env: NodeJS.ProcessEnv): boolean {
  // Vercel injects these exact platform credentials into its build worker.
  // Runs does not read them. Permit them only inside an identifiable
  // non-Production Vercel environment; a locally pulled value (or a
  // Production deployment) still fails. Keep this list exact: a broad
  // VERCEL_ or TURBO_ exception would let unrelated credentials bypass the
  // product boundary.
  return (
    TRUSTED_VERCEL_BUILD_CREDENTIAL_ENV.includes(name) &&
    env.VERCEL === "1" &&
    (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development")
  );
}

export interface EnvAuditResult {
  pass: boolean;
  missingRequired: string[];
  unknownSensitivePresent: string[];
}

// Fail-closed by construction: a var counts as "present" the moment
// process.env has a non-empty value for it, regardless of whether this
// module's author anticipated it. Never logs/returns the value itself —
// only names, everywhere in this module and its caller.
export function auditEnv(env: NodeJS.ProcessEnv): EnvAuditResult {

  const missingRequired = RUNS_ENV_CONTRACT
    .filter((entry) => entry.required && !env[entry.name])
    .map((entry) => entry.name);

  const unknownSensitivePresent = Object.keys(env).filter((name) => {

    if (!env[name]) {
      return false;
    }

    return (
      classifyEnvName(name) === "UNKNOWN_SENSITIVE_ENV" &&
      !isTrustedVercelBuildCredential(name, env)
    );

  });

  return {
    pass: missingRequired.length === 0 && unknownSensitivePresent.length === 0,
    missingRequired,
    unknownSensitivePresent,
  };

}
