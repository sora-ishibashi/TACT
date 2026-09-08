import {
  getWork,
  createClarification as storeCreateClarification,
  getClarification,
  updateClarificationStatus,
  listClarificationsForWork,
  updateWorkStatus,
} from "./store";
import type { Clarification, ClarificationReasonCode, ActorReference, WorkStatus } from "./types";
// Fast Port P4b: Audit emission。clarification.ts自身がclarification.
// requested/answeredのcanonical emitterである(絶対条件Step14)。
import { emitAuditSafely } from "./audit";

// =========================
// TACT Work — Clarification Execution Boundary (Fast Port P3a:
// Human Interaction Foundation)
// =========================
//
// docs/architecture/p2-p5-final-architecture.md Section9-14で確定した
// 設計をそのまま実装する。core/tact-work/approval.ts(Phase B3)と
// 全く同じ二層構造・同じ設計思想を踏襲するが、Clarificationは
// Approvalの上書きでも汎用化でもなく、独立した兄弟concept(絶対条件4)。
//
// 重要な区別(Approvalと同じ規律): ClarificationはCanonical Entity
// (core/tact-work/store.tsのtact_clarifications、本Phaseで新設)であり、
// Bot/WebはこれをUI上に表示・回答するだけのInterfaceにすぎない。この
// fileが公開するrequestClarification()/resolveClarification()だけを
// 呼び、Clarification状態そのものをBot/Web側で複製・所有しない
// (絶対条件15: Bot-independent core)。
//
// Prior Art(ADAPT_AND_BORROW、source codeはコピーしない):
//   - HumanLayer ACP: AllowedResponderIDs(allowedResponderIds)
//   - AXME: human task abstraction、response correlation
//   - BoundFlow: gate resolution ≠ engine resume
//     (resolveClarification()はClarification.statusをansweredへ
//     進めるだけで、実行(Provider呼び出し・Run作成)は一切行わない
//     ——絶対条件12/13/14。Task/Workが「再開可能」になった後、実際の
//     再開は次のOrchestration/Execution Turnの責務)。
//
// 命名についての注記(実装判断): 指示書はcanonical APIの名前として
// 「createClarification()」を例示しているが、tact_approvalsの既存
// 二層命名規則(store.tsの生CRUD=createApproval()、execution
// boundary層の高レベルAPI=requestApproval())にそのまま揃え、この
// fileの高レベルAPIはrequestClarification()と命名する
// (store.tsの生insert関数を`createClarification`という同名のまま
// 残すため、名前衝突を避ける目的もある)。意味・シグネチャは指示書の
// 例示(workId/taskId/question/reasonCode/requesterId/
// allowedResponderIds)とfield単位で一致させている。

export interface ClarificationRequest {

  workId: string;

  taskId?: string | null;

  requestedByActor: ActorReference;

  reasonCode: ClarificationReasonCode;

  question: string;

  // undefined/null = canonical owner-only(既定、Step9参照)。
  allowedResponderIds?: string[] | null;

  expiresAt?: string | null;

}

export interface ClarificationExecutionDeps {

  getWork: typeof getWork;

  createClarification: typeof storeCreateClarification;

  getClarification: typeof getClarification;

  updateClarificationStatus: typeof updateClarificationStatus;

  listClarificationsForWork: typeof listClarificationsForWork;

  updateWorkStatus: typeof updateWorkStatus;

  // Fast Port P4b: Audit-safe emission(既定は実emitAuditSafely、
  // approval.tsと同じDI pattern、Step13)。
  emitAuditEvent: typeof emitAuditSafely;

}

const defaultDeps: ClarificationExecutionDeps = {
  getWork,
  createClarification: storeCreateClarification,
  getClarification,
  updateClarificationStatus,
  listClarificationsForWork,
  updateWorkStatus,
  emitAuditEvent: emitAuditSafely,
};

// =========================
// requestClarification
// =========================
//
// 責務(approval.tsのrequestApproval()と対称): Work ownership確認
// (createClarification()自身が既存のWorkOwnershipDepsで行う)・
// Clarification作成・Work→waiting_for_inputへの遷移。
//
// storeのcreateClarification()がundefinedを返した場合(Work所有権が
// 無い等)は、Workのstatusも変更しない(絶対条件: 存在しない/所有権の
// 無いWorkに対して何もしない、approval.tsと同じ規約)。
export async function requestClarification(
  request: ClarificationRequest,
  userId: string,
  accessToken: string,
  deps: ClarificationExecutionDeps = defaultDeps
): Promise<Clarification | undefined> {

  const clarification = await deps.createClarification(
    request.workId,
    userId,
    accessToken,
    {
      taskId: request.taskId ?? null,
      requestedByActorKind: request.requestedByActor.kind,
      requestedByActorId: request.requestedByActor.id,
      allowedResponderIds: request.allowedResponderIds ?? null,
      reasonCode: request.reasonCode,
      question: request.question,
      expiresAt: request.expiresAt ?? null,
    }
  );

  if (!clarification) {
    return undefined;
  }

  await deps.updateWorkStatus(request.workId, userId, accessToken, "waiting_for_input");

  // Fast Port P4b(Step6): clarification.requestedのcanonical emitter。
  // Clarification row作成成功後にemitする。question全文はAuditへ
  // 複製しない(Clarification row自体がcanonical current/history
  // entity、Step6の明示的な方針)——detailsはallowedResponderの件数
  // 程度の最小限。
  await deps.emitAuditEvent(
    {
      workId: request.workId,
      taskId: clarification.taskId,
      clarificationId: clarification.id,
      category: "clarification",
      eventType: "clarification.requested",
      actor: request.requestedByActor,
      reasonCode: clarification.reasonCode,
      details: {
        allowedResponderCount: request.allowedResponderIds?.length ?? 0,
      },
    },
    userId,
    accessToken
  );

  return clarification;

}

