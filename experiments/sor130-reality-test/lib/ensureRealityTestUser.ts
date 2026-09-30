// =========================
// SOR-130 Reality Test — fixture auth user
// =========================
//
// tact_canonical_executions.user_idはauth.users(id)への外部キー
// (supabase/migrations/20261020000000_create_tact_canonical_
// executions.sql)。ローカルSupabaseのauth.usersには最初何も存在しない
// ため、実際にcaptureExecution()を通すには実在するuserが必要——ランダム
// なUUIDを使い回しても外部キー制約でinsertが失敗する(実際にそうなった、
// 推測で回避しない)。Admin APIで専用のfixture userを1つ作成(既に
// 存在すれば再利用)し、そのidを返す。

import type { SupabaseClient } from "@supabase/supabase-js";

const FIXTURE_EMAIL = "sor130-reality-test@local.test";

export async function ensureRealityTestUser(client: SupabaseClient): Promise<string> {

  const { data: created, error: createError } = await client.auth.admin.createUser({
    email: FIXTURE_EMAIL,
    email_confirm: true,
  });

  if (created?.user?.id) {
    return created.user.id;
  }

  // 既に存在する場合(2回目以降の実行)はlistUsersから探す。
  if (createError) {
    const { data: list, error: listError } = await client.auth.admin.listUsers();
    if (listError) {
      throw new Error(`failed to create or find the SOR-130 reality test fixture user: ${listError.message}`);
    }
    const existing = list.users.find((u) => u.email === FIXTURE_EMAIL);
    if (existing) {
      return existing.id;
    }
    throw new Error(`failed to create the SOR-130 reality test fixture user: ${createError.message}`);
  }

  throw new Error("failed to create the SOR-130 reality test fixture user: no user returned");

}
