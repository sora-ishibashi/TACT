// =========================
// SOR-130 Reality Test — local Supabase env bootstrap
// =========================
//
// core/database/supabaseServiceRole.tsのgetServiceRoleClient()は
// process.env.NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEYを
// 呼び出し時(lazy)に読む。このfileはReality Testスクリプトの先頭で
// 呼ばれ、SOR130_LOCAL_SUPABASE_*からその2つのenv varを設定する。
//
// 絶対的なガード: URLが127.0.0.1/localhostを含まない場合は即座に
// 例外を投げる(Staging/Productionへの誤接続を防ぐ、fail-closed)。
// このfileはcredentialの値そのものを一切ログ出力しない。

export function applyLocalSupabaseEnv(): void {

  const url = process.env.SOR130_LOCAL_SUPABASE_URL;
  const serviceRoleKey = process.env.SOR130_LOCAL_SUPABASE_SERVICE_ROLE_KEY;

  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "SOR130_LOCAL_SUPABASE_URL is not set. Run `supabase status -o env` and pass API_URL as this variable."
    );
  }

  if (typeof serviceRoleKey !== "string" || serviceRoleKey.length === 0) {
    throw new Error(
      "SOR130_LOCAL_SUPABASE_SERVICE_ROLE_KEY is not set. Run `supabase status -o env` and pass SERVICE_ROLE_KEY as this variable."
    );
  }

  if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(
      "SOR130_LOCAL_SUPABASE_URL does not point at localhost. Refusing to run against a non-local Supabase project (Staging/Production must never be touched by this Reality Test)."
    );
  }

  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;

  console.log(`[sor130-reality-test] using local Supabase at ${url}`);

}
