// =========================
// TACT Runtime — One-Shot Reconciliation CLI Preflight Regression
// (P5e: Runtime Reconciliation Operational Hardening)
// =========================
//
// 対象: scripts/reconcileOneShotIntegrationReadAsTrustedActor.tsの
// getMissingRequiredEnv()。実Supabase・実Trigger.devへの接続、
// process.argv/console.log/process.exitCodeへの副作用のいずれも
// 発生させない(main()自体は一切呼ばない、fake env objectを渡す
// 純粋関数呼び出しのみ)。
//
// このsuiteの責務: 「reconciliation処理へ実際に入る前に、必須envの
// 欠落をfail-fastで検出できるか」だけを確認する。preflightを通過した
// 後のreconciliation本体の挙動(Trigger start=0・Provider call=0・
// createRun=0等)は、既存runtime/reconcileOneShotEntrypoint.test.ts・
// runtime/reconcileOneShotIntegrationReadAsTrustedActor.test.ts・
// runtime/reconciliation.test.tsで構造的に検証済みのため、ここでは
// 「このCLI script自身がそれらのAPIを直接importしていない」ことの
// source-level確認に留める(二重テストを避ける)。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMissingRequiredEnv, type EnvSource } from "../../../scripts/reconcileOneShotIntegrationReadAsTrustedActor";
import { check, summarize, type CheckResult } from "../lib/check";

// 値は一切使わない(fail-fast判定は「keyが存在するかどうか」だけを
// 見るため)——テスト自身もsecretらしき値を書き込まない。
const ALL_REQUIRED_SET: EnvSource = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-placeholder",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-placeholder",
  TRIGGER_SECRET_KEY: "trigger-secret-placeholder",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [5] NEXT_PUBLIC_SUPABASE_URL欠落 -> execution開始前fail(missingリストに含まれる) ----
  {
    const env = { ...ALL_REQUIRED_SET };
    delete env.NEXT_PUBLIC_SUPABASE_URL;

    const missing = getMissingRequiredEnv(env);

    results.push(
      check(
        "[5] NEXT_PUBLIC_SUPABASE_URL欠落時、getMissingRequiredEnv()がこれを検出する(reconciliation処理へ入る前にfail-fast)",
        missing.includes("NEXT_PUBLIC_SUPABASE_URL")
      )
    );
  }

  // ---- [6] NEXT_PUBLIC_SUPABASE_ANON_KEY欠落 -> execution開始前fail ----
  {
    const env = { ...ALL_REQUIRED_SET };
    delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const missing = getMissingRequiredEnv(env);

    results.push(
      check(
        "[6] NEXT_PUBLIC_SUPABASE_ANON_KEY欠落時、getMissingRequiredEnv()がこれを検出する(Live Acceptanceで実際に分かりづらいerrorの原因になったcase)",
        missing.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY")
      )
    );
  }

  // ---- [7] SUPABASE_SERVICE_ROLE_KEY欠落 -> execution開始前fail ----
  {
    const env = { ...ALL_REQUIRED_SET };
    delete env.SUPABASE_SERVICE_ROLE_KEY;

    const missing = getMissingRequiredEnv(env);

    results.push(
      check(
        "[7] SUPABASE_SERVICE_ROLE_KEY欠落時、getMissingRequiredEnv()がこれを検出する",
        missing.includes("SUPABASE_SERVICE_ROLE_KEY")
      )
    );
  }

  // ---- [8] TRIGGER_SECRET_KEY欠落 -> execution開始前fail ----
  {
    const env = { ...ALL_REQUIRED_SET };
    delete env.TRIGGER_SECRET_KEY;

    const missing = getMissingRequiredEnv(env);

    results.push(
      check(
        "[8] TRIGGER_SECRET_KEY欠落時、getMissingRequiredEnv()がこれを検出する",
        missing.includes("TRIGGER_SECRET_KEY")
      )
    );
  }

  // ---- [9] TACT_RUNTIME_TRIGGER_DEV_ENABLED欠落/disabledは、CLI preflightのfail-fast対象に含めない(既存resolveRuntimeIntegrationReadAdapter()のdisabled/misconfigured区別という既存挙動にそのまま委ねる) ----
  {
    const missingWithoutFlag = getMissingRequiredEnv(ALL_REQUIRED_SET); // TACT_RUNTIME_TRIGGER_DEV_ENABLEDを含まないenv

    results.push(
      check(
        "[9] TACT_RUNTIME_TRIGGER_DEV_ENABLEDが無くてもgetMissingRequiredEnv()はfail-fast対象に含めない(既存resolveRuntimeIntegrationReadAdapter()のdisabled/runtime_unavailableという既存の意図的な挙動へ委ねる、preflightが正当なopt-out状態を壊さない)",
        !missingWithoutFlag.includes("TACT_RUNTIME_TRIGGER_DEV_ENABLED") && missingWithoutFlag.length === 0
      )
    );
  }

  // ---- [10] 必須envが全て揃っている場合、getMissingRequiredEnv()は空配列を返す(preflightを通過し、既存reconciliation pathへ進める) ----
  {
    const missing = getMissingRequiredEnv(ALL_REQUIRED_SET);

    results.push(
      check(
        "[10] 必須env(NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY/TRIGGER_SECRET_KEY)が全て揃っている場合、missing=[](preflight通過、既存reconcileOneShotIntegrationReadAsTrustedActor()経由の既存pathへそのまま進める)",
        missing.length === 0
      )
    );
  }

  // ---- [11/12/13] CLI script自身がProvider実行/Trigger dispatch/createRunのAPIを一切importしていない(source-level構造的証拠、Trigger start=0・Provider call=0・createRun=0はこのCLIが追加の呼び出し経路を持たないことで保証される) ----
  {
    const cliSource = readFileSync(
      join(__dirname, "..", "..", "..", "scripts", "reconcileOneShotIntegrationReadAsTrustedActor.ts"),
      "utf-8"
    );

    const forbiddenReferences = [
      "dispatchIntegrationReadToRuntime",
      "startExecution",
      "executeRuntimeIntegrationReadTask",
      "executeIntegrationActionCore",
      "TriggerDevRuntimeAdapter",
      "createRun",
    ];

    const found = forbiddenReferences.filter((name) => cliSource.includes(name));

    results.push(
      check(
        "[11/12/13] CLI script自身はreconcileOneShotIntegrationReadAsTrustedActor()の呼び出し以外、Provider実行/Trigger dispatch/createRun関連のAPIを一切importも参照もしていない(Trigger start=0・Provider call=0・createRun=0の構造的保証)",
        found.length === 0,
        found.length > 0 ? `unexpected references: ${found.join(", ")}` : undefined
      )
    );
  }

  return summarize("runtime/reconcileOneShotIntegrationReadAsTrustedActorCli", results);

}
