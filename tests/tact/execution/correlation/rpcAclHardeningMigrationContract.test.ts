// =========================
// SOR-53 hardening — Execution Work Correlation RPC ACL migration contract
// =========================
//
// 対象: supabase/migrations/20261028000000_restrict_execution_work_correlation_rpcs_to_service_role.sql
// SOR-56実Staging検証で発見された権限欠陥(anon/authenticatedが
// SECURITY DEFINER RPCをEXECUTEできてしまう)への、forward-only
// hardening migrationを検証する。Human Owner指示のHard Constraints:
// RPC本体を再定義しない(CREATE OR REPLACEを含まない)・
// exact identity argumentsを指定する・service_roleへのGRANTを含む、
// をこのcontract testで機械的に確認する。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261028000000_restrict_execution_work_correlation_rpcs_to_service_role.sql"),
  "utf8"
);

const APPLY_SIGNATURE = "uuid, uuid, text, text, text, text, text, uuid, real, uuid[], jsonb";
const RECLASSIFY_SIGNATURE = "uuid, uuid, uuid, uuid, text, text, text, jsonb";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check(
    "[Hardening] does not redefine either RPC body (no CREATE [OR REPLACE] FUNCTION)",
    !/create\s+(or\s+replace\s+)?function/i.test(migration)
  ));

  results.push(check(
    "[Hardening] apply_execution_work_correlation: REVOKE EXECUTE FROM PUBLIC with exact identity arguments",
    migration.includes(`revoke execute on function public.apply_execution_work_correlation(\n  ${APPLY_SIGNATURE}\n) from public;`)
  ));

  results.push(check(
    "[Hardening] apply_execution_work_correlation: REVOKE EXECUTE FROM anon",
    migration.includes(`revoke execute on function public.apply_execution_work_correlation(\n  ${APPLY_SIGNATURE}\n) from anon;`)
  ));

  results.push(check(
    "[Hardening] apply_execution_work_correlation: REVOKE EXECUTE FROM authenticated",
    migration.includes(`revoke execute on function public.apply_execution_work_correlation(\n  ${APPLY_SIGNATURE}\n) from authenticated;`)
  ));

  results.push(check(
    "[Hardening] apply_execution_work_correlation: GRANT EXECUTE TO service_role",
    migration.includes(`grant execute on function public.apply_execution_work_correlation(\n  ${APPLY_SIGNATURE}\n) to service_role;`)
  ));

  results.push(check(
    "[Hardening] reclassify_execution_work: REVOKE EXECUTE FROM PUBLIC with exact identity arguments",
    migration.includes(`revoke execute on function public.reclassify_execution_work(\n  ${RECLASSIFY_SIGNATURE}\n) from public;`)
  ));

  results.push(check(
    "[Hardening] reclassify_execution_work: REVOKE EXECUTE FROM anon",
    migration.includes(`revoke execute on function public.reclassify_execution_work(\n  ${RECLASSIFY_SIGNATURE}\n) from anon;`)
  ));

  results.push(check(
    "[Hardening] reclassify_execution_work: REVOKE EXECUTE FROM authenticated",
    migration.includes(`revoke execute on function public.reclassify_execution_work(\n  ${RECLASSIFY_SIGNATURE}\n) from authenticated;`)
  ));

  results.push(check(
    "[Hardening] reclassify_execution_work: GRANT EXECUTE TO service_role",
    migration.includes(`grant execute on function public.reclassify_execution_work(\n  ${RECLASSIFY_SIGNATURE}\n) to service_role;`)
  ));

  results.push(check(
    "[Hardening] every REVOKE/GRANT statement specifies both function names (exact-signature discipline, not a bare function-name statement)",
    (migration.match(/revoke execute on function public\.\w+\(/g)?.length ?? 0) === 6 &&
    (migration.match(/grant execute on function public\.\w+\(/g)?.length ?? 0) === 2
  ));

  return summarize("SOR-53 hardening — Execution Work Correlation RPC ACL migration contract", results);
}
