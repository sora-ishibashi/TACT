// =========================
// SOR-52 transactional migration contract
// =========================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261025000000_create_execution_work_correlation_rpcs.sql"),
  "utf8"
);

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check(
    "[Migration/auto] RPC locks execution and Work, validates owner/status, then writes summary and append-only history",
    migration.includes("create or replace function public.apply_execution_work_correlation") &&
      migration.includes("where id = p_execution_id and user_id = p_user_id") &&
      migration.includes("where id = p_target_work_id and user_id = p_user_id") &&
      migration.includes("for update") &&
      migration.includes("target_work_not_correlatable") &&
      migration.includes("insert into public.tact_execution_work_correlations") &&
      migration.includes("set work_id = p_target_work_id, correlation_status = 'matched'")
  ));

  results.push(check(
    "[Migration/idempotency] decision fingerprint is uniquely indexed per Execution and is checked before ambiguous/unresolved history append",
    migration.includes("idx_tact_execution_work_correlations_fingerprint") &&
      migration.includes("(execution_id, decision_fingerprint)") &&
      migration.includes("'outcome', 'duplicate_decision'")
  ));

  results.push(check(
    "[Migration/manual] manual reclassification locks the summary and rejects a stale expected Work before summary/history mutation",
    migration.includes("create or replace function public.reclassify_execution_work") &&
      migration.includes("is distinct from p_expected_previous_work_id") &&
      migration.includes("'outcome', 'stale_revision'") &&
      migration.includes("'manual_override'")
  ));

  results.push(check(
    "[Migration/direct writers] direct Execution.work_id inserts/updates also receive owner and active-state write-time validation",
    migration.includes("create or replace function public.enforce_tact_execution_work_assignment") &&
      migration.includes("for share") &&
      migration.includes("trg_enforce_tact_execution_work_assignment")
  ));

  return summarize("SOR-52 — Transactional Correlation Migration Contract", results);
}
