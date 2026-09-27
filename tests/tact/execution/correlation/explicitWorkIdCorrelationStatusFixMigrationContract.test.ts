// =========================
// SOR-53 hardening — explicit workId correlation_status fix
// migration contract (Defect 2)
// =========================
//
// 対象: supabase/migrations/20261029000000_fix_explicit_work_correlation_status_transition.sql
// SOR-55実Staging検証で発見された、captureExecution() Path A
// (explicit workId)で観測されたExecutionが、apply_execution_work_
// correlation()の早期return(旧: work_id一致だけを条件とする
// "already_same_work")により、history追加もcorrelation_status='matched'
// への遷移も一切されないまま永久に'pending'(=UI/APIではUNASSIGNED)に
// 留まってしまう欠陥への、forward-only修正を検証する。
//
// SQL本文の実際の挙動(atomicity/concurrency含む)はreal Postgres
// (TACT Staging)でのみ検証可能なため(既存規約、
// tests/tact/work/storeAuthorization.test.ts冒頭コメント参照)、この
// fileは「修正が正しい形で存在すること」をfile内容ベースで確認する
// contract testに留める。real behaviorの検証はSOR-53最終報告の
// real Staging verificationで行う。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261029000000_fix_explicit_work_correlation_status_transition.sql"),
  "utf8"
);

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(check(
    "[Defect2 fix] redefines apply_execution_work_correlation with the same identity signature (CREATE OR REPLACE, not a new function)",
    migration.includes("create or replace function public.apply_execution_work_correlation(") &&
      migration.includes("p_execution_id uuid") &&
      migration.includes("p_candidate_work_ids uuid[] default null") &&
      migration.includes("p_metadata jsonb default null")
  ));

  results.push(check(
    "[Defect2 fix] does not touch reclassify_execution_work or the write-time guard trigger (scope stays limited to the one defective function)",
    !migration.includes("create or replace function public.reclassify_execution_work") &&
      !migration.includes("create or replace function public.enforce_tact_execution_work_assignment") &&
      !migration.includes("create trigger")
  ));

  results.push(check(
    "[Defect2 fix] the early-return for an already-matched work now also requires correlation_status = 'matched' (not work_id equality alone)",
    migration.includes("v_execution.work_id = p_target_work_id and v_execution.correlation_status = 'matched'")
  ));

  results.push(check(
    "[Defect2 fix] the unconditional early-return on work_id equality alone (the old, defective short-circuit) is gone",
    !/if\s+v_execution\.work_id\s*=\s*p_target_work_id\s+then\s*\n\s*return jsonb_build_object\(\s*\n\s*'outcome',\s*'already_same_work',\s*\n\s*'workId',\s*v_execution\.work_id\s*\n\s*\);\s*\n\s*end if;/.test(migration)
  ));

  results.push(check(
    "[Defect2 fix] the conflict check for a genuinely different existing work_id is preserved (Absolute Rule 8 — never silently overwrite a different match)",
    migration.includes("v_execution.work_id is not null and v_execution.work_id <> p_target_work_id") &&
      migration.includes("'outcome', 'conflict_existing_other_work'")
  ));

  results.push(check(
    "[Defect2 fix] the target Work ownership/active-state row lock (TOCTOU guard) is preserved",
    migration.includes("from public.tact_works") &&
      migration.includes("where id = p_target_work_id and user_id = p_user_id") &&
      migration.includes("for update") &&
      migration.includes("target_work_not_correlatable")
  ));

  results.push(check(
    "[Defect2 fix] the fingerprint-based duplicate_decision guard for the NULL -> matched transition is preserved",
    migration.includes("and v_execution.work_id is null") &&
      migration.includes("'outcome', 'duplicate_decision'")
  ));

  results.push(check(
    "[Defect2 fix] both work_id and correlation_status are set together in a single UPDATE after the insert (no split-brain summary write)",
    migration.includes("set work_id = p_target_work_id, correlation_status = 'matched'")
  ));

  results.push(check(
    "[Defect2 fix] the execution row lock (Never Guess Rule / tenant isolation via user_id) is unchanged",
    migration.includes("where id = p_execution_id and user_id = p_user_id") &&
      migration.includes("'outcome', 'execution_not_found'")
  ));

  results.push(check(
    "[Defect2 fix] the ambiguous/unresolved path is left untouched (only the matched path's same-work branch changed)",
    migration.includes("-- ambiguous/unresolved path (unchanged)") &&
      migration.includes("'outcome', 'already_matched'") &&
      migration.includes("'outcome', 'updated'")
  ));

  return summarize("SOR-53 hardening — Defect 2 (explicit workId correlation_status) migration contract", results);
}
