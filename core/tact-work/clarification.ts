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
// REF-P1d: pinned referent候補選択のためのpure domain helper
// (tact-referent側はcore/tact-workを一切importしない、一方向の依存)。
import {
  buildCandidateSnapshot,
  computeReferentClarificationExpiresAt,
  hashCandidateSnapshot,
  resolveReferentClarificationSelection,
  type CandidateSnapshotEntry,
  type ReferentClarificationSelectionResult,
} from "../tact-referent/clarification";
import type { CommunicationCandidate } from "../tact-referent/types";

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

  // REF-P1d: 作成時にのみ設定される、immutableなpinned candidate
  // snapshot(既に構築・hash済みのものをそのまま渡す想定——このfile
  // 自身での構築はrequestReferentClarification()が行う)。
  candidateSnapshot?: readonly CandidateSnapshotEntry[] | null;

  candidateSnapshotHash?: string | null;

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

  // REF-P1d: pinned candidate selectionの純粋判定ロジック(DI経由で
  // test時に差し替え可能にする、既存パターンをそのまま踏襲)。
  resolveReferentClarificationSelection: typeof resolveReferentClarificationSelection;

  // REF-P1d: 決定論的testのため、時刻を注入可能にする(このfile内で
  // Date.now()/new Date()を直接呼ばない、既存store.ts側の
  // updateClarificationStatus()のresponded_atはI/O境界の既存挙動として
  // 維持し変更しない)。
  now: () => Date;

}

const defaultDeps: ClarificationExecutionDeps = {
  getWork,
  createClarification: storeCreateClarification,
  getClarification,
  updateClarificationStatus,
  listClarificationsForWork,
  updateWorkStatus,
  emitAuditEvent: emitAuditSafely,
  resolveReferentClarificationSelection,
  now: () => new Date(),
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
      candidateSnapshot: request.candidateSnapshot ?? null,
      candidateSnapshotHash: request.candidateSnapshotHash ?? null,
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
// requestReferentClarification (REF-P1d)
// =========================
//
// requestClarification()の薄いwrapper——並行するClarification
// subsystemを作らない(このphaseの明示的指示)。candidate snapshotの
// 構築・index付与・hash計算だけをこの関数が担い、永続化自体は既存の
// requestClarification()/store.createClarification()にそのまま委譲する。
//
// 絶対条件: questionのrendering(「1. ... / 2. ...」形式のUI向け整形)は
// ここでは行わない——orchestration層(REF-P1f)の責務。この関数は
// 呼び出し元が既に組み立てたquestion textを受け取るだけであり、
// candidate snapshotの構築とrequestClarification()への橋渡しに専念する
// (Build Less)。

export interface ReferentClarificationRequest {

  workId: string;

  taskId?: string | null;

  requestedByActor: ActorReference;

  question: string;

  candidates: readonly CommunicationCandidate[];

  allowedResponderIds?: string[] | null;

  // 省略時はWRITE_REFERENT_CLARIFICATION_TTL_MS(24h)を
  // deps.now()基準で適用する。
  expiresAt?: string | null;

}

export interface RequestReferentClarificationDeps extends ClarificationExecutionDeps {

  buildCandidateSnapshot: typeof buildCandidateSnapshot;

  hashCandidateSnapshot: typeof hashCandidateSnapshot;

  computeReferentClarificationExpiresAt: typeof computeReferentClarificationExpiresAt;

}

const defaultRequestReferentClarificationDeps: RequestReferentClarificationDeps = {
  ...defaultDeps,
  buildCandidateSnapshot,
  hashCandidateSnapshot,
  computeReferentClarificationExpiresAt,
};

export async function requestReferentClarification(
  request: ReferentClarificationRequest,
  userId: string,
  accessToken: string,
  deps: RequestReferentClarificationDeps = defaultRequestReferentClarificationDeps
): Promise<Clarification | undefined> {

  const candidateSnapshot = deps.buildCandidateSnapshot(request.candidates);
  const candidateSnapshotHash = deps.hashCandidateSnapshot(candidateSnapshot);

  return requestClarification(
    {
      workId: request.workId,
      taskId: request.taskId,
      requestedByActor: request.requestedByActor,
      // REF-P1d時点で唯一のproducerはWRITEのtarget解決
      // (missing_required_input、既存のCLARIFICATION_REASON_CODESの
      // 唯一の値をそのまま再利用する——新しいreasonCodeを先取りしない)。
      reasonCode: "missing_required_input",
      question: request.question,
      allowedResponderIds: request.allowedResponderIds,
      expiresAt: request.expiresAt ?? deps.computeReferentClarificationExpiresAt(deps.now()),
      candidateSnapshot,
      candidateSnapshotHash,
    },
    userId,
    accessToken,
    deps
  );

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
  // REF-P1d: candidateSnapshot/candidateSnapshotHashを持つ
  // referent-selection Clarificationのみが到達する分岐。selectionの
  // 詳細な理由(invalid_selection/stale/integrity_error)は
  // selection.statusで区別する。絶対条件: この分岐に到達した場合、
  // Clarification.statusはpendingのまま変更されない
  // (updateClarificationStatus()を一切呼ばない)。
  | { status: "invalid_referent_selection"; clarification: Clarification; selection: ReferentClarificationSelectionResult }
  | {
      status: "answered";
      clarification: Clarification;
      workResumed: boolean;
      // REF-P1d: referent-selection Clarificationが正しく解決された
      // 場合のみ設定される(response + candidate_snapshotから常に
      // 導出可能な値をここでも便宜的に公開するだけであり、新しい
      // 永続列ではない)。
      referentSelection?: CandidateSnapshotEntry;
    };

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

  // =========================
  // REF-P1d: referent-selection validation seam
  // =========================
  //
  // candidateSnapshot/candidateSnapshotHashの両方が揃っている場合
  // だけ、このClarificationはreferent-selectionとして扱う——それ以外
  // (既存の自由記述Clarification)は、この分岐に一切入らず、これまで
  // 通りどんなresponseでもansweredへ遷移する(絶対条件: 既存の汎用
  // Clarification挙動を一切変更しない、後方互換性)。
  //
  // 絶対条件(TOCTOU): resolveReferentClarificationSelection()には
  // 常にclarification.candidateSnapshot(DBから読み出したstored
  // snapshot)だけを渡す——fresh candidateを取得・混入する経路はここに
  // 存在しない。
  //
  // 絶対条件: selectionが"selected"以外の場合、Clarification.statusは
  // pendingのまま変更しない(updateClarificationStatus()を呼ばない)
  // ——無効な数値/範囲外/期限切れ/改ざん検出のいずれも、誤って
  // answeredへ遷移させない。
  let referentSelection: CandidateSnapshotEntry | undefined;

  if (clarification.candidateSnapshot && clarification.candidateSnapshotHash) {

    const selection = deps.resolveReferentClarificationSelection({
      response,
      candidateSnapshot: clarification.candidateSnapshot,
      candidateSnapshotHash: clarification.candidateSnapshotHash,
      expiresAt: clarification.expiresAt ?? null,
      now: deps.now(),
    });

    if (selection.status !== "selected") {
      return { status: "invalid_referent_selection", clarification, selection };
    }

    referentSelection = selection.candidate;

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
    ...(referentSelection ? { referentSelection } : {}),
  };

}
