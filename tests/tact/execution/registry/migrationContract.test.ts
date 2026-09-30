// =========================
// SOR-14 — Integration & Observation Registry Migration Contract
// =========================
//
// 対象: supabase/migrations/20261105000000_create_tact_execution_observation_registry.sql。
// 実DBへは接続せず、SQL文字列の内容を検証する(既存
// tests/tact/execution/outcome/migrationContract.test.ts等と同じpattern)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261105000000_create_tact_execution_observation_registry.sql"
  ),
  "utf8"
);

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  results.push(
    check(
      "[table] tact_execution_observation_registryを作成し、既存のExecutionProvider/ExecutionActionCategory enumをそのまま再利用する(新enum値を追加しない)",
      migration.includes("create table if not exists public.tact_execution_observation_registry") &&
        migration.includes(
          "check (provider in (\n      'openai', 'anthropic', 'mcp', 'slack', 'gmail',\n      'google_calendar', 'notion', 'microsoft365', 'salesforce', 'custom'\n    ))"
        ) &&
        migration.includes(
          "check (action_category in (\n      'read', 'create', 'update', 'send', 'delete', 'share', 'execute', 'approve', 'unknown'\n    ))"
        )
    )
  );

  results.push(
    check(
      "[絶対条件1: Observation capability] observation_mode/pre_execution_visible/can_block_or_require_approval列を持つ",
      migration.includes("observation_mode text null") &&
        migration.includes("check (observation_mode is null or observation_mode in ('inline', 'instrumented', 'reconciled'))") &&
        migration.includes("pre_execution_visible boolean not null default false") &&
        migration.includes("can_block_or_require_approval boolean not null default false")
    )
  );

  results.push(
    check(
      "[絶対条件2: Permission-policy availabilityを別概念として分離] permission_policy_configuredに相当する列をこのtableへ一切追加していない(store層で都度導出)",
      !migration.toLowerCase().includes("permission_policy_configured") &&
        !migration.toLowerCase().includes("permission_status")
    )
  );

  results.push(
    check(
      "[絶対条件4: Verification status] verification_statusはlive_verified/mock_only/unverifiedの3値のみ、defaultはunverified",
      migration.includes("verification_status text not null default 'unverified'") &&
        migration.includes("check (verification_status in ('live_verified', 'mock_only', 'unverified'))")
    )
  );

  results.push(
    check(
      "[絶対条件5: Per-action coverage] uniqueness制約がaction_category単位まで正規化されている(provider単位に丸めていない)",
      migration.includes("provider, coalesce(provider_label, ''), observation_path, action_category") &&
        migration.includes("where connection_id is null") &&
        migration.includes("where connection_id is not null")
    )
  );

  results.push(
    check(
      "[Work ID] work_context_carrierはnone/explicit_claim/reconciled_correlationの3値、defaultはnone(fake claimを作らない)",
      migration.includes("work_context_carrier text not null default 'none'") &&
        migration.includes("check (work_context_carrier in ('none', 'explicit_claim', 'reconciled_correlation'))")
    )
  );

  results.push(
    check(
      "[Privacy] excludes_raw_payloadはdefault true、生payload保存を拡大していない",
      migration.includes("excludes_raw_payload boolean not null default true")
    )
  );

  results.push(
    check(
      "[Destructive migration禁止] 既存tableへのALTER/DROPが一切無い、additiveのみ",
      !migration.toLowerCase().includes("alter table public.tact_canonical_executions") &&
        !migration.toLowerCase().includes("drop table") &&
        !migration.toLowerCase().includes("drop column")
    )
  );

  results.push(
    check(
      "[RLS] tenant固有データを持たないため認証済み全員へのSELECTのみ許可し、書き込みpolicyは一切作らない(service-role専用)",
      migration.includes("alter table public.tact_execution_observation_registry enable row level security") &&
        migration.includes("for select") &&
        migration.includes("to authenticated") &&
        !migration.includes("for insert") &&
        !migration.includes("for update") &&
        !migration.includes("for delete")
    )
  );

  // ---- SOR-130 evidence representation ----

  results.push(
    check(
      "[SOR-130 evidence] Notionは4アクション(read/create/update/delete)全てlive_verifiedとしてseedされる",
      (migration.match(/\('notion', null, 'notion-mcp-v1', '(read|create|update|delete)',[\s\S]*?'live_verified'/g) ?? []).length === 4
    )
  );

  results.push(
    check(
      "[SOR-130 evidence] Slackはweb-api経路でread=live_verified / send=unverifiedを同時にseedしている(部分的coverageの表現)",
      /\('slack', null, 'slack-web-api-v1', 'read',[\s\S]*?'live_verified'/.test(migration) &&
        /\('slack', null, 'slack-web-api-v1', 'send',[\s\S]*?'unverified'/.test(migration)
    )
  );

  results.push(
    check(
      "[SOR-130 evidence] Slack inbound(app-mention)はproduction未配線のためmock_onlyとしてseedされ、live_verifiedへ推測で昇格していない",
      /\('slack', null, 'slack-app-mention-v1', 'create',[\s\S]*?'mock_only'/.test(migration)
    )
  );

  results.push(
    check(
      "[SOR-74/SOR-95 Product truth] Slack app_mentionのwork_context_carrierは'none'(型がworkId?を受け取れることと、production未実施のlegitimate carrierが存在することを混同しない、fake explicit claim禁止)",
      /\('slack', null, 'slack-app-mention-v1', 'create',\n\s+'reconciled', false, true,\n\s+true, 'high', false, 'none',\n\s+'none', false,/.test(migration)
    )
  );

  results.push(
    check(
      "[SOR-130 evidence] GitHubはprovider='custom'+provider_label='github'として3アクション(read/create/update)がlive_verifiedでseedされる(provider gapをfailure扱いしない)",
      (migration.match(/\('custom', 'github', 'github-issue-v1', '(read|create|update)',[\s\S]*?'live_verified'/g) ?? [])
        .length === 3
    )
  );

  results.push(
    check(
      "[unverifiedをsupported扱いしない] Google Workspace(gmail/google_calendar)・CRM(salesforce)のseed行が1件も無い",
      !migration.includes("'gmail', null,") &&
        !migration.includes("'google_calendar', null,") &&
        !migration.includes("'salesforce', null,")
    )
  );

  return summarize("SOR-14 — Integration & Observation Registry Migration Contract", results);

}
