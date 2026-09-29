// =========================
// SOR-45 — Canonical Execution v1 Observation Contract Migration Contract
// =========================
//
// 対象: supabase/migrations/
// 20261103000000_add_v1_observation_contract_to_tact_canonical_executions.sql。
// 実DBへは接続せず、SQL文字列の内容を検証する(既存
// tests/tact/execution/permission/registryMigrationContract.test.ts等と
// 同じpattern)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261103000000_add_v1_observation_contract_to_tact_canonical_executions.sql"
  ),
  "utf8"
);

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Migration] schema_versionはNOT NULL DEFAULT 1の加算列である",
      migration.includes("add column if not exists schema_version integer not null default 1") &&
        migration.includes("check (schema_version >= 1)")
    )
  );

  results.push(
    check(
      "[Migration] observation_modeはnullableな加算列で、inline/instrumented/reconciledの3値のみ許容する",
      migration.includes("add column if not exists observation_mode text null") &&
        migration.includes(
          "check (observation_mode is null or observation_mode in ('inline', 'instrumented', 'reconciled'))"
        )
    )
  );

  results.push(
    check(
      "[Migration] pre_execution_visibleはNOT NULL DEFAULT falseの加算列である",
      migration.includes("add column if not exists pre_execution_visible boolean not null default false")
    )
  );

  results.push(
    check(
      "[Migration/非破壊] このmigrationはALTER TABLE ADD COLUMNのみで、DROP/RENAME/既存制約の変更を一切行わない",
      (migration.match(/alter table/gi) ?? []).every((_, i, arr) => arr.length === 3) &&
        (migration.match(/add column if not exists/gi) ?? []).length === 3 &&
        !/drop column|drop constraint|rename|alter column/i.test(migration)
    )
  );

  results.push(
    check(
      "[Migration/既存table対象] 全てtact_canonical_executionsに対する変更であり、他tableは一切触らない",
      migration
        .split(/alter table/i)
        .slice(1)
        .every((clause) => clause.trim().startsWith("public.tact_canonical_executions"))
    )
  );

  return summarize("SOR-45 — Canonical Execution v1 Observation Contract Migration Contract", results);

}