// =========================
// resolveClarification
// =========================
//
// Idempotency(approval.tsのapproveApproval()/rejectApproval()と同じ
// 規律):
//   - 既にanswered(終端状態)なら"already_resolved"を返し、二重resume/
//     二重actionを起こさない。
//   - pending以外(cancelled/expired等)からansweredへは絶対に遷移
//     させない("invalid_transition")。
//
// allowed responder検証(絶対条件9、HumanLayer ACP AllowedResponderIDs
// pattern): allowedResponderIdsがnon-emptyの場合のみ、responderActor.id
// がそこに含まれることを確認する。undefined/null/空配列の場合は
// 追加チェックを行わない——この時点で既にgetClarification()の
// WorkOwnershipDeps(userIdがWork所有者であることの構造的な強制)を
// 通過しているため、「Work所有者のみ」という既定のcanonical rule
// (Step9)は、Work ownershipという既存の信頼境界がそのまま担っている
// (絶対条件11: identity/ownership checksはtrusted canonical boundary)。
//
// LLM判定禁止(絶対条件9): responseはhuman-provided dataとしてそのまま
// 保存するだけであり、この関数自身は一切解釈・判定しない。
//
// 実行呼び出し禁止(絶対条件12/13/14、BoundFlowのgate resolution ≠
// engine resumeパターン): この関数はClarification.statusをansweredへ
// 進めるだけで、Provider呼び出し・Run作成のいずれも一切行わない。
// resolved後のTask/Work再開(eligibility)は、次のOrchestration/
// Execution Turnが別途判断する——Work.statusをここで"running"へ
// 直接戻すことも、他に未解決のpending Clarification/Approvalが
// 残っていないかを確認した上でのみ行う(approveApproval()の
// 「他のpending Approvalが残っていないか確認してからWorkをrunningへ
// 戻す」という既存判断と対称的な最小実装)。
export type ClarificationResolutionOutcome =
  | { status: "not_found" }
  | { status: "already_resolved"; clarification: Clarification }
  | { status: "invalid_transition"; clarification: Clarification }
  | { status: "responder_not_allowed"; clarification: Clarification }
  | { status: "work_not_resumable"; clarification: Clarification; workStatus: WorkStatus }
  | { status: "answered"; clarification: Clarification; workResumed: boolean };

// Work所有者(getClarification()の既存ownership defenseをそのまま
// 使う)以外はこの関数へ到達できない——resolved tactUserId(Bot経由
// なら server側で解決済みの値)以外をuserIdとして渡さないことは
// 呼び出し元の責務(BOT-P2.5の既存絶対条件、approval.tsと同じ継承)。
export async function resolveClarification(
  workId: string,
  userId: string,
  accessToken: string,
  clarificationId: string,
  responderActor: ActorReference,
  response: string,
  deps: ClarificationExecutionDeps = defaultDeps
): Promise<ClarificationResolutionOutcome> {

  const clarification = await deps.getClarification(workId, userId, accessToken, clarificationId);

  if (!clarification) {
    return { status: "not_found" };
  }

  if (clarification.status === "answered") {
    return { status: "already_resolved", clarification };
  }

  if (clarification.status !== "pending") {
    return { status: "invalid_transition", clarification };
  }

  if (
    clarification.allowedResponderIds &&
    clarification.allowedResponderIds.length > 0 &&
    !clarification.allowedResponderIds.includes(responderActor.id)
  ) {
    return { status: "responder_not_allowed", clarification };
  }

  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  if (work.status !== "waiting_for_input") {
    return { status: "work_not_resumable", clarification, workStatus: work.status };
  }

  await deps.updateClarificationStatus(workId, userId, accessToken, clarificationId, "answered", {
    response,
    respondedByActorKind: responderActor.kind,
    respondedByActorId: responderActor.id,
  });

  // Fast Port P4b(Step7): clarification.answeredのcanonical emitter。
  // status answered確定後にemitする。response全文はAuditへコピー
  // しない(Clarification rowがcanonical current/history entity、
  // Step7の明示的な方針)——「answered occurred」だけで十分。
  await deps.emitAuditEvent(
    {
      workId,
      taskId: clarification.taskId,
      clarificationId: clarification.id,
      category: "clarification",
      eventType: "clarification.answered",
      actor: responderActor,
    },
    userId,
    accessToken
  );

  // approveApproval()と対称的な最小実装: 他に未解決のpending
  // Clarificationが残っていなければ、Workを"running"へ戻し
  // eligibleにする(絶対条件13: resolution後にTaskがeligibleになり、
  // その後execution layerが再開する——ここではWork.statusを進める
  // だけで、Provider/Run/execution呼び出しは一切行わない)。
  const remaining = await deps.listClarificationsForWork(workId, userId, accessToken);
  const stillPending = remaining.some(
    (other) => other.id !== clarificationId && other.status === "pending"
  );

  let workResumed = false;

  if (!stillPending) {
    await deps.updateWorkStatus(workId, userId, accessToken, "running");
    workResumed = true;
  }

  return {
    status: "answered",
    clarification: {
      ...clarification,
      status: "answered",
      response,
      respondedByActorKind: responderActor.kind,
      respondedByActorId: responderActor.id,
    },
    workResumed,
  };

}
