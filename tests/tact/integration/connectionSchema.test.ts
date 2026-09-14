import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationService } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const MIGRATION_PATH = "supabase/migrations/20260917000000_allow_notion_tact_connections.sql";
const HARDENING_MIGRATION_PATH = "supabase/migrations/20261012000000_restrict_tact_connections_mutations_to_service_role.sql";

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

function extractAllowedServices(migration: string): string[] {
  const match = /check\s*\(\s*service\s+in\s*\(([\s\S]*?)\)\s*\)/i.exec(migration);

  return match
    ? Array.from(match[1].matchAll(/'([^']+)'/g), ([, service]) => service)
    : [];
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const migration = readRepoFile(MIGRATION_PATH);
  const hardeningMigration = readRepoFile(HARDENING_MIGRATION_PATH);
  const connectionRepository = readRepoFile("core/tact-integration/connection.ts");
  const originalSchema = readRepoFile("supabase/migrations/20260907000000_create_tact_connections.sql");
  const canonicalTypes = readRepoFile("core/tact-integration/types.ts");
  const calendarMigration = readRepoFile("supabase/migrations/20261011000000_allow_google_calendar_tact_connections.sql");
  const allowedServices = extractAllowedServices(migration);
  const allowedServicesAfterCalendarMigration = extractAllowedServices(calendarMigration);
  const gmail: IntegrationService = "gmail";
  const slack: IntegrationService = "slack";
  const notion: IntegrationService = "notion";
  const googleCalendar: IntegrationService = "google_calendar";

  results.push(check(
    "[Connection schema] prior tact_connections constraint allowed exactly slack",
    /check\s*\(\s*service\s+in\s*\(\s*'slack'\s*\)\s*\)/i.test(originalSchema)
  ));

  results.push(check(
    "[Connection schema] migration replaces the named service constraint with slack, gmail, and canonical notion",
    /drop\s+constraint\s+if\s+exists\s+tact_connections_service_check/i.test(migration) &&
      /add\s+constraint\s+tact_connections_service_check/i.test(migration) &&
      allowedServices.length === 3 &&
      allowedServices.includes("slack") &&
      allowedServices.includes("gmail") &&
      allowedServices.includes("notion")
  ));

  results.push(check(
    "[Connection schema] unsupported services remain outside the database allowlist",
    !allowedServices.includes("google_drive") &&
      !allowedServices.includes("random_service")
  ));

  results.push(check(
    "[Connection schema] TypeScript and migration canonical service lists stay aligned",
      gmail === "gmail" &&
      slack === "slack" &&
      notion === "notion" &&
      /export type IntegrationService = "slack" \| "gmail" \| "notion" \| "google_calendar";/.test(canonicalTypes)
  ));

  // TIME-P1c Calendar Wiring: the LOCAL-ONLY, unapplied
  // 20261011000000_allow_google_calendar_tact_connections.sql migration is
  // the one that actually extends the DB allowlist to "google_calendar" —
  // this repeats the exact same source-of-truth alignment check the block
  // above does for slack/gmail/notion against the 20260917 migration, so a
  // future TypeScript-only edit to IntegrationService (without a matching
  // migration update) fails here rather than silently drifting.
  results.push(check(
    "[Connection schema] TypeScript IntegrationService includes google_calendar, matching the prepared (unapplied) migration",
      googleCalendar === "google_calendar" &&
      allowedServicesAfterCalendarMigration.length === 4 &&
      allowedServicesAfterCalendarMigration.includes("slack") &&
      allowedServicesAfterCalendarMigration.includes("gmail") &&
      allowedServicesAfterCalendarMigration.includes("notion") &&
      allowedServicesAfterCalendarMigration.includes("google_calendar")
  ));

  results.push(check(
    "[Connection schema] the google_calendar migration is still NOT applied to any database — it exists only as a LOCAL-ONLY prepared file (documented in its own header, not enforced by tooling)",
    /LOCAL-ONLY/i.test(calendarMigration) && /NOT applied/i.test(calendarMigration)
  ));

  results.push(check(
    "[Connection schema] hotfix does not change RLS policies or introduce credentials",
    !/row level security|create\s+policy|provider_connection_ref|token|secret/i.test(migration)
  ));

  results.push(check(
    "[Connection schema hardening] direct authenticated tact_connections mutations are removed while read access is preserved",
    /drop\s+policy\s+if\s+exists\s+"tact_connections_insert_own"/i.test(hardeningMigration) &&
      /drop\s+policy\s+if\s+exists\s+"tact_connections_update_own"/i.test(hardeningMigration) &&
      /drop\s+policy\s+if\s+exists\s+"tact_connections_delete_own"/i.test(hardeningMigration) &&
      /revoke\s+insert,\s*update,\s*delete\s+on\s+table\s+public\.tact_connections\s+from\s+authenticated/i.test(hardeningMigration) &&
      !/drop\s+policy[^;]*select/i.test(hardeningMigration)
  ));

  results.push(check(
    "[Connection schema hardening] canonical provisioning mutations use the server-only service role repository client",
    /import\s*\{\s*getServiceRoleClient\s*\}\s*from\s*"\.\.\/database\/supabaseServiceRole"/.test(connectionRepository) &&
      /function\s+getConnectionMutationClient/.test(connectionRepository) &&
      /SUPABASE_SERVICE_ROLE_KEY is required for trusted connection mutation/.test(connectionRepository)
  ));

  return summarize("integration/connectionSchema", results);
}
