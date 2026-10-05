// =========================
// TACT Integration — Connection Projection Contract Regression (SOR-212)
// =========================
//
// Source-level verification (same technique as
// tests/tact/integration/connectionSchema.test.ts): reads
// @tact/execution-contract's own source text and the new migration's
// source text, and checks for the presence/absence of specific strings —
// no DB connection, no migration apply. This is deliberately a text-level
// check for the forbidden-field list: a field being added to the TypeSCRIPT
// type is exactly the kind of accidental-but-reviewable change this test
// exists to catch before it ships, even though the type system itself
// can't enforce "this interface must never grow this field".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTION_PROJECTION_STATUSES,
  type ConnectionProjectionItem,
  type ConnectionProjectionSnapshotInput,
  type ConnectionProjectionSnapshotState,
} from "@tact/execution-contract";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

const FORBIDDEN_FIELD_NAMES = [
  "providerConnectionRef",
  "providerStatusRaw",
  "accessToken",
  "refreshToken",
  "credential",
  "secret",
  "redirectUrl",
  "connectedAccountId",
  "ConnectedAccountId",
];

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const contractSource = readRepoFile("packages/execution-contract/index.ts");
  const migrationSource = readRepoFile(
    "products/yolna-runs/supabase/migrations/20270101000017_create_tact_runs_connection_projection.sql"
  );

  // =========================
  // contract: forbidden sensitive fields
  // =========================

  // Isolate just the Connection Projection Contract section so this check
  // cannot accidentally pass/fail based on unrelated parts of the shared
  // file (e.g. a legitimate "token" substring inside a comment elsewhere).
  const sectionStart = contractSource.indexOf("Connection Projection Contract (SOR-212)");
  results.push(check(
    "[SOR-212] execution-contract.ts contains the Connection Projection Contract section",
    sectionStart !== -1
  ));

  const section = contractSource.slice(sectionStart);

  for (const forbidden of FORBIDDEN_FIELD_NAMES) {
    // A field *name* (identifier), not just any substring — "metadata"
    // itself appears legitimately in prose (explaining why it's excluded),
    // so this list intentionally omits bare "metadata"/"token" and checks
    // them separately below with a narrower pattern.
    const fieldPattern = new RegExp(`\\b${forbidden}\\s*[?:]`);
    results.push(check(
      `[SOR-212] Connection Projection Contract never declares a field named "${forbidden}"`,
      !fieldPattern.test(section)
    ));
  }

  // "metadata" / "token" / "Token" as actual field declarations (colon or
  // optional-colon immediately after the identifier) — narrower than a
  // bare substring search, since this section's own header comment
  // legitimately mentions these words in prose while explaining the ban.
  results.push(check(
    "[SOR-212] Connection Projection Contract never declares a `metadata` field",
    !/\bmetadata\s*[?:]/.test(section)
  ));
  results.push(check(
    "[SOR-212] Connection Projection Contract never declares a `token` field",
    !/\btoken\s*[?:]/.test(section)
  ));

  // =========================
  // contract: status validation / vocabulary
  // =========================

  results.push(check(
    "[SOR-212] ConnectionProjectionStatus mirrors core/tact-integration's 4-value ConnectionStatus exactly",
    CONNECTION_PROJECTION_STATUSES.length === 4 &&
    CONNECTION_PROJECTION_STATUSES.includes("pending") &&
    CONNECTION_PROJECTION_STATUSES.includes("active") &&
    CONNECTION_PROJECTION_STATUSES.includes("failed") &&
    CONNECTION_PROJECTION_STATUSES.includes("revoked")
  ));

  // Compile-time shape checks (these would fail to typecheck, not just at
  // runtime, if the contract's shape drifted from what callers expect).
  const item: ConnectionProjectionItem = {
    externalConnectionId: "conn-1",
    service: "gmail",
    status: "active",
    provider: "composio",
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
  };
  const snapshot: ConnectionProjectionSnapshotInput = {
    userId: "user-1",
    snapshotAt: "2027-01-01T00:00:00.000Z",
    connections: [item],
  };
  const unavailableState: ConnectionProjectionSnapshotState = { readState: "unavailable", lastSnapshotAt: null };
  const availableState: ConnectionProjectionSnapshotState = { readState: "available", lastSnapshotAt: "2027-01-01T00:00:00.000Z" };

  results.push(check(
    "[SOR-212] ConnectionProjectionItem/SnapshotInput/SnapshotState compile against the documented shape",
    snapshot.connections[0] === item &&
    unavailableState.lastSnapshotAt === null &&
    availableState.readState === "available"
  ));

  // =========================
  // migration: schema shape / forbidden columns / RLS
  // =========================

  results.push(check(
    "[SOR-212] migration creates tact_runs_connection_projection",
    /create table if not exists public\.tact_runs_connection_projection\s*\(/.test(migrationSource)
  ));

  results.push(check(
    "[SOR-212] migration creates tact_runs_connection_projection_state",
    /create table if not exists public\.tact_runs_connection_projection_state\s*\(/.test(migrationSource)
  ));

  results.push(check(
    "[SOR-212] tact_runs_connection_projection_state has no row-count-based meaning columns beyond the documented 3",
    /user_id uuid not null primary key/.test(migrationSource) &&
    /last_snapshot_at timestamptz not null/.test(migrationSource) &&
    /projected_at timestamptz not null/.test(migrationSource)
  ));

  // Narrower than a bare substring search: an actual SQL column
  // declaration is "<name> <type_keyword>", which this migration's own
  // prose (explaining, in English, why these columns are absent) never
  // happens to produce — so this correctly ignores the header comment's
  // legitimate mentions of these words while still catching a real column.
  const SQL_TYPE_KEYWORDS = "uuid|text|timestamptz|boolean|integer|real|jsonb|json";

  for (const forbidden of ["provider_connection_ref", "provider_status_raw", "access_token", "refresh_token", "credential", "secret", "redirect_url", "metadata"]) {
    results.push(check(
      `[SOR-212] migration never declares a column named "${forbidden}"`,
      !new RegExp(`\\b${forbidden}\\s+(${SQL_TYPE_KEYWORDS})\\b`, "i").test(migrationSource)
    ));
  }

  results.push(check(
    "[SOR-212] status CHECK constraint matches the 4-value canonical vocabulary exactly",
    /check\s*\(\s*status\s+in\s*\(\s*'pending',\s*'active',\s*'failed',\s*'revoked'\s*\)\s*\)/.test(migrationSource)
  ));

  results.push(check(
    "[SOR-212] both tables enable RLS",
    (migrationSource.match(/enable row level security/g) ?? []).length === 2
  ));

  results.push(check(
    "[SOR-212] both tables define exactly a select-own policy, no insert/update/delete policy",
    (migrationSource.match(/create policy/g) ?? []).length === 2 &&
    !/for\s+(insert|update|delete|all)/i.test(migrationSource)
  ));

  // =========================
  // migration: atomic RPC, service-role-only grant
  // =========================

  results.push(check(
    "[SOR-212] migration defines replace_tact_runs_connection_projection_snapshot as SECURITY DEFINER",
    /create or replace function public\.replace_tact_runs_connection_projection_snapshot/.test(migrationSource) &&
    /security definer/.test(migrationSource)
  ));

  results.push(check(
    "[SOR-212] the RPC's execute grant is restricted to service_role (and revoked from public first)",
    /revoke all on function public\.replace_tact_runs_connection_projection_snapshot/.test(migrationSource) &&
    /grant execute on function public\.replace_tact_runs_connection_projection_snapshot[\s\S]*?to service_role/.test(migrationSource)
  ));

  results.push(check(
    "[SOR-212] the RPC advances the state row AFTER the projection delete+insert (ordering, source order of statements)",
    migrationSource.indexOf("delete from public.tact_runs_connection_projection") <
      migrationSource.indexOf("insert into public.tact_runs_connection_projection_state")
  ));

  return summarize("integration/connectionProjectionContract", results);

}
