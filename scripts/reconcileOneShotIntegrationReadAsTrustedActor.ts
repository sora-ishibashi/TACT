// =========================
// TACT Runtime — One-Shot Reconciliation (Trusted Operator CLI)
// (P5d: Trusted Bot-Owned Run Compatibility Fix / P5e: Operational Hardening)
// =========================
//
// 目的: Production Slack Bot経路で解決されたTACT userが所有する
// ambiguous Run(status=running・externalRef=null)を、そのuserの
// Supabase access tokenをユーザーに取得・表示・転送させることなく、
// server-only(=このscriptを実行するoperator自身の手元)でreconcileする。
//
// 絶対条件: このscriptはHTTP経由では一切公開されない
// (app/api/配下に対応するrouteは存在しない)。実行にはこのscriptを
// 動かすshell自身が、TACT Productionと同じ以下の資格情報を
// 環境変数として保持している必要がある(=既にVercel Production
// 環境変数へのアクセス権を持つoperatorしか実行できない、新しい
// 権限や新しいsecretを一切増やさない):
//   - NEXT_PUBLIC_SUPABASE_URL
//   - NEXT_PUBLIC_SUPABASE_ANON_KEY
//   - SUPABASE_SERVICE_ROLE_KEY
//   - TRIGGER_SECRET_KEY
//   - TACT_RUNTIME_TRIGGER_DEV_ENABLED
//     (resolveRuntimeIntegrationReadAdapter()が読む、既存のまま)
//
// 使い方:
//   npx tsx scripts/reconcileOneShotIntegrationReadAsTrustedActor.ts \
//     --workId <workId> --taskId <taskId> --runId <runId>
//
// secret値はこのscript自身が一切console出力しない(reconcileの
// outcome——status/run/error.code等の既にsanitize済みの値——だけを
// 出力する)。
//
// P5e-2(Live Acceptanceで実際に発覚した運用上の欠陥の最小修正):
// 従来はNEXT_PUBLIC_SUPABASE_ANON_KEY未設定・invalid service role key
// といった環境不備が、reconciliation処理へ実際に入ってから
// (Supabase呼び出しが失敗して初めて)分かる、分かりづらいエラーとして
// 表面化した。以下の必須env(TACT_RUNTIME_TRIGGER_DEV_ENABLEDを除く
// ——後述)が欠けている場合は、reconciliation処理へ一切入る前に
// fail-fastする。
//
// TACT_RUNTIME_TRIGGER_DEV_ENABLEDを必須preflight対象から除く理由:
// この値が未設定/"true"以外の場合、既存resolveRuntimeIntegrationRead
// Adapter()が意図的に{status:"disabled"}を返し、
// reconcileOneShotIntegrationRead()が既存reason"runtime_unavailable"
// として安全に扱う——これは「設定不備」ではなく「Runtime routingが
// 無効化されている」という正当などちらもありうる状態であり、preflight
// でfail-fastすべきエラー状態ではない(既存の意図的なopt-in設計を
// preflightが壊さないようにする)。
import { reconcileOneShotIntegrationReadAsTrustedActor } from "../core/tact-runtime/reconcileOneShotIntegrationReadAsTrustedActor";

// 値・長さ・prefixのいずれも表示しない——変数名だけを安全に報告する
// (絶対条件、secret leakage防止)。
const REQUIRED_ENV_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TRIGGER_SECRET_KEY",
] as const;

// process.envそのものではなく緩いRecord型を受け取る(既存
// core/tact-runtime/providers/triggerDev.tsのTriggerDevEnvSourceと
// 同じ既存パターン——process.env自体は構造的にこの型を満たすため
// 既定値としてそのまま渡せつつ、testがfakeなenv objectを渡しやすい)。
export type EnvSource = Record<string, string | undefined>;

export function getMissingRequiredEnv(
  env: EnvSource = process.env
): string[] {

  return REQUIRED_ENV_VARS.filter((name) => !env[name]);

}

function parseArg(name: string): string | undefined {

  const prefix = `--${name}=`;
  const withEquals = process.argv.find((arg) => arg.startsWith(prefix));

  if (withEquals) {
    return withEquals.slice(prefix.length);
  }

  const flagIndex = process.argv.indexOf(`--${name}`);

  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1];
  }

  return undefined;

}

async function main() {

  // P5e-2: reconciliation処理・DB接続のいずれも一切行う前に、
  // 最初にfail-fastする(絶対条件: secret値・長さ・prefixは出力しない、
  // 変数名だけを報告する)。
  const missing = getMissingRequiredEnv();

  if (missing.length > 0) {

    for (const name of missing) {
      console.error(`Missing required environment variable: ${name}`);
    }

    process.exitCode = 1;

    return;

  }

  const workId = parseArg("workId");
  const taskId = parseArg("taskId");
  const runId = parseArg("runId");

  if (!workId || !taskId || !runId) {

    console.error(
      "Usage: npx tsx scripts/reconcileOneShotIntegrationReadAsTrustedActor.ts " +
      "--workId <workId> --taskId <taskId> --runId <runId>"
    );

    process.exitCode = 1;

    return;

  }

  const result = await reconcileOneShotIntegrationReadAsTrustedActor({ workId, taskId, runId });

  // secret safety: resultはreconcileOneShotIntegrationRead()の
  // sanitize済み戻り値のみ(accessToken/service role key/Trigger
  // secretはこの型のどこにも含まれない、既存test群で構造的に確認済み)。
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }

}

// tsxでこのfileを直接実行した場合のみmain()を走らせる(testからの
// importではmain()が自動実行されない、既存tests/tact/runAll.tsの
// 各test fileがrun()をexportするだけで自動実行しないのと同じ規律)。
if (require.main === module) {

  main().catch((error) => {
    console.error("reconcileOneShotIntegrationReadAsTrustedActor failed:", error);
    process.exitCode = 1;
  });

}
