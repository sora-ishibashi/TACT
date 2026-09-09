// =========================
// TACT — Migration Drift Check (SEC-P0-4: Pre-Live Remediation)
// =========================
//
// 目的: repository上のsupabase/migrations/*.sqlと、実際にProduction
// (または指定したSupabaseプロジェクト)へ適用済みのmigrationを比較し、
// 未適用のものがあればnon-zero exitで知らせる。
//
// 過去実事故(docs/architecture/pre-live-full-audit.md P0 finding #4):
// tact_clarifications・tact_audit_events・allowed_approver_idsが
// Production Supabaseへ未適用のまま気づかずに運用していた。この
// scriptはそれを事前に検知するための最小限のoperator向けツール。
//
// 絶対条件:
//   - automatic migration applyは一切行わない(読み取りのみ)。
//   - Production DBを変更しない。
//   - secret値(SUPABASE_SERVICE_ROLE_KEY等)は一切出力しない
//     (missingなmigration fileの"名前"だけを出力する)。
//   - local/operatorから明示的に実行できる(npm run check:migrations)。
//   - missing migrationがあればexit code 1、check自体が実行できな
//     かった場合はexit code 2で区別する(「drift確定」と「検証不能」
//     を混同しない)。
//
// 使い方:
//   npx tsx scripts/checkMigrationDrift.ts
//   (SUPABASE_SERVICE_ROLE_KEY・NEXT_PUBLIC_SUPABASE_URLが必要——
//   supabase/migrations/20260914000000_create_tact_check_applied_
//   migrations_function.sqlが対象Supabaseへ適用済みであること)
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getServiceRoleClient } from "../core/database/supabaseServiceRole";

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

// ファイル名は `<version>_<description>.sql` 形式(既存の全migration
// ファイルが一貫してこの規則に従っている、supabase/migrations/*.sql
// 参照)。versionはCLIが`supabase_migrations.schema_migrations.version`
// へそのまま記録する値と同じ文字列。
const MIGRATION_FILENAME_PATTERN = /^(\d+)_.*\.sql$/;

export function extractMigrationVersion(filename: string): string | null {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename);
  return match ? match[1] : null;
}

export function getLocalMigrationVersions(migrationsDir: string = MIGRATIONS_DIR): string[] {

  let filenames: string[];

  try {
    filenames = readdirSync(migrationsDir);
  } catch {
    return [];
  }

  return filenames
    .map(extractMigrationVersion)
    .filter((version): version is string => version !== null)
    .sort();

}

export interface MigrationDriftResult {
  missing: string[];
}

// 純粋関数として切り出す(実DB接続なしにunit testできるようにする、
// このrepositoryの既存test方針——LLM call = 0 / Search API call = 0/
// 実DB接続 = 0——をこのscriptにも適用する)。
export function computeMigrationDrift(
  localVersions: string[],
  appliedVersions: string[]
): MigrationDriftResult {

  const appliedSet = new Set(appliedVersions);

  return {
    missing: localVersions.filter((version) => !appliedSet.has(version)),
  };

}

// EXIT_OK: driftなし。EXIT_DRIFT: 未適用migrationを検出(non-zero、
// 絶対条件)。EXIT_CHECK_FAILED: そもそも検証できなかった
// (service role未設定・RPC呼び出し失敗等)——「drift確定」と
// 「検証不能」を呼び出し元が区別できるよう、別のexit codeにする。
export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_CHECK_FAILED = 2;

async function main(): Promise<number> {

  const localVersions = getLocalMigrationVersions();

  if (localVersions.length === 0) {
    console.error(
      "checkMigrationDrift: no local migration files found under " +
      "supabase/migrations/. Refusing to report success against an " +
      "empty comparison set."
    );
    return EXIT_CHECK_FAILED;
  }

  const client = getServiceRoleClient();

  if (!client) {
    console.error(
      "checkMigrationDrift: SUPABASE_SERVICE_ROLE_KEY is not configured " +
      "in this environment. Cannot verify migration drift (secret value " +
      "itself is never logged)."
    );
    return EXIT_CHECK_FAILED;
  }

  const { data, error } = await client.rpc("tact_check_applied_migrations");

  if (error) {
    console.error(
      "checkMigrationDrift: failed to read applied migration history " +
      "via tact_check_applied_migrations(). Has " +
      "supabase/migrations/20260914000000_create_tact_check_applied_" +
      "migrations_function.sql been applied to this project yet? " +
      `(error code: ${error.code ?? "unknown"})`
    );
    return EXIT_CHECK_FAILED;
  }

  const appliedVersions = (data ?? []).map((row: { version: string }) => row.version);

  const { missing } = computeMigrationDrift(localVersions, appliedVersions);

  if (missing.length > 0) {

    console.error(
      `checkMigrationDrift: ${missing.length} local migration(s) are NOT ` +
      "applied to this Supabase project yet:"
    );

    for (const version of missing) {
      console.error(`  - ${version}`);
    }

    return EXIT_DRIFT;

  }

  console.log(
    `checkMigrationDrift: OK — all ${localVersions.length} local ` +
    "migration(s) are applied."
  );

  return EXIT_OK;

}

if (require.main === module) {

  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error("checkMigrationDrift: unexpected failure.", error);
      process.exitCode = EXIT_CHECK_FAILED;
    });

}
