#!/usr/bin/env bash
# =========================
# Yolna Runs Standalone — Migration Independence Check (SOR-135 Phase 3)
# =========================
#
# CI building block (section 12 instructions). Requires the disposable
# local Supabase project under products/yolna-runs/supabase/ to already
# be running (`npx supabase start`, from this directory) — this script
# never touches root Yolna's local Supabase (a different project_id/port
# range, see supabase/config.toml's header comment) or any cloud project.
#
# Checks, in order:
#   1. `supabase db reset` applies every Runs-owned migration to an empty
#      database cleanly (exit non-zero on any migration error).
#   2. Zero Yolna-owned tables exist afterward (tact_works, tact_connections,
#      tact_conversations, tact_bot_*, tact_artifacts, tact_tasks, the
#      Yolna-side tact_runs execution-attempt table, tact_approvals,
#      tact_clarifications, etc.).
#   3. Zero foreign keys in this schema reference a table outside this
#      schema's own 10 Runs-owned tables.
#
# Usage: bash scripts/dbIndependenceCheck.sh (from products/yolna-runs/)

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_CONTAINER="supabase_db_yolna-runs"

echo "[dbIndependenceCheck] 1/3: applying migrations to an empty database (supabase db reset)..."
npx supabase db reset

echo "[dbIndependenceCheck] 2/3: checking for Yolna-owned tables..."

# Every Yolna-owned table this product's schema must never create, drawn
# from the root Yolna schema's own migration history (supabase/migrations/
# at the repo root) — not an exhaustive guess, the actual table names.
YOLNA_OWNED_TABLES="tact_works tact_tasks tact_runs tact_approvals tact_clarifications tact_connections tact_conversations tact_conversation_messages tact_conversation_workflow_runs tact_artifacts tact_attachments tact_audit_events tact_projects tact_bot_conversation_links tact_external_identities tact_bot_processed_events tact_memory tact_execution_history tact_core_knowledge tact_core_memories tact_core_examples"

FOUND_YOLNA_TABLES=""
for t in $YOLNA_OWNED_TABLES; do
  EXISTS=$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc \
    "select 1 from information_schema.tables where table_schema='public' and table_name='$t'")
  if [ "$EXISTS" = "1" ]; then
    FOUND_YOLNA_TABLES="$FOUND_YOLNA_TABLES $t"
  fi
done

if [ -n "$FOUND_YOLNA_TABLES" ]; then
  echo "[dbIndependenceCheck] FAIL: Yolna-owned table(s) found in the Runs schema:$FOUND_YOLNA_TABLES"
  exit 1
fi

echo "[dbIndependenceCheck] PASS: 0 Yolna-owned tables present"

echo "[dbIndependenceCheck] 3/3: auditing foreign keys for cross-product references..."

RUNS_OWNED_TABLES="tact_canonical_executions tact_execution_permission_decisions tact_execution_permission_rules tact_execution_work_correlations tact_execution_attentions tact_execution_outcomes tact_execution_observation_registry tact_execution_ingestion_failures tact_runs_work_projection tact_runs_conversation_link_projection"

FK_AUDIT=$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc "
  select tc.table_name || ' -> ' || ccu.table_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
  join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
  where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
    and ccu.table_name <> 'users';
")

CROSS_PRODUCT_FKS=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  target_table=$(echo "$line" | sed 's/.*-> //')
  if ! echo "$RUNS_OWNED_TABLES" | grep -qw "$target_table"; then
    CROSS_PRODUCT_FKS="$CROSS_PRODUCT_FKS\n  $line"
  fi
done <<< "$FK_AUDIT"

if [ -n "$CROSS_PRODUCT_FKS" ]; then
  echo -e "[dbIndependenceCheck] FAIL: foreign key(s) referencing a table outside this schema's own Runs-owned tables:$CROSS_PRODUCT_FKS"
  exit 1
fi

echo "[dbIndependenceCheck] PASS: 0 cross-product foreign keys (all FKs target this schema's own tables, or auth.users)"

echo "[dbIndependenceCheck] PASS: migration independence fully verified"
