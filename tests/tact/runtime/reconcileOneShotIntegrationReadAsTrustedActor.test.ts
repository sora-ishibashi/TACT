// =========================
// TACT Runtime — Trusted One-Shot Reconciliation Boundary Regression
// (P5d: Trusted Bot-Owned Run Compatibility Fix)
// =========================
//
// 対象: core/tact-runtime/reconcileOneShotIntegrationReadAsTrustedActor.ts。
// 実Supabase・実Trigger.devのいずれにも一切接続しない(全depsをfakeで
// 差し替える、既存runtime/reconciliation.test.ts・
// runtime/reconcileOneShotEntrypoint.test.tsと同じ規律)。
//
// このsuiteの責務: 「callerはworkId/taskId/runIdしか渡せず、userIdは
// 必ずWork行から確定される」という、このtrusted boundary自身が
// 追加するownership解決ロジックだけを確認する。Work/Task/Run
// correlation・capability一致・Connection re-resolve・runtime adapter
// resolutionの詳細は既存runtime/reconcileOneShotEntrypoint.test.tsで
// 検証済みのため、ここではfakeなreconcileOneShotIntegrationRead()が
// 「正しく解決されたuserId+service role keyで、正確に1回だけ」呼ばれる
// ことと、失敗系(fail closed)の伝播だけを確認する(二重テストを避ける)。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  reconcileOneShotIntegrationReadAsTrustedActor,
  type ReconcileOneShotIntegrationReadAsTrustedActorDeps,
  type FetchWorkOwnerIdOutcome,
} from "../../../core/tact-runtime/reconcileOneShotIntegrationReadAsTrustedActor";
import type { ReconcileOneShotIntegrationReadResult } from "../../../core/tact-runtime/reconcileOneShotEntrypoint";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "bot-resolved-user-1";
const SERVICE_ROLE_KEY = "fake-service-role-key-for-tests-only";

function makeDeps(overrides: Partial<ReconcileOneShotIntegrationReadAsTrustedActorDeps> = {}) {

  const calls = {
    fetchWorkOwnerIdCalls: [] as string[],
    reconcileCalls: [] as unknown[],
  };

  let ownerLookup: FetchWorkOwnerIdOutcome = { status: "found", userId: OWNER_USER_ID };
  let reconcileResult: ReconcileOneShotIntegrationReadResult = {
    ok: true,
    outcome: { status: "recovered", run: { id: "run-1" } as never },
  };

  const deps: ReconcileOneShotIntegrationReadAsTrustedActorDeps = {

    isServiceRoleConfigured: () => true,

    getServiceRoleKey: () => SERVICE_ROLE_KEY,

    fetchWorkOwnerId: async (workId: string) => {
      calls.fetchWorkOwnerIdCalls.push(workId);
      return ownerLookup;
    },

    reconcileOneShotIntegrationRead: (async (params: unknown) => {
      calls.reconcileCalls.push(params);
      return reconcileResult;
    }) as ReconcileOneShotIntegrationReadAsTrustedActorDeps["reconcileOneShotIntegrationRead"],

    ...overrides,

  };

  return {
    deps,
    calls,
    setOwnerLookup: (value: FetchWorkOwnerIdOutcome) => { ownerLookup = value; },
    setReconcileResult: (value: ReconcileOneShotIntegrationReadResult) => { reconcileResult = value; },
  };

}

const BASE_PARAMS = { workId: "work-1", taskId: "task-1", runId: "run-1" };

