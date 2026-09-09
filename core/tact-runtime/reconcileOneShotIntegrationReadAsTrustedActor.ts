// =========================
// TACT Runtime — Trusted One-Shot Reconciliation Boundary
// (P5d: Trusted Bot-Owned Run Compatibility Fix)
// =========================
//
// core/tact-bot/execution/trustedConversationTurn.ts・
// trustedApprovalDecision.tsと全く同じ設計思想:「server-side
// resolved identity → trusted server-side execution」という認証
// モードを、bot-owned Runのone-shot reconciliationについても
// 明示的に表現する境界。
//
//   Web(自分のRunを自分でreconcileする場合):
//     User JWT → POST /api/tact/runtime/reconcile
//       (app/api/tact/runtime/reconcile/route.ts、既存・変更なし)
//       → reconcileOneShotIntegrationRead()
//
//   Trusted operator(Production Slack Bot経由で解決されたTACT user
//   が所有するRunを、Web UIログインユーザーとは別の人がreconcileする
//   場合。今回のLive Acceptanceが該当):
//     trusted server-only invocation(local one-shot script、HTTP
//     route化しない——下記「なぜHTTP routeにしないか」参照)
//       → reconcileOneShotIntegrationReadAsTrustedActor() [ここ]
//       → reconcileOneShotIntegrationRead()
//         (core/tact-runtime/reconcileOneShotEntrypoint.ts、既存・
//         変更なし。business logicはここに一切複製しない)
//
// 絶対条件(最重要、今回の依頼の核心): このfileはcaller供給のuserIdを
// 一切受け取らない・信用しない。Runの所有者(userId)は、このfile自身が
// service role権限でtact_worksのuser_id列を直接読むことでserver-side
// に確定する——「Run→Task→Workの一次情報から確定した値」だけを使う。
// これはtrustedConversationTurn.ts等が「identity resolverが検証済みの
// tactUserIdだけを受け取る」のと同じ精神を、identity resolverが
// 存在しないこの文脈向けに「Workの記録そのものから直接読む」という形で
// 満たしたもの(新しいidentity解決機構を増やさない)。
//
// なぜHTTP route化しないか(今回のBLOCK判断の理由、正直に記録する):
// このrepositoryには現在、「TACT user JWTでもSlack HMAC署名検証でも
// ない、第三の安全なserver-only invocation認証手段」が存在しない。
// もしこれをHTTP routeとして公開する場合、選択肢は事実上2つしかない:
//   (a) 通常のTACT user認証(getCurrentUserContext())を要求する
//       → 「Run所有者だけがreconcileできる」という既存routeの前提が
//         崩れる。このfile自身はowner確認をcaller入力ではなくWork行
//         から行うため、「ログイン済みでありさえすれば誰でも他人の
//         Runをreconcileできる」という重大なprivilege escalationに
//         なる(絶対条件3/4に正面から違反する)。
//   (b) 新しいadmin secret(専用のBearer token等)を追加する
//       → 絶対条件5(新しい恒久admin secretを極力作らない)に反する。
// どちらも今回の絶対条件と両立しないため、HTTP route化はBLOCKし、
// 「新しい公開surfaceを一切増やさない」local one-shot script
// (scripts/reconcileOneShotIntegrationReadAsTrustedActor.ts)からのみ
// 呼び出す設計を採用する。この関数自体は既存のservice role key
// (SUPABASE_SERVICE_ROLE_KEY)・既存のTrigger.dev config
// (TRIGGER_SECRET_KEY等)以外の新しいcredentialを一切必要としない。
//
// service role keyはこのファイル(core/database/supabaseServiceRole.ts
// 経由)でのみ読み出す。呼び出し元・戻り値・Errorのいずれにも生の
// key文字列を含めない(trustedConversationTurn.tsと同じ絶対条件)。
//
// P5e-1(Live Acceptanceで実際に発覚した運用上の欠陥の最小修正):
// fetchWorkOwnerIdViaServiceRole()は元々「Work行が本当に存在しない」
// 場合と「Supabase query自体が失敗した(invalid service role key・
// 到達不能等)」場合を区別せず、両方を同じnullへ潰していた——結果、
// callerからは常に`reason:"not_found"`にしか見えず、「本当にWorkが
// 無いのか」「credentialが無効なだけなのか」を一発の実行結果からは
// 切り分けられなかった(P5d Live Acceptance中に実際に発生・確認済み)。
// FetchWorkOwnerIdOutcomeという3値の判別union(found/not_found/
// store_error)へ変更し、callerがこの2つを明確に区別できるようにする。
// Supabase error本文(message/details/hint等、内部query構造や
// credentialの手がかりを含みうる)はどこにも一切含めない——安全な
// 固定reasonだけを返す(絶対条件、secret/query内容の非漏洩)。
import { createClient } from "@supabase/supabase-js";
import {
  isServiceRoleConfigured,
  getServiceRoleKey as defaultGetServiceRoleKey,
} from "../database/supabaseServiceRole";
import {
  reconcileOneShotIntegrationRead as defaultReconcileOneShotIntegrationRead,
  type ReconcileOneShotIntegrationReadResult,
} from "./reconcileOneShotEntrypoint";

export interface ReconcileOneShotIntegrationReadAsTrustedActorParams {

  workId: string;

  taskId: string;

  runId: string;

}

