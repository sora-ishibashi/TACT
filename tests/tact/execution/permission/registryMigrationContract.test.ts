// =========================
// SOR-47 Permission Registry — Migration Contract
// =========================
//
// 対象: supabase/migrations/20261030000000_create_tact_execution_permission_rules.sql
// および20261031000000_add_registry_fields_to_tact_execution_permission_decisions.sql。
// 実DBへは接続せず、SQL文字列の内容を検証する(既存
// tests/tact/execution/correlation/migrationContract.test.ts等と同じ
// pattern)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const rulesMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261030000000_create_tact_execution_permission_rules.sql"),
  "utf8"
);

const decisionsMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261031000000_add_registry_fields_to_tact_execution_permission_decisions.sql"),
  "utf8"
);

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[Migration/table] tact_execution_permission_rulesはuser_id nullable(global fallback)+identifier+revisionを持つ",
      rulesMigration.includes("create table if not exists public.tact_execution_permission_rules") &&
        rulesMigration.includes("user_id uuid null references auth.users (id) on delete cascade") &&
        rulesMigration.includes("identifier text not null") &&
        rulesMigration.includes("revision integer not null default 1")
    )
  );

  results.push(
    check(
      "[Migration/Human Owner修正1] NULL-safeなpartial unique index戦略(plain UNIQUE(user_id, identifier)は使わない)",
      rulesMigration.includes("idx_tact_execution_permission_rules_tenant_identifier") &&
        rulesMigration.includes("on public.tact_execution_permission_rules (user_id, identifier)") &&
        rulesMigration.includes("where user_id is not null") &&
        rulesMigration.includes("idx_tact_execution_permission_rules_global_identifier") &&
        rulesMigration.includes("on public.tact_execution_permission_rules (identifier)") &&
        rulesMigration.includes("where user_id is null") &&
        !rulesMigration.includes("unique(user_id, identifier)")
    )
  );

  results.push(
    check(
      "[Migration/Human Owner修正2] priorityの一意性は強制しない(unique indexはtenant/global identifier用の2本のみ、priorityを含むunique indexは無い、ambiguity検出はapplication層/registryEvaluate.tsが担う)",
      (rulesMigration.match(/create unique index/g) ?? []).length === 2 &&
        !/create unique index[^;]*priority/i.test(rulesMigration)
    )
  );

  results.push(
    check(
      "[Migration/connection scope] connection_idはtact_connectionsへの実uuid FK(text型ではない、repository realityに基づく訂正)",
      rulesMigration.includes("connection_id uuid null references public.tact_connections (id) on delete set null")
    )
  );

  results.push(
    check(
      "[Migration/actor-agent scope] actor_id/agent_idの専用列が存在する(既存requires_known_*とは独立、Human Owner指示section1)",
      rulesMigration.includes("actor_id text null") &&
        rulesMigration.includes("agent_id text null") &&
        rulesMigration.includes("requires_known_actor_id boolean not null default false") &&
        rulesMigration.includes("requires_known_agent_id boolean not null default false")
    )
  );

  results.push(
    check(
      "[Migration/validity] valid_from/valid_untilが半開区間として存在する",
      rulesMigration.includes("valid_from timestamptz null") && rulesMigration.includes("valid_until timestamptz null")
    )
  );

  results.push(
    check(
      "[Migration/RLS] SELECTのみ許可(自分のtenant行 or global行)、INSERT/UPDATE/DELETE policyは無い(service role専用書き込み境界)",
      rulesMigration.includes("alter table public.tact_execution_permission_rules enable row level security") &&
        rulesMigration.includes("user_id = auth.uid() or user_id is null") &&
        !rulesMigration.includes("for insert") &&
        !rulesMigration.includes("for update") &&
        !rulesMigration.includes("for delete")
    )
  );

  results.push(
    check(
      "[Migration/seed] 既存7 hardcoded ruleが全てglobal fallback行(user_id=null)として種入れされている",
      [
        "human-slack-mention-allowed",
        "ai-agent-slack-channel-read-allowed",
        "ai-agent-slack-message-send-denied",
        "notion-ai-agent-read-allowed",
        "notion-ai-agent-create-page-allowed",
        "notion-ai-agent-update-page-approval-required",
        "notion-ai-agent-delete-page-denied",
      ].every((identifier) => rulesMigration.includes(`'${identifier}'`))
    )
  );

  results.push(
    check(
      "[Migration/historical explainability] permission_decisionsへregistry_rule_id(FK, ON DELETE SET NULL)とregistry_rule_revisionを加算的に追加する",
      decisionsMigration.includes("add column if not exists registry_rule_id uuid null") &&
        decisionsMigration.includes("references public.tact_execution_permission_rules (id) on delete set null") &&
        decisionsMigration.includes("add column if not exists registry_rule_revision integer null")
    )
  );

  results.push(
    check(
      "[Migration/既存行への非破壊] decisions migrationはNULL許容の加算列のみで、既存constraintを変更しない",
      !decisionsMigration.includes("drop constraint") && !decisionsMigration.includes("not null default")
    )
  );

  return summarize("SOR-47 — Permission Registry Migration Contract", results);

}
