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
//           → (approve成功時のみ)core/tact-work/resume.tsの
//             requestTaskResume() [Fast Port P6a、canonical resume
//             eligibility判断]
//           → core/tact-conversation/のexecutePreparedTaskResume()
//             [Fast Port P6b、既存Approval Integrity検証・Policy live
//             recheck・Runtime/Native routingを完全に内包する既存
//             execution境界への唯一の正式なentrypoint。Composio
//             Adapter・Integration Gatewayへは絶対に直接到達しない、
//             Provider知識は一切ここへ持ち込まない]
//
// Fast Port P6b(Step12、絶対条件、最重要): resolveApproval()と
// executeProvider()を直接結合しない。approveApproval()成功後、
// 以前はこのfileが直接executeApprovedIntegrationAction()を呼んでいたが
// (「resolved」の直後に「resumed」を暗黙に連結していた、P6a auditで
// 確認済みのfinding)、今回requestTaskResume()→executePreparedTaskResume()
// という明示的なcanonical resume execution boundaryを必ず経由する形へ
// 変更した。同一HTTP request内で両方行うこと自体は許容される
// (Production Slack Approval flowを壊さないため、承認と実行を別の
// HTTPリクエストへ分割してはいない)——変わったのは「コード上、
// Approval resolutionの直後にProvider実行を直接呼ばない」という
// 構造だけであり、resolveApproval()自身は一切変更していない。
//
// service role keyはこのファイル(core/database/supabaseServiceRole.ts
// 経由)でのみ読み出す。呼び出し元・戻り値・Errorのいずれにも生の
// key文字列を含めない(trustedConversationTurn.tsと同じ絶対条件)。
//
// 絶対条件(Phase C2.1c-c指示、P6bでも維持): このファイルがimport/
// 参照してよいIntegration関連の識別子は無い(P6b以降、Integration
// 実行への到達はexecutePreparedTaskResume()経由のみ)。Composio
// adapter・@composio/core・SLACK_SEND_MESSAGE・markdown_text・
// connectedAccountId・providerConnectionRef・toolkit等のProvider固有
// 識別子は一切import/参照しない。

import {
  approveApproval as defaultApproveApproval,
  rejectApproval as defaultRejectApproval,
  requestTaskResume as defaultRequestTaskResume,
  finalizeSemanticWorkAfterProtectedWrite as defaultFinalizeSemanticWorkAfterProtectedWrite,
  type ApprovalResolutionOutcome,
} from "../../tact-work";
import type { IntegrationActionExecutionOutcome } from "../../tact-integration";
import {
  executePreparedTaskResume as defaultExecutePreparedTaskResume,
} from "../../tact-conversation";
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

  // Fast Port P6b: 以前のexecuteApprovedIntegrationAction直接呼び出しを
  // 置き換える、canonical resume execution boundaryへの2段階
  // (eligibility判断→実行接続)。
  requestTaskResume: typeof defaultRequestTaskResume;

  executePreparedTaskResume: typeof defaultExecutePreparedTaskResume;

  // Architecture audit finding F-02 fix(GMAIL-P1 Completion Ownership
  // Audit): a protected write's Run/Task terminal state alone must not
  // complete a durable semantic delegated Work (core/tact-work/
  // delegatedCompletion.tsのfinalizeSemanticWorkAfterProtectedWrite()
  // 参照)。既存のapproveApproval/rejectApproval/requestTaskResumeと同じ
  // tact-work canonical function(絶対条件: Integration/Composio固有の
  // 識別子ではない、ファイル冒頭コメントの既存禁止事項に抵触しない)。
  finalizeSemanticWorkAfterProtectedWrite: typeof defaultFinalizeSemanticWorkAfterProtectedWrite;

  // Architecture Migration Phase C2.1c-c: このtest環境にはSUPABASE_
  // SERVICE_ROLE_KEYが設定されていないため(trustedConversationTurn.ts
  // と同じ既存事情)、上記のdepsをfake実装へ差し替えるだけでは
  // 分岐(approve/reject/execution)へ到達できない。getServiceRoleKey
  // 自体もこのDI seamへ含め、test側がfakeな非空文字列を注入できる
  // ようにする(production defaultは既存のgetServiceRoleKey()のまま、
  // 挙動変更なし)。
  getServiceRoleKey: typeof defaultGetServiceRoleKey;

}

