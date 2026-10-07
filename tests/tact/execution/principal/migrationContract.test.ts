// =========================
// SOR-260 Phase 1 — tact_runs_principals Migration Contract
// =========================
//
// 対象: products/yolna-runs/supabase/migrations/
// 20270101000019_create_tact_runs_principals.sql。実DBへは接続せず、SQL
// 文字列の内容を検証する(既存
// tests/tact/execution/permission/registryMigrationContract.test.ts等と
// 同じpattern)。ローカルSupabase/Dockerの有無に関わらず実行できる。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../../lib/check";

const migration = readFileSync(
  join(
    process.cwd(),
    "products/yolna-runs/supabase/migrations/20270101000019_create_tact_runs_principals.sql"
  ),
  "utf8"
);

const SIX_PHASE1_TABLES = [
  "tact_canonical_executions",
  "tact_execution_permission_rules",
  "tact_governance_invocations",
  "tact_governance_decisions",
  "tact_governance_invocation_execution_links",
  "tact_governance_approval_requests",
] as const;

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- table shape ----
  results.push(check(
    "[table] tact_runs_principals exists with namespace/external_subject_id/local_auth_user_id/principal_kind",
    migration.includes("create table public.tact_runs_principals") &&
      migration.includes("namespace text not null") &&
      migration.includes("external_subject_id text not null") &&
      migration.includes("local_auth_user_id uuid null") &&
      migration.includes("principal_kind text not null")
  ));

  results.push(check(
    "[id] DB-generated surrogate id (gen_random_uuid()), not a deterministic derivation",
    migration.includes("id uuid primary key default gen_random_uuid()")
  ));

  results.push(check(
    "[principal_kind] closed vocabulary is exactly local_runs_user/external_subject",
    migration.includes("check (principal_kind in ('local_runs_user', 'external_subject'))")
  ));

  results.push(check(
    "[natural key] unique(namespace, external_subject_id) present",
    migration.includes("unique (namespace, external_subject_id)")
  ));

  // ---- partial unique index: separate statement, never inline ----
  results.push(check(
    "[partial unique] local_auth_user_id uniqueness is a SEPARATE CREATE UNIQUE INDEX ... WHERE, never an inline table constraint",
    migration.includes("create unique index tact_runs_principals_local_auth_user_id_key") &&
      migration.includes("on public.tact_runs_principals (local_auth_user_id)") &&
      migration.includes("where local_auth_user_id is not null") &&
      !/unique\s*\(\s*local_auth_user_id\s*\)\s*where/i.test(migration)
  ));

  // ---- local_auth_user_id FK: ON DELETE SET NULL, never CASCADE/RESTRICT ----
  results.push(check(
    "[local-auth FK] local_auth_user_id references auth.users(id) on delete set null",
    migration.includes("local_auth_user_id uuid null") &&
      /local_auth_user_id\s+uuid\s+null\s+references\s+auth\.users\s*\(id\)\s+on delete set null/i.test(migration)
  ));

  // ---- detach-tolerant CHECK: local_runs_user allows local_auth_user_id
  //      to be EITHER still-linked (= id) OR detached (null) — the fix
  //      for Revision 1's contradiction (Human Owner decision 3) ----
  results.push(check(
    "[detach CHECK] local_runs_user row tolerates local_auth_user_id being NULL or = id (never forces NOT NULL permanently)",
    migration.includes("principal_kind = 'local_runs_user'") &&
      migration.includes("namespace = 'runs-local-auth'") &&
      migration.includes("external_subject_id = id::text") &&
      migration.includes("(local_auth_user_id is null or local_auth_user_id = id)")
  ));

  results.push(check(
    "[detach CHECK] external_subject row is barred from the reserved namespace and can never carry a local_auth_user_id",
    migration.includes("principal_kind = 'external_subject'") &&
      migration.includes("namespace <> 'runs-local-auth'") &&
      /principal_kind = 'external_subject'[\s\S]{0,80}and local_auth_user_id is null/i.test(migration)
  ));

  // ---- RLS: enabled, ZERO policies ----
  results.push(check(
    "[RLS] enabled on tact_runs_principals",
    migration.includes("alter table public.tact_runs_principals enable row level security")
  ));

  results.push(check(
    "[RLS] zero anon/authenticated CRUD policies defined for tact_runs_principals (service-role-only)",
    !/create policy[\s\S]*?on public\.tact_runs_principals/i.test(migration)
  ));

  // ---- backfill: id pinned to auth.users.id, namespace reserved, external_subject_id = id::text ----
  results.push(check(
    "[backfill] one principal per existing auth.users row, id pinned to auth.users.id, namespace='runs-local-auth'",
    migration.includes("insert into public.tact_runs_principals (id, namespace, external_subject_id, local_auth_user_id, principal_kind)") &&
      migration.includes("select id, 'runs-local-auth', id::text, id, 'local_runs_user'") &&
      migration.includes("from auth.users")
  ));

  // ---- fail-fast verification before any FK is touched ----
  results.push(check(
    "[fail-fast] a DO block raises an exception if any existing Phase-1 user_id lacks a matching principal.id, BEFORE the FK retarget section",
    (() => {
      const doBlockIndex = migration.indexOf("SOR-260 Phase 1 backfill incomplete");
      const firstAlterIndex = migration.indexOf("alter table public.tact_canonical_executions\n  drop constraint");
      return doBlockIndex !== -1 && firstAlterIndex !== -1 && doBlockIndex < firstAlterIndex;
    })()
  ));

  // ---- pre-commit review fix: future auth.users inserts are Principal-safe ----
  //
  // The migration-time backfill only covers auth.users rows that exist at
  // migration time. A durable AFTER INSERT trigger on auth.users must cover
  // every future auth-user-creation path (signup, admin-created, future
  // Magic Link/OAuth) — not just the one known UI entry point.

  results.push(check(
    "[trigger] a trigger function exists, targeting trigger return type, SECURITY DEFINER, fixed search_path",
    migration.includes("create function public.tact_runs_principals_bootstrap_local_auth_user()") &&
      /create function public\.tact_runs_principals_bootstrap_local_auth_user\(\)[\s\S]{0,80}returns trigger/.test(migration) &&
      migration.includes("security definer") &&
      migration.includes("set search_path = public")
  ));

  results.push(check(
    "[trigger] installed AFTER INSERT on auth.users, FOR EACH ROW",
    /create trigger trg_tact_runs_principals_bootstrap_local_auth_user[\s\S]{0,120}after insert on auth\.users[\s\S]{0,40}for each row/i.test(migration)
  ));

  results.push(check(
    "[trigger] uses NEW.id as principal.id — never a fresh/default-generated UUID for a local user",
    migration.includes("values (new.id, 'runs-local-auth', new.id::text, new.id, 'local_runs_user')")
  ));

  results.push(check(
    "[trigger] namespace is exactly 'runs-local-auth', external_subject_id is exactly NEW.id::text, local_auth_user_id is exactly NEW.id, kind is exactly 'local_runs_user' — all four hardcoded in one literal VALUES tuple, none caller-influenced or derived",
    /insert into public\.tact_runs_principals[^;]*\n\s*values \(new\.id, 'runs-local-auth', new\.id::text, new\.id, 'local_runs_user'\)/.test(migration)
  ));

  results.push(check(
    "[trigger] ON CONFLICT targets the primary key only (id) — never the (namespace, external_subject_id) natural key — so it can only no-op against a pre-existing row at this exact id, never silently adopt an unrelated principal",
    migration.includes("on conflict (id) do nothing")
  ));

  results.push(check(
    "[trigger] fails closed (RAISE EXCEPTION) if the resulting row at NEW.id is not namespace='runs-local-auth' + external_subject_id=NEW.id::text + principal_kind='local_runs_user' + local_auth_user_id=NEW.id — never overwrites, relinks, or reinterprets an incompatible existing row",
    migration.includes("v_existing.namespace is distinct from 'runs-local-auth'") &&
      migration.includes("v_existing.external_subject_id is distinct from new.id::text") &&
      migration.includes("v_existing.principal_kind is distinct from 'local_runs_user'") &&
      migration.includes("v_existing.local_auth_user_id is distinct from new.id") &&
      /raise exception[\s\S]{0,300}already maps to an incompatible principal/.test(migration)
  ));

  results.push(check(
    "[trigger security] EXECUTE revoked from public/anon/authenticated on the trigger function (defense in depth)",
    migration.includes("revoke execute on function public.tact_runs_principals_bootstrap_local_auth_user() from public") &&
      migration.includes("revoke execute on function public.tact_runs_principals_bootstrap_local_auth_user() from anon") &&
      migration.includes("revoke execute on function public.tact_runs_principals_bootstrap_local_auth_user() from authenticated")
  ));

  results.push(check(
    "[trigger security] no dynamic SQL (EXECUTE '...') inside the trigger function body",
    !/create function public\.tact_runs_principals_bootstrap_local_auth_user[\s\S]*?\$\$;/.test(migration) ||
      !migration.slice(
        migration.indexOf("create function public.tact_runs_principals_bootstrap_local_auth_user"),
        migration.indexOf("$$;", migration.indexOf("create function public.tact_runs_principals_bootstrap_local_auth_user"))
      ).match(/\bexecute\s+'/i)
  ));

  // ---- migration order: table -> RLS -> trigger (future-safe) -> backfill -> verification -> FK retarget ----
  results.push(check(
    "[order] trigger installation precedes the backfill INSERT, which precedes the fail-fast verification, which precedes the six FK retargets",
    (() => {
      const tableIndex = migration.indexOf("create table public.tact_runs_principals");
      const triggerIndex = migration.indexOf("create trigger trg_tact_runs_principals_bootstrap_local_auth_user");
      const backfillIndex = migration.indexOf("select id, 'runs-local-auth', id::text, id, 'local_runs_user'\nfrom auth.users");
      const verifyIndex = migration.indexOf("SOR-260 Phase 1 backfill incomplete");
      const fkIndex = migration.indexOf("alter table public.tact_canonical_executions\n  drop constraint");
      return tableIndex !== -1 && triggerIndex !== -1 && backfillIndex !== -1 && verifyIndex !== -1 && fkIndex !== -1 &&
        tableIndex < triggerIndex && triggerIndex < backfillIndex && backfillIndex < verifyIndex && verifyIndex < fkIndex;
    })()
  ));

  results.push(check(
    "[backfill] safe to run alongside the trigger (ON CONFLICT (id) DO NOTHING, idempotent on its own terms)",
    migration.includes("select id, 'runs-local-auth', id::text, id, 'local_runs_user'\nfrom auth.users\non conflict (id) do nothing")
  ));

  // ---- exactly six FK retargets, all to tact_runs_principals(id), all RESTRICT, none CASCADE ----
  for (const table of SIX_PHASE1_TABLES) {
    results.push(check(
      `[FK retarget] ${table}.user_id is dropped and re-added referencing tact_runs_principals(id) on delete restrict`,
      migration.includes(`alter table public.${table}`) &&
        new RegExp(`alter table public\\.${table}[\\s\\S]{0,400}?references public\\.tact_runs_principals \\(id\\) on delete restrict`).test(migration)
    ));
  }

  results.push(check(
    "[FK retarget] exactly six references to tact_runs_principals(id), one per Phase-1 table — no more, no fewer",
    (migration.match(/references public\.tact_runs_principals \(id\) on delete restrict/g) ?? []).length === 6
  ));

  results.push(check(
    "[FK retarget] no CASCADE anywhere in the six retarget statements (uniform RESTRICT, Human Owner decision 2)",
    !/references public\.tact_runs_principals \(id\) on delete cascade/.test(migration)
  ));

  results.push(check(
    "[scope] no table outside the six Phase-1 tables is retargeted to tact_runs_principals in this migration",
    (migration.match(/drop constraint if exists \w+_user_id_fkey/g) ?? []).length === 6
  ));

  return summarize("SOR-260 Phase 1 — tact_runs_principals Migration Contract", results);

}
