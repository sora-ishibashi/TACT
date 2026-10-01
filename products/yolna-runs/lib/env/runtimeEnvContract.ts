// =========================
// Yolna Runs Standalone — Production Env / Secret Contract (SOR-135 Phase 4A)
// =========================
//
// Single source of truth for which environment variables the Standalone
// Runs runtime may hold, and which Yolna-owned secrets it must never hold.
// Both scripts/verifyEnvAllowlist.ts (CLI/CI entrypoint) and any future
// boot-time check import this module rather than duplicating the lists.
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
  "CODEX_",
  "NOTION_",
  "SOR130_",
];

export interface EnvAuditResult {
  pass: boolean;
  missingRequired: string[];
  forbiddenPresent: string[];
}

// Fail-closed by construction: a var counts as "present" the moment
// process.env has a non-empty value for it, regardless of whether this
// module's author anticipated it. Never logs/returns the value itself —
// only names, everywhere in this module and its caller.
export function auditEnv(env: NodeJS.ProcessEnv): EnvAuditResult {

  const missingRequired = RUNS_ENV_CONTRACT
    .filter((entry) => entry.required && !env[entry.name])
    .map((entry) => entry.name);

  const forbiddenPresent = Object.keys(env).filter((name) => {

    if (!env[name]) {
      return false;
    }

    if (FORBIDDEN_SECRET_NAMES.includes(name)) {
      return true;
    }

    return FORBIDDEN_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));

  });

  return {
    pass: missingRequired.length === 0 && forbiddenPresent.length === 0,
    missingRequired,
    forbiddenPresent,
  };

}