const defaultDeps: HandleApprovalDecisionAsTrustedActorDeps = {
  approveApproval: defaultApproveApproval,
  rejectApproval: defaultRejectApproval,
  requestTaskResume: defaultRequestTaskResume,
  executePreparedTaskResume: defaultExecutePreparedTaskResume,
  finalizeSemanticWorkAfterProtectedWrite: defaultFinalizeSemanticWorkAfterProtectedWrite,
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

  // Fast Port P6b(Step12絶対条件、最重要): resolveApproval() ≠
  // executeProvider()。approveApproval()自体はtaskIdをexecutionOutcome
  // 経由で返さないため、承認済みのApproval object(approvalOutcomeの
  // approved/already_resolvedいずれの分岐にも含まれる)からtaskIdを
  // 取り出す——このfile自身がexecution実行可否を判断するのではなく、
  // 取り出したtaskIdをcanonical resume boundaryへそのまま渡すだけ。
  const taskId =
    approvalOutcome.status === "approved" || approvalOutcome.status === "already_resolved"
      ? approvalOutcome.approval.taskId
      : null;

  if (!taskId) {
    // 既存executeApprovedIntegrationAction()自身も、approval.taskIdが
    // 無い場合はnot_foundを返していた(core/tact-integration/
    // execution.ts、Approval scope==="work"/"action"等でtaskId無し)
    // ——同じ挙動をここでも保つ。
    return { ok: true, approvalOutcome, executionOutcome: { status: "not_found" } };
  }

  // Architecture Migration Phase C2.1c-c(絶対条件、P6bでも維持):
  // unexpected exceptionを呼び出し元(Bot Gateway)へ伝播させない。
  // exceptionをcatchしても、approveApproval()の結果(Approval approved/
  // Work running)をrollbackせず、Task/Run/Workを推測で変更もしない
  // ——このtry/catchはあくまで「戻り値を安全にexecution_errorへ倒す」
  // ためだけのものであり、同一request内で2回目のexecutePreparedTask
  // Resume()呼び出しは一切行わない(Known ambiguous-execution Debt、
  // Section9参照)。
  try {

    // Step12: Human Interaction resolution(承認)とexecution再開の間に
    // 立つ、明示的なcanonical resume operation。prepared intentを
    // authorization tokenとして扱わない——requestTaskResume()自身が
    // eligibilityを再確認する(P6a絶対条件、resolved≠resumed)。
    const resumeRequest = await deps.requestTaskResume({
      workId: params.workId,
      userId: params.tactUserId,
      accessToken: trustedExecutionCredential,
      taskId,
      reason: "approval_resolved",
    });

    if (resumeRequest.status !== "prepared") {

      // eligibility自身がblocked/already_terminalと判定した場合、
      // Providerへは一切到達しない。新しいstatusをExecutionOutcomeOrError
      // /receiveApprovalDecision.tsへ増やさず、既存の
      // IntegrationActionExecutionOutcome.invalid_action(reason付き)
      // へ安全に折り畳む(絶対条件、Bot向け既存exhaustive switchを
      // 変更しない)。
      return {
        ok: true,
        approvalOutcome,
        executionOutcome: { status: "invalid_action", reason: `resume not eligible: ${resumeRequest.reasonCode}` },
      };

    }

    // Step2/8/9絶対条件: connectionId/provider/resolvedAction/
    // credentialのいずれもこのfileから渡さない——
    // executePreparedTaskResume()自身がTask/Work/canonical persisted
    // stateから再解決し、既存Approval Integrity検証・Policy live
    // recheckを経由する。
    const resumeOutcome = await deps.executePreparedTaskResume({
      intent: resumeRequest.intent,
      userId: params.tactUserId,
      accessToken: trustedExecutionCredential,
    });

    if (resumeOutcome.status === "write_executed") {

      // Architecture audit finding F-02 fix(GMAIL-P1 Completion Ownership
      // Audit、最重要): executeApprovedIntegrationAction()(このoutcomeの
      // source)は、Run/Taskのterminal化のたびに既存のgeneric
      // reconcileWorkCompletionStatus()を呼ぶが、そのfunction自身は
      // (core/tact-work/completion.tsの修正により)durable semantic
      // delegated WorkをWork.resultDeliveredAtが立つまでcompletedへ
      // 進めない。ここで、実行結果が定義済み(completed/failed/
      // 既に実行済みのreplay)になった直後に、その同じcanonical delivery
      // boundaryを進める——Gmail固有分岐は一切無く、classic
      // (non-semantic)Workに対しては完全なno-op(finalizeSemanticWork
      // AfterProtectedWrite()自身がWork.requestTypeを見て判定する)。
      if (
        resumeOutcome.outcome.status === "completed" ||
        resumeOutcome.outcome.status === "failed" ||
        resumeOutcome.outcome.status === "already_executed"
      ) {

        try {

          await deps.finalizeSemanticWorkAfterProtectedWrite(
            params.workId,
            params.tactUserId,
            trustedExecutionCredential
          );

        } catch (error) {

          // 既存reconcileAfterTaskUpdate()と同じ「非致命的な副次処理は
          // console.warnでbest-effort化する」既存パターン。Run/Task/
          // Approvalは既に確定済みであり、この呼び出しの失敗によって
          // executionOutcome自体(既に確定済みの外部side effectの結果)
          // は変更しない。
          console.warn(
            "[tact-bot/trustedApprovalDecision] finalizeSemanticWorkAfterProtectedWrite() failed after " +
            "a protected write produced a definitive outcome; Run/Task状態は既に確定済みのため、" +
            "この内部集計の失敗によってexecutionOutcome自体は変更しない。",
            error
          );

        }

      }

      return { ok: true, approvalOutcome, executionOutcome: resumeOutcome.outcome };
    }

    // read_executed・connection_unresolved等、Approval経由の write
    // resumeとしては通常到達しない分岐(Policy drift等の異常系)も、
    // 同じくinvalid_actionへ安全に折り畳む。
    return {
      ok: true,
      approvalOutcome,
      executionOutcome: { status: "invalid_action", reason: `unexpected resume outcome: ${resumeOutcome.status}` },
    };

  } catch (error) {

    // 既存core/tact-integration/execution.tsのreconcileAfterTaskUpdate()
    // と同じ「非致命的な失敗をconsole.warnでbest-effort化する」既存
    // パターンを踏襲する。このcodebase内でexecutePreparedTaskResume()
    // が投げうる例外(Supabase呼び出し失敗等)にcredential/service role
    // keyが含まれることは無い——それでも念のため、errorオブジェクトを
    // 戻り値へは一切含めない(内部ログにのみ残す)。
    console.warn(
      "[tact-bot/trustedApprovalDecision] executePreparedTaskResume() " +
      "threw an unexpected exception; Approval(approved)/Work(running)は既に" +
      "確定済みのためrollbackしない。Task/Run状態はambiguousになりうるが、" +
      "この場でTask/Run/Workを推測変更せず、同一request内でexecutionを" +
      "再試行もしない(execution_errorとして安全側へ倒すだけ、known debt)。",
      error
    );

    return { ok: true, approvalOutcome, executionOutcome: { status: "execution_error" } };

  }

}
