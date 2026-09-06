// =========================
// TACT Bot — Trusted Approval Decision Boundary
// (Architecture Migration Phase C2.1c-b / C2.1c-c)
// =========================
//
// core/tact-bot/execution/trustedConversationTurn.ts(BOT-P2.5)と
// 全く同じ設計: 「server-side verified external identity(tactUserId)
// → trusted server-side execution」という認証モードを、Approval
// decision(approve/reject)についても明示的に表現する境界。
//
//   Web:  User JWT → approveApproval()/rejectApproval()を直接呼ぶ
//         (将来のWeb Approval UI、今回のscope外)
//   Bot:  server-side verified external identity(tactUserId)
//           → handleApprovalDecisionAsTrustedActor() [ここ]
//           → core/tact-work/approval.tsのapproveApproval()/
//             rejectApproval() [canonical Approval Execution Boundary、
//             Phase B3で確立済み、business logicはここに一切複製しない]
//           → (approve成功時のみ)core/tact-integration/execution.tsの
//             executeApprovedIntegrationAction() [canonical Integration
//             Execution Boundary、Phase C1で確立済み。Composio Adapter・
//             Integration Gatewayへは絶対に直接到達しない、Provider知識は
//             一切ここへ持ち込まない]
//
// service role keyはこのファイル(core/database/supabaseServiceRole.ts
// 経由)でのみ読み出す。呼び出し元・戻り値・Errorのいずれにも生の
// key文字列を含めない(trustedConversationTurn.tsと同じ絶対条件)。
//
// 絶対条件(Phase C2.1c-c指示): このファイルがimport/参照してよい
// Integration関連の識別子はexecuteApprovedIntegrationAction()という
// canonical boundaryのみ。Composio adapter・@composio/core・
// SLACK_SEND_MESSAGE・markdown_text・connectedAccountId・
// providerConnectionRef・toolkit等のProvider固有識別子は一切import/
// 参照しない。

import {
  approveApproval as defaultApproveApproval,
  rejectApproval as defaultRejectApproval,
  type ApprovalResolutionOutcome,
} from "../../tact-work";
import {
  executeApprovedIntegrationAction as defaultExecuteApprovedIntegrationAction,
  type IntegrationActionExecutionOutcome,
} from "../../tact-integration";
import { getServiceRoleKey as defaultGetServiceRoleKey } from "../../database/supabaseServiceRole";

// Web向けapproveApproval()/rejectApproval()との意図的な違い:
// accessTokenを受け取らない。tactUserIdはserver-side identity
// resolver(core/tact-bot/identity/)が既に検証済みの値であることを、
// 呼び出し元(core/tact-bot/gateway/receiveApprovalDecision.ts)が
// 保証する——この関数自体はそれを再検証しない(既存の役割分担を
// 重複させない、trustedConversationTurn.tsと同じ方針)。
export interface HandleApprovalDecisionAsTrustedActorParams {

  tactUserId: string;

  workId: string;

  approvalId: string;

  decision: "approve" | "reject";

  // reject時のみ意味を持つ(任意)。
  reason?: string;

}

// Architecture Migration Phase C2.1c-c: unit testがlive Supabase/
// Composio/providerへ到達しないよう、この境界が呼ぶ3つのcanonical
// functionだけを差し替え可能にする最小のDI seam(巨大なservice
// abstractionは作らない、defaultは既存canonical functionそのまま)。
export interface HandleApprovalDecisionAsTrustedActorDeps {

  approveApproval: typeof defaultApproveApproval;

  rejectApproval: typeof defaultRejectApproval;

  executeApprovedIntegrationAction: typeof defaultExecuteApprovedIntegrationAction;

  // Architecture Migration Phase C2.1c-c: このtest環境にはSUPABASE_
  // SERVICE_ROLE_KEYが設定されていないため(trustedConversationTurn.ts
  // と同じ既存事情)、上記3つのdepsをfake実装へ差し替えるだけでは
  // 分岐(approve/reject/execution)へ到達できない。getServiceRoleKey
  // 自体もこのDI seamへ含め、test側がfakeな非空文字列を注入できる
  // ようにする(production defaultは既存のgetServiceRoleKey()のまま、
  // 挙動変更なし)。
  getServiceRoleKey: typeof defaultGetServiceRoleKey;

}

const defaultDeps: HandleApprovalDecisionAsTrustedActorDeps = {
  approveApproval: defaultApproveApproval,
  rejectApproval: defaultRejectApproval,
  executeApprovedIntegrationAction: defaultExecuteApprovedIntegrationAction,
  getServiceRoleKey: defaultGetServiceRoleKey,
};

// Architecture Migration Phase C2.1c-c: executeApprovedIntegrationAction()
// が投げうるunexpected exception(external side effect後、Run/Task
// terminal化前に発生した可能性を排除できない)専用の、Bot boundary
// だけのsentinel。IntegrationActionExecutionOutcome(canonical型、
// core/tact-integration/types.ts)を汚さないよう、ここでunionへ
// 追加する形にとどめる。
//
// 絶対条件(ユーザー指示、最重要): この状態を「retryしてよい signal」
// として扱わない。同一callbackの再送があっても、この境界が能動的に
// 2回目のexecuteApprovedIntegrationAction()呼び出しを行うことは
// ない——1回のhandleApprovalDecisionAsTrustedActor()呼び出しにつき、
// executeApprovedIntegrationAction()は高々1回しか呼ばれない
// (ambiguous execution stateの自動回復はKnown Debt、Section9参照)。
export type ExecutionOutcomeOrError =
  | IntegrationActionExecutionOutcome
  | { status: "execution_error" };

