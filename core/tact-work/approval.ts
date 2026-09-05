import {
  getWork,
  createApproval,
  getApproval,
  updateApprovalStatus,
  listApprovalsForWork,
  updateWorkStatus,
  updateTaskStatus,
} from "./store";
import type { Approval, ActorReference } from "./types";

// =========================
// TACT Work — Approval Execution Boundary (Architecture Migration
// Phase B3)
// =========================
//
// Approvalを「単なるDB Entity」ではなく、「Work/Task/Actionの実行を
// 一時停止し、人間判断後に再開または終了できる正式なExecution
// Control Primitive」として扱う(Phase B3目的)。
//
// 重要な区別(Phase B3絶対条件): ApprovalはCanonical Entity
// (core/tact-work/store.tsのtact_approvals、Phase B1で既に確立済み)
// であり、Bot/WebはこれをUI上に表示・回答するだけのInterfaceに
// すぎない。BotRequestApprovalAction(core/tact-bot/types.ts)や
// 将来のWeb UIは、この境界が公開するrequestApproval()/
// approveApproval()/rejectApproval()を呼ぶだけであり、Approval状態
// そのものをBot/Web側で複製・所有しない。
//
// 新しいtact_approvals migrationは追加していない(Phase B1の
// 20260905000000migrationで既にselect/insert/update RLS policyが
// 揃っている。scope/actionはpayload jsonbへ格納するだけで新しい列は
// 不要)。
//
// テスト容易性のため、実際のStore呼び出しをConstructor/Parameter
// Injectionで差し替え可能にする(既定値は実関数。core/tact-work/の
// 他モジュールと同じDIパターン)。

export type ApprovalScope = "work" | "task" | "action";

// Provider固有のフィールド(例: slackChannelId・gmailMessageId・
// pipedreamWorkflowId等)は一切含めない——「何を・なぜ承認して
// ほしいか」を人間が読める形で表すだけの、Provider非依存の最小限の形
// (core/tact-orchestrator/task.tsのTaskApprovalActionと同じ形)。
export interface ApprovalActionDescriptor {

  kind: string;

  summary: string;

  metadata?: Record<string, unknown>;

}

export interface ApprovalRequest {

  workId: string;

  taskId?: string | null;

  scope: ApprovalScope;

  requestedByActor: ActorReference;

  requestedFromActor: ActorReference;

  reason: string;

  action?: ApprovalActionDescriptor;

  metadata?: Record<string, unknown>;

}

export interface ApprovalExecutionDeps {

  getWork: typeof getWork;

  createApproval: typeof createApproval;

  getApproval: typeof getApproval;

  updateApprovalStatus: typeof updateApprovalStatus;

  listApprovalsForWork: typeof listApprovalsForWork;

  updateWorkStatus: typeof updateWorkStatus;

  updateTaskStatus: typeof updateTaskStatus;

}

const defaultDeps: ApprovalExecutionDeps = {
  getWork,
  createApproval,
  getApproval,
  updateApprovalStatus,
  listApprovalsForWork,
  updateWorkStatus,
  updateTaskStatus,
};

function toApprovalPayload(request: ApprovalRequest): Record<string, unknown> {

  return {
    scope: request.scope,
    action: request.action ?? null,
    ...(request.metadata ?? {}),
  };

}

// =========================
// requestApproval
// =========================
//
// 責務(Phase B3指示Section7): Work ownership確認(createApproval()
// 自身が既存のWorkOwnershipDepsで行う)・Approval作成・
// Work→waiting_for_approval・必要ならTaskとのlink。
//
// createApproval()がundefinedを返した場合(Work所有権が無い= 他user
// のWork等)は、Approvalを一切作らず、Workのstatusも変更しない
// (絶対条件: 存在しない/所有権の無いWorkに対して何もしない)。
export async function requestApproval(
  request: ApprovalRequest,
  userId: string,
  accessToken: string,
  deps: ApprovalExecutionDeps = defaultDeps
): Promise<Approval | undefined> {

  const approval = await deps.createApproval(
    request.workId,
    userId,
    accessToken,
    {
      taskId: request.taskId ?? null,
      requestedByActorKind: request.requestedByActor.kind,
      requestedByActorId: request.requestedByActor.id,
      requestedFromActorKind: request.requestedFromActor.kind,
      requestedFromActorId: request.requestedFromActor.id,
      reason: request.reason,
      payload: toApprovalPayload(request),
    }
  );

  if (!approval) {
    return undefined;
  }

  await deps.updateWorkStatus(request.workId, userId, accessToken, "waiting_for_approval");

  return approval;

}

