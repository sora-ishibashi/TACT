// =========================
// TACT Work — Trusted-Caller User Override for Event Claim Functions
// (EVENT-P1d Phase1)
// =========================
//
// 対象: supabase/migrations/20261017000000_add_trusted_user_to_event_
// claim_functions.sql。
//
// tests/tact/work/eventWaitClaim.test.tsと同じ既存規約(実Supabase
// 接続を伴うtestを持たない)に従い、SQL function自体のsemanticsは
// migration sourceのtext検査で構造的に確認する。current_user =
// 'service_role'の実際のPostgres接続role判定・cross-user override拒否
// は、Staging Postgres Reality Test(EVENT-P1d Phase9)で実DBに対して
// 検証する——このfileはそこでは検証できない「そもそもauth.role()を
// 使っていない/SECURITY DEFINERにしていない/既存P1c migrationを
// 書き換えていない」という静的な契約だけを確認する。

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

function stripSqlComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const NEW_MIGRATION_PATH = "supabase/migrations/20261017000000_add_trusted_user_to_event_claim_functions.sql";
const EXISTING_MIGRATION_PATH = "supabase/migrations/20261016010000_create_event_wait_claim_functions.sql";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const migrationExists = existsSync(join(REPO_ROOT, NEW_MIGRATION_PATH));

  results.push(
    check(
      "[絶対条件] 新しいmigration fileが作成されている(既存の20261016010000を直接編集していない)",
      migrationExists
    )
  );

  if (!migrationExists) {
    return summarize("work/eventWaitTrustedUser", results);
  }

  const migration = readRepoFile(NEW_MIGRATION_PATH);
  const stripped = stripSqlComments(migration);

  // =========================
  // A. auth.role()を使っていないこと(ユーザーの明示的な修正指示)
  // =========================

  results.push(
    check(
      "[絶対条件、最重要] auth.role()を一切使用していない(Supabase非推奨、current_user = 'service_role'を使う)",
      !/auth\.role\s*\(/i.test(stripped)
    )
  );

  results.push(
    check(
      "[絶対条件] current_user = 'service_role'による効果的userの判定が存在する",
      /current_user\s*=\s*'service_role'/.test(stripped)
    )
  );

  // =========================
  // B. SECURITY INVOKERのまま(SECURITY DEFINERを宣言していない)
  // =========================

  results.push(
    check(
      "[絶対条件] SECURITY DEFINERを宣言していない(SECURITY INVOKERのまま)",
      !/security definer/i.test(stripped)
    )
  );

  // =========================
  // C. 両function共通のsignature拡張(p_trusted_user_id uuid default null)
  // =========================

  results.push(
    check(
      "[Phase1] tact_claim_matched_event_waitがp_trusted_user_id uuid default nullを受け取る",
      /create or replace function public\.tact_claim_matched_event_wait\(\s*p_event_id uuid,\s*p_wait_id uuid,\s*p_trusted_user_id uuid default null\s*\)/.test(
        stripped
      )
    )
  );

  results.push(
    check(
      "[Phase1] tact_match_and_claim_external_eventがp_trusted_user_id uuid default nullを受け取る",
      /create or replace function public\.tact_match_and_claim_external_event\(\s*p_event_id uuid,\s*p_trusted_user_id uuid default null\s*\)/.test(
        stripped
      )
    )
  );

  // =========================
  // D. 既存の認証済みuser経路(auth.uid())が両function内にまだ残っている
  //    (fallback、絶対条件: 既存経路を壊さない)
  // =========================

  results.push(
    check(
      "[絶対条件] 両functionとも、else節でauth.uid()へfallbackしている(非service_role接続では常にauth.uid()を使う)",
      (stripped.match(/else\s+auth\.uid\(\)/g) ?? []).length === 2
    )
  );

  // =========================
  // E. effective user idがownership判定に実際に使われている
  //    (auth.uid()の直接比較を残していない)
  // =========================

  results.push(
    check(
      "[Phase1] tact_claim_matched_event_wait本体は、ownership比較にv_effective_user_id(auth.uid()の直接比較ではない)を使っている",
      /and user_id = v_effective_user_id/.test(stripped) &&
        /and w\.user_id = v_effective_user_id/.test(stripped)
    )
  );

  results.push(
    check(
      "[Phase1] tact_match_and_claim_external_event本体も、初期eventルックアップにv_effective_user_idを使っている",
      /where id = p_event_id\s*\n\s*and user_id = v_effective_user_id/.test(stripped)
    )
  );

  // =========================
  // F. tact_match_and_claim_external_event内部の再帰呼び出しへ
  //    trusted user idを引き継いでいること(絶対条件、最重要)
  // =========================

  results.push(
    check(
      "[絶対条件、最重要] tact_match_and_claim_external_event内部のtact_claim_matched_event_wait呼び出しにv_effective_user_idを渡している(内側のfunctionが独自にauth.uid()だけで判定して失敗しないようにする)",
      /return public\.tact_claim_matched_event_wait\(v_event\.id, v_wait_id, v_effective_user_id\)/.test(stripped)
    )
  );

  // =========================
  // G. tact_create_event_waitはこのmigrationで一切変更していない(scope外)
  // =========================

  results.push(
    check(
      "[絶対条件] tact_create_event_waitはこのmigrationで定義/変更されていない(EVENT-P1dのscope外)",
      !stripped.includes("tact_create_event_wait")
    )
  );

  // =========================
  // H. 既存のP1c migration file自体を書き換えていないこと
  //    (絶対条件: 既に適用済みのmigrationをin placeで編集しない)
  // =========================

  try {

    const gitDiff = execFileSync(
      "git",
      ["diff", "--stat", "HEAD", "--", EXISTING_MIGRATION_PATH],
      { cwd: REPO_ROOT, encoding: "utf-8" }
    );

    results.push(
      check(
        "[絶対条件] 既存の20261016010000_create_event_wait_claim_functions.sqlはこのbranchで一切変更されていない(git diffが空)",
        gitDiff.trim().length === 0
      )
    );

  } catch (error) {

    results.push(
      check(
        "[絶対条件] 既存migrationのgit diff確認(git実行自体が失敗した場合はfail、fail closed)",
        false,
        error instanceof Error ? error.message : String(error)
      )
    );

  }

  // =========================
  // I. 既存のCAS/lock/expiry/terminal work等のbusiness logicが
  //    そのまま維持されていること(eventWaitClaim.test.tsのSection構造
  //    確認と同じ観点、コピー漏れ/改変が無いことの確認)
  // =========================

  const existingMigration = readRepoFile(EXISTING_MIGRATION_PATH);
  const existingStripped = stripSqlComments(existingMigration);

  results.push(
    check(
      "[絶対条件] expiry判定(received_at >= expires_at)がそのまま維持されている",
      /v_wait\.expires_at is not null and v_event\.received_at >= v_wait\.expires_at/.test(stripped)
    )
  );

  results.push(
    check(
      "[絶対条件] terminal Work/Taskでのpending EventWait cancel分岐がそのまま維持されている",
      /update public\.tact_event_waits\s*\n\s*set status = 'cancelled'/.test(stripped)
    )
  );

  results.push(
    check(
      "[絶対条件] min(uuid)ではなくmin(id::text)::uuidのcast-through-text(既存P1c修正済みfix)がそのまま維持されている",
      /min\(id::text\)::uuid/.test(stripped) && /min\(id::text\)::uuid/.test(existingStripped)
    )
  );

  return summarize("work/eventWaitTrustedUser", results);

}
