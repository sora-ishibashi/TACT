import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationService } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const MIGRATION_PATH = "supabase/migrations/20260917000000_allow_notion_tact_connections.sql";

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
  const originalSchema = readRepoFile("supabase/migrations/20260907000000_create_tact_connections.sql");
  const canonicalTypes = readRepoFile("core/tact-integration/types.ts");
  const allowedServices = extractAllowedServices(migration);
  const gmail: IntegrationService = "gmail";
  const slack: IntegrationService = "slack";
  const notion: IntegrationService = "notion";

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
      /export type IntegrationService = "slack" \| "gmail" \| "notion";/.test(canonicalTypes)
  ));

  results.push(check(
    "[Connection schema] hotfix does not change RLS policies or introduce credentials",
    !/row level security|create\s+policy|provider_connection_ref|token|secret/i.test(migration)
  ));

  return summarize("integration/connectionSchema", results);
}