// =========================
// approveApproval / rejectApproval
// =========================
//
// Idempotency(Phase B3絶対条件): pending -> approved/rejectedを
// 基本のone-way transitionとする。
//   - 既に同じ終端状態(approved側から見てapproved)なら
//     "already_resolved"を返し、二重resume/二重actionを起こさない。
//   - pending以外(rejected/cancelled/expired、または逆側の終端状態)
//     からapproved/rejectedへは絶対に遷移させない
//     ("invalid_transition")。
export type ApprovalResolutionOutcome =
  | { status: "not_found" }
  | { status: "already_resolved"; approval: Approval }
  | { status: "invalid_transition"; approval: Approval }
  | { status: "approved"; approval: Approval; workResumed: boolean }
  | { status: "rejected"; approval: Approval };

// Work所有者(Approval経由でWork.userIdへ辿る、既存のgetApproval()の
// ownership defenseをそのまま使う)以外はこの関数へ到達できない
// ——resolved tactUserId(Bot経由ならserver側で解決済みの値)以外を
// userIdとして渡さないことは呼び出し元の責務(BOT-P2.5の既存絶対
// 条件をそのまま継承する)。
export async function approveApproval(
  workId: string,
  userId: string,
  accessToken: string,
  approvalId: string,
  response?: string,
  deps: ApprovalExecutionDeps = defaultDeps
): Promise<ApprovalResolutionOutcome> {

  const approval = await deps.getApproval(workId, userId, accessToken, approvalId);

  if (!approval) {
    return { status: "not_found" };
  }

  if (approval.status === "approved") {
    return { status: "already_resolved", approval };
  }

  if (approval.status !== "pending") {
    return { status: "invalid_transition", approval };
  }

  await deps.updateApprovalStatus(workId, userId, accessToken, approvalId, "approved", response);

  // Phase B3指示Section9: Workをrunningへ戻す前に、同一Workに未解決
  // pending Approvalが残っていないか確認する(1件approveしただけで
  // Workを誤ってresumeしない)。
  const remaining = await deps.listApprovalsForWork(workId, userId, accessToken);
  const stillPending = remaining.some(
    (other) => other.id !== approvalId && other.status === "pending"
  );

  let workResumed = false;

  if (!stillPending) {
    await deps.updateWorkStatus(workId, userId, accessToken, "running");
    workResumed = true;
  }

  return {
    status: "approved",
    approval: { ...approval, status: "approved", response: response ?? null },
    workResumed,
  };

}

// reject: 対象actionを実行させないことが目的のため、承認とは異なり
// 「他に未解決のpending Approvalが残っているか」に関わらず、この
// Approvalが紐づくWork/Taskを即座に終端状態(failed)へ進める
// (Phase B3指示Section8: waiting_for_approval -> failed/cancelledの
// うちfailedを採用——「実行の可否を問う判断が否定された」ことは
// Taskの実行失敗と同じ意味を持つため、既存のTask/Work failed
// semanticsをそのまま再利用する。新しいstatusは追加しない)。
//
// Known scope limitation(Phase B3、完了報告に記載): 同一Workに他の
// pending Approvalが残っている場合でも、それらを自動でcancelしない
// (複雑なApproval graphの構築を避けるための意図的な単純化)。
export async function rejectApproval(
  workId: string,
  userId: string,
  accessToken: string,
  approvalId: string,
  response?: string,
  deps: ApprovalExecutionDeps = defaultDeps
): Promise<ApprovalResolutionOutcome> {

  const approval = await deps.getApproval(workId, userId, accessToken, approvalId);

  if (!approval) {
    return { status: "not_found" };
  }

  if (approval.status === "rejected") {
    return { status: "already_resolved", approval };
  }

  if (approval.status !== "pending") {
    return { status: "invalid_transition", approval };
  }

  await deps.updateApprovalStatus(workId, userId, accessToken, approvalId, "rejected", response);

  if (approval.taskId) {
    await deps.updateTaskStatus(workId, userId, accessToken, approval.taskId, "failed");
  }

  await deps.updateWorkStatus(workId, userId, accessToken, "failed");

  return {
    status: "rejected",
    approval: { ...approval, status: "rejected", response: response ?? null },
  };

}