// P5e-1: "trusted_store_error"は、既存reconcileOneShotIntegrationRead()
// のreason union(not_found/not_eligible/connection_unresolved/
// runtime_unavailable)のいずれにも意味的に一致しないため新設する
// (既存reasonの誤用・意味の上書きを避ける、最小限の1値追加)。
// DB store層(Supabase)自体への到達・認証に失敗した、という
// この境界に固有の状態を表す。
export type ReconcileOneShotIntegrationReadAsTrustedActorResult =
  | ReconcileOneShotIntegrationReadResult
  | { ok: false; reason: "trusted_execution_not_configured" | "not_found" | "trusted_store_error" };

// P5e-1: 「行が存在しない」と「queryそのものが失敗した」を型レベルで
// 区別する判別union。
export type FetchWorkOwnerIdOutcome =
  | { status: "found"; userId: string }
  | { status: "not_found" }
  | { status: "store_error" };

// tact_worksのuser_id列を、service role権限で直接1件だけ読む。
// このfile自身の中で唯一「Run所有者をcaller入力ではなくDBから
// 直接確定する」ための最小限の生queryであり、それ以外の全ての
// 処理はreconcileOneShotIntegrationRead()(既存・変更なし)へ
// そのまま委譲する。
//
// NEXT_PUBLIC_SUPABASE_URLはbrowserへも公開される非secretな値
// (既存core/database/supabaseServiceRole.tsのgetServiceRoleClient()
// と同じ既存パターン)であり、ここで新たにsecret扱いにする必要は無い。
async function fetchWorkOwnerIdViaServiceRole(workId: string): Promise<FetchWorkOwnerIdOutcome> {

  const serviceRoleKey = defaultGetServiceRoleKey();

  if (!serviceRoleKey) {
    return { status: "store_error" };
  }

  try {

    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data, error } = await client
      .from("tact_works")
      .select("user_id")
      .eq("id", workId)
      .maybeSingle();

    // 絶対条件(P5e-1): errorはraw messageを一切参照・転送しない
    // (invalid API key・ネットワーク到達不能等、原因の詳細に
    // credential/query構造の手がかりが含まれうるため)。「queryが
    // 失敗した」という事実だけをstore_errorへ正規化する。
    if (error) {
      return { status: "store_error" };
    }

    if (!data) {
      return { status: "not_found" };
    }

    return { status: "found", userId: (data as { user_id: string }).user_id };

  } catch {

    // createClient()自体が同期的に例外を投げるケース(不正な
    // key/URL形式等)も同じくstore_errorへ正規化する——生のException
    // messageをcallerへ渡さない。
    return { status: "store_error" };

  }

}

export interface ReconcileOneShotIntegrationReadAsTrustedActorDeps {

  isServiceRoleConfigured: typeof isServiceRoleConfigured;

  getServiceRoleKey: typeof defaultGetServiceRoleKey;

  fetchWorkOwnerId: (workId: string) => Promise<FetchWorkOwnerIdOutcome>;

  reconcileOneShotIntegrationRead: typeof defaultReconcileOneShotIntegrationRead;

}

const defaultDeps: ReconcileOneShotIntegrationReadAsTrustedActorDeps = {
  isServiceRoleConfigured,
  getServiceRoleKey: defaultGetServiceRoleKey,
  fetchWorkOwnerId: fetchWorkOwnerIdViaServiceRole,
  reconcileOneShotIntegrationRead: defaultReconcileOneShotIntegrationRead,
};

export async function reconcileOneShotIntegrationReadAsTrustedActor(
  params: ReconcileOneShotIntegrationReadAsTrustedActorParams,
  deps: ReconcileOneShotIntegrationReadAsTrustedActorDeps = defaultDeps
): Promise<ReconcileOneShotIntegrationReadAsTrustedActorResult> {

  if (!deps.isServiceRoleConfigured()) {
    return { ok: false, reason: "trusted_execution_not_configured" };
  }

  const serviceRoleKey = deps.getServiceRoleKey();

  if (!serviceRoleKey) {
    return { ok: false, reason: "trusted_execution_not_configured" };
  }

  // 絶対条件(最重要): ownerはWork行そのものから確定する。callerは
  // workId/taskId/runId以外の何も渡せない(型定義自体がuserIdを
  // 受け取らないことで、この不変条件を構造的に保証する)。
  //
  // P5e-1: 「本当にWorkが存在しない」(not_found)と「DB queryそのものが
  // 失敗した」(trusted_store_error)を、ここで明確に分岐させる
  // (Live Acceptanceで実際に両者が同じnot_foundへ潰れて区別できな
  // かった問題の修正)。
  const ownerLookup = await deps.fetchWorkOwnerId(params.workId);

  if (ownerLookup.status === "not_found") {
    return { ok: false, reason: "not_found" };
  }

  if (ownerLookup.status === "store_error") {
    return { ok: false, reason: "trusted_store_error" };
  }

  // ここから先は既存の、既にtests PASS済みのreconcileOneShotIntegrationRead()
  // をそのまま呼ぶだけ(Work/Task/Run correlation・capability一致・
  // Connection re-resolve・runtime adapter resolutionは全てそちらの
  // 既存ロジックがそのまま再検証する、二重実装しない)。
  return deps.reconcileOneShotIntegrationRead({
    userId: ownerLookup.userId,
    accessToken: serviceRoleKey,
    workId: params.workId,
    taskId: params.taskId,
    runId: params.runId,
  });

}