export type HandleApprovalDecisionAsTrustedActorResult =
  | {
      ok: true;
      approvalOutcome: ApprovalResolutionOutcome;
      // approve decisionで実際にexecution boundaryへ到達した場合のみ
      // 設定される。reject時、またはapproveでもExecution条件
      // (Section5)を満たさなかった場合は常にundefined。
      executionOutcome?: ExecutionOutcomeOrError;
    }
  | { ok: false; error: "trusted_execution_not_configured" };

// Approval decisionのうちapprove側だけが、executeApprovedIntegrationAction()
// へ進んでよいかどうかを判定する。
//   A. 新規approve成功(pending -> approved)
//   B. repeated approve callback(already_resolvedだが、対象Approval自体は
//      既にapproved) — 安全性はexecuteApprovedIntegrationAction()自身の
//      dedup(already_executed)/Task precondition(task_not_executable)に
//      委ねる。ここでは「executionへ進んでよいか」だけを判定し、
//      「providerを呼んでよいか」の判断は一切行わない。
// それ以外(invalid_transition/work_not_resumable/not_found、または
// already_resolvedだがapproval.status!=="approved"=rejected側)は、
// Approvalがapproved状態に無いためexecutionへ進まない。
function shouldAttemptExecution(approvalOutcome: ApprovalResolutionOutcome): boolean {

  if (approvalOutcome.status === "approved") {
    return true;
  }

  if (approvalOutcome.status === "already_resolved") {
    return approvalOutcome.approval.status === "approved";
  }

  return false;

}

// service role key(=Bot専用のtrusted server-side execution credential)
// が未設定の場合、DBへは一切アクセスせず安全にfallbackする
// (trustedConversationTurn.tsと同じ既存パターン)。
export async function handleApprovalDecisionAsTrustedActor(
  params: HandleApprovalDecisionAsTrustedActorParams,
  deps: HandleApprovalDecisionAsTrustedActorDeps = defaultDeps
): Promise<HandleApprovalDecisionAsTrustedActorResult> {

  const trustedExecutionCredential = deps.getServiceRoleKey();

  if (!trustedExecutionCredential) {
    return { ok: false, error: "trusted_execution_not_configured" };
  }

  // reject: rejectApproval()だけを呼ぶ。executeApprovedIntegrationAction()
  // へは絶対に進まない(絶対条件、Section6)。
  if (params.decision === "reject") {

    const approvalOutcome = await deps.rejectApproval(
      params.workId,
      params.tactUserId,
      trustedExecutionCredential,
      params.approvalId,
      params.reason
    );

    return { ok: true, approvalOutcome };

  }

  // approve: まずapproveApproval()。
  const approvalOutcome = await deps.approveApproval(
    params.workId,
    params.tactUserId,
    trustedExecutionCredential,
    params.approvalId
  );

  if (!shouldAttemptExecution(approvalOutcome)) {
    return { ok: true, approvalOutcome };
  }

  // Architecture Migration Phase C2.1c-c(絶対条件): unexpected exceptionを
  // 呼び出し元(Bot Gateway)へ伝播させない。exceptionをcatchしても、
  // approveApproval()の結果(Approval approved/Work running)をrollback
  // せず、Task/Run/Workを推測で変更もしない——このtry/catchはあくまで
  // 「戻り値を安全にexecution_errorへ倒す」ためだけのものであり、同一
  // request内で2回目のexecuteApprovedIntegrationAction()呼び出しは
  // 一切行わない(Known ambiguous-execution Debt、Section9参照)。
  try {

    const executionOutcome = await deps.executeApprovedIntegrationAction(
      params.workId,
      params.tactUserId,
      trustedExecutionCredential,
      params.approvalId
    );

    return { ok: true, approvalOutcome, executionOutcome };

  } catch (error) {

    // 既存core/tact-integration/execution.tsのreconcileAfterTaskUpdate()
    // と同じ「非致命的な失敗をconsole.warnでbest-effort化する」既存
    // パターンを踏襲する。このcodebase内でexecuteApprovedIntegrationAction()
    // が投げうる例外(Supabase呼び出し失敗等)にcredential/service role
    // keyが含まれることは無い——それでも念のため、errorオブジェクトを
    // 戻り値へは一切含めない(内部ログにのみ残す)。
    console.warn(
      "[tact-bot/trustedApprovalDecision] executeApprovedIntegrationAction() " +
      "threw an unexpected exception; Approval(approved)/Work(running)は既に" +
      "確定済みのためrollbackしない。Task/Run状態はambiguousになりうるが、" +
      "この場でTask/Run/Workを推測変更せず、同一request内でexecutionを" +
      "再試行もしない(execution_errorとして安全側へ倒すだけ、known debt)。",
      error
    );

    return { ok: true, approvalOutcome, executionOutcome: { status: "execution_error" } };

  }

}
