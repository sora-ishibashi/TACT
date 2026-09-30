// =========================
// SOR-119 — Canonical Execution Outcome Migration Contract
// =========================
//
// 対象: supabase/migrations/20261104000000_create_tact_execution_outcomes.sql。
// 実DBへは接続せず、SQL文字列の内容を検証する(既存
// tests/tact/execution/permission/registryMigrationContract.test.ts等と
// 同じpattern)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261104000000_create_tact_execution_outcomes.sql"),
  "utf8"
);

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Migration/summary列] tact_canonical_executionsへoutcome_status(NOT NULL DEFAULT 'unknown')/outcome_kind(nullable)を加算する",
      migration.includes(
        "add column if not exists outcome_status text not null default 'unknown'"
      ) &&
        migration.includes("check (outcome_status in ('unknown', 'asserted'))") &&
        migration.includes("add column if not exists outcome_kind text null")
    )
  );

  results.push(
    check(
      "[Migration/table] tact_execution_outcomesはexecution_id FK(ON DELETE CASCADE)を持つ",
      migration.includes("create table if not exists public.tact_execution_outcomes") &&
        migration.includes(
          "execution_id uuid not null references public.tact_canonical_executions (id) on delete cascade"
        )
    )
  );

  results.push(
    check(
      "[Migration/Never Guess Rule] status='asserted'はoutcome_kind必須、status='unknown'はoutcome_kind禁止のCHECK制約を持つ",
      migration.includes("(status = 'asserted' and outcome_kind is not null)") &&
        migration.includes("(status = 'unknown' and outcome_kind is null)")
    )
  );

  results.push(
    check(
      "[Migration/outcome_kindはfree text] CHECK制約付きenumではなく、operation列と同じ長さ制限のみ(provider固有語彙をCore CHECK制約へ列挙しない)",
      migration.includes(
        "outcome_kind text null\n    check (outcome_kind is null or char_length(outcome_kind) between 1 and 255)"
      )
    )
  );

  results.push(
    check(
      "[Migration/Artifact再利用] artifact_idは既存tact_artifactsへの任意FK(ON DELETE SET NULL)であり、新しい成果物tableは作らない",
      migration.includes("artifact_id uuid null references public.tact_artifacts (id) on delete set null")
    )
  );

  results.push(
    check(
      "[Migration/human correction] methodはadapter_asserted/manual_overrideの2値のみ(human correction経路を最初から確保する)",
      migration.includes("check (method in ('adapter_asserted', 'manual_override'))")
    )
  );

  results.push(
    check(
      "[Migration/raw payload非拡大] summaryは500文字上限のみで、raw provider payload本体を保存する列は無い(rawPayloadRef相当の列を新設しない)",
      migration.includes("check (summary is null or char_length(summary) <= 500)") &&
        !migration.includes("raw_payload")
    )
  );

  results.push(
    check(
      "[Migration/RLS] SELECTのみ許可(親経由のEXISTS句)、INSERT/UPDATE/DELETE policyは無い(service role専用書き込み境界)",
      migration.includes("alter table public.tact_execution_outcomes enable row level security") &&
        migration.includes("exists (\n      select 1 from public.tact_canonical_executions e") &&
        !migration.includes("for insert") &&
        !migration.includes("for update") &&
        !migration.includes("for delete")
    )
  );

  results.push(
    check(
      "[Migration/非破壊] DROP/RENAME/既存制約の破壊的変更を一切行わない",
      !/drop column|drop table|rename/i.test(migration)
    )
  );

  return summarize("SOR-119 — Canonical Execution Outcome Migration Contract", results);

}
