// =========================
// TACT Runtime — One-Shot Reconciliation (Trusted Operator CLI)
// (P5d: Trusted Bot-Owned Run Compatibility Fix)
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
//   - SUPABASE_SERVICE_ROLE_KEY
//   - TRIGGER_SECRET_KEY / TACT_RUNTIME_TRIGGER_DEV_ENABLED
//     (resolveRuntimeIntegrationReadAdapter()が読む、既存のまま)
//
// 使い方:
//   npx tsx scripts/reconcileOneShotIntegrationReadAsTrustedActor.ts \
//     --workId <workId> --taskId <taskId> --runId <runId>
//
// secret値はこのscript自身が一切console出力しない(reconcileの
// outcome——status/run/error.code等の既にsanitize済みの値——だけを
// 出力する)。
import { reconcileOneShotIntegrationReadAsTrustedActor } from "../core/tact-runtime/reconcileOneShotIntegrationReadAsTrustedActor";

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

main().catch((error) => {
  console.error("reconcileOneShotIntegrationReadAsTrustedActor failed:", error);
  process.exitCode = 1;
});