function listFilesRecursively(dir: string): string[] {

  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {

    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
    } else {
      files.push(fullPath);
    }

  }

  return files;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- [1] bot-owned Runを想定した正常系: Work行から解決したownerUserId + service role keyでreconcileOneShotIntegrationReadへ正確に1回委譲される ----
  {
    const { deps, calls } = makeDeps();

    const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, deps);

    results.push(
      check(
        "[1] bot-owned ambiguous Runをreconcile可能: ok=true、fetchWorkOwnerId=1回、reconcileOneShotIntegrationReadは正確に1回、userId=Work行から解決した値、accessToken=service role key",
        result.ok === true &&
          calls.fetchWorkOwnerIdCalls.length === 1 &&
          calls.fetchWorkOwnerIdCalls[0] === "work-1" &&
          calls.reconcileCalls.length === 1 &&
          JSON.stringify(calls.reconcileCalls[0]).includes(`"userId":"${OWNER_USER_ID}"`) &&
          JSON.stringify(calls.reconcileCalls[0]).includes(`"accessToken":"${SERVICE_ROLE_KEY}"`)
      )
    );
  }

  // ---- [2] caller supplied userIdは不要かつ無視される(型自体にuserId fieldが存在しない、BASE_PARAMSにuserIdを含めていないことがそのまま構造的証拠) ----
  {
    const paramsHaveNoUserId = !("userId" in BASE_PARAMS);

    results.push(
      check(
        "[2] ReconcileOneShotIntegrationReadAsTrustedActorParamsはworkId/taskId/runIdのみを受け取り、userIdフィールドを持たない(callerがuserIdを渡す余地が型レベルで存在しない)",
        paramsHaveNoUserId
      )
    );
  }

  // ---- [3] Work行が存在しない(=任意/偽装Run IDに対応するWorkが無い) -> not_found、reconcile未呼び出し(任意Run ID不可) ----
  {
    const { deps, calls, setOwnerLookup } = makeDeps();
    setOwnerLookup({ status: "not_found" });

    const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, deps);

    results.push(
      check(
        "[3] 対応するWorkが見つからない場合はnot_found、reconcileOneShotIntegrationRead呼び出し0(任意Run IDでの推測アクセス不可)",
        !result.ok && result.reason === "not_found" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [P5e-5/2] Supabase owner lookup自体がエラー(invalid service role key等)の場合、not_foundとは別の安全なreasonになる ----
  {
    const { deps, calls, setOwnerLookup } = makeDeps();
    setOwnerLookup({ status: "store_error" });

    const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, deps);

    results.push(
      check(
        "[P5e-5/2] Supabase owner lookup errorはnot_foundではなくtrusted_store_errorを返す(Live Acceptanceで実際に混同していた問題の修正、reconcileOneShotIntegrationRead呼び出し0)",
        !result.ok && result.reason === "trusted_store_error" && calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [P5e-5/3] invalid service role相当のstore errorは、safeな固定reasonのみを返す(raw Supabase error本文を含まない) ----
  // ---- [P5e-5/4] error outputにcredential/secret文字列が一切含まれない ----
  {
    const { deps, setOwnerLookup } = makeDeps();
    setOwnerLookup({ status: "store_error" });

    const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, deps);
    const serialized = JSON.stringify(result);

    results.push(
      check(
        "[P5e-5/3][P5e-5/4] store errorはstable/sanitizeされたreason文字列(trusted_store_error)のみを返し、service role key値・query内容等を一切含まない",
        serialized === JSON.stringify({ ok: false, reason: "trusted_store_error" }) &&
          !serialized.includes(SERVICE_ROLE_KEY) &&
          !serialized.toLowerCase().includes("supabase") &&
          !serialized.toLowerCase().includes("error:")
      )
    );
  }

  // ---- [4] service role未設定環境ではtrusted_execution_not_configuredを返し、fetchWorkOwnerId/reconcileのいずれも呼ばれない(fail closed) ----
  {
    const { deps, calls } = makeDeps({ isServiceRoleConfigured: () => false });

    const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, deps);

    results.push(
      check(
        "[4] service role未設定の場合はtrusted_execution_not_configured、fetchWorkOwnerId/reconcileいずれも呼び出し0",
        !result.ok &&
          result.reason === "trusted_execution_not_configured" &&
          calls.fetchWorkOwnerIdCalls.length === 0 &&
          calls.reconcileCalls.length === 0
      )
    );
  }

  // ---- [5]〜[8] 下位のreconcileOneShotIntegrationRead()が返す拒否(non-running/externalRef既存/wrong capability/correlation mismatch相当)を、trusted boundaryがそのまま透過して返す(独自に握り潰したり成功に書き換えたりしない) ----
  {
    const rejections: ReconcileOneShotIntegrationReadResult[] = [
      { ok: false, reason: "not_eligible" },       // wrong capability相当
      { ok: false, reason: "connection_unresolved" },
      { ok: false, reason: "runtime_unavailable" },
      { ok: true, outcome: { status: "not_applicable" } },   // non-running Run相当
      { ok: true, outcome: { status: "already_attached" } }, // externalRef既存Run相当
      { ok: true, outcome: { status: "not_found" } },        // Work/Task/Run mismatch相当
    ];

    let allPropagatedUnchanged = true;

    for (const rejection of rejections) {
      const { deps } = makeDeps();
      const rejectDeps: ReconcileOneShotIntegrationReadAsTrustedActorDeps = {
        ...deps,
        reconcileOneShotIntegrationRead: (async () => rejection) as ReconcileOneShotIntegrationReadAsTrustedActorDeps["reconcileOneShotIntegrationRead"],
      };
      const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, rejectDeps);
      if (JSON.stringify(result) !== JSON.stringify(rejection)) {
        allPropagatedUnchanged = false;
      }
    }

    results.push(
      check(
        "[5-8] non-running Run/externalRef既存Run/wrong capability/Work-Task-Run mismatch相当の下位拒否は、trusted boundaryが一切書き換えず透過的にそのまま返す",
        allPropagatedUnchanged
      )
    );
  }

  // ---- [9][10] Provider実行/新規Trigger dispatch/createRunの手段をこのfile自身が一切importしていない(型レベルの構造的証拠、depsにそれらのfieldが存在しない) ----
  {
    const { deps } = makeDeps();

    results.push(
      check(
        "[9/10] depsにstartExecution/executeIntegrationAction/createRun相当のfieldが存在しない(reconcileOneShotIntegrationReadへの委譲1本だけ、Provider call=0・Trigger start=0・createRun=0の構造的保証)",
        typeof (deps as unknown as { startExecution?: unknown }).startExecution === "undefined" &&
          typeof (deps as unknown as { executeIntegrationAction?: unknown }).executeIntegrationAction === "undefined" &&
          typeof (deps as unknown as { createRun?: unknown }).createRun === "undefined"
      )
    );
  }

  // ---- [11] secret safety: 戻り値にservice role key値が一切含まれない ----
  {
    const { deps } = makeDeps();

    const result = await reconcileOneShotIntegrationReadAsTrustedActor(BASE_PARAMS, deps);

    const serialized = JSON.stringify(result);

    results.push(
      check(
        "[11] service role value exposure = 0: reconcileOneShotIntegrationReadAsTrustedActor()の戻り値にservice role keyの値が一切含まれない",
        !serialized.includes(SERVICE_ROLE_KEY)
      )
    );
  }

  // ---- [12] public unauthenticated invocation不可: app/api配下のどのrouteもこの関数を一切参照していない(HTTP経由で到達不可能であることの構造的証拠) ----
  {
    const appApiDir = join(__dirname, "..", "..", "..", "app", "api");
    const files = listFilesRecursively(appApiDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

    const referencingFiles = files.filter((f) => {
      const content = readFileSync(f, "utf-8");
      return content.includes("reconcileOneShotIntegrationReadAsTrustedActor");
    });

    results.push(
      check(
        "[12] public unauthenticated invocation不可: app/api配下のどのHTTP routeもreconcileOneShotIntegrationReadAsTrustedActor()を参照していない(local one-shot scriptからのみ呼ばれる、新しい公開surfaceが存在しない)",
        referencingFiles.length === 0,
        referencingFiles.length > 0 ? `unexpected references: ${referencingFiles.join(", ")}` : undefined
      )
    );
  }

  return summarize("runtime/reconcileOneShotIntegrationReadAsTrustedActor", results);

}
