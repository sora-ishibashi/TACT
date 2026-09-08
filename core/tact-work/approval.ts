import {
  getWork,
  createApproval,
  getApproval,
  updateApprovalStatus,
  listApprovalsForWork,
  updateWorkStatus,
  updateTaskStatus,
} from "./store";
import type { Approval, ActorReference, WorkStatus } from "./types";
import {
  canonicalizeApprovalSubject,
  hashApprovalSubject,
  type ApprovalSubject,
} from "./approvalIntegrity";
// Fast Port P4b(docs/architecture/p2-p5-final-architecture.md
// Section15-20): Audit emission。approval.ts自身がapproval.requested/
// approved/rejectedのcanonical emitterである(絶対条件Step14: 二重
// emission回避、canonical mutation ownerがemitする)。
import { emitAuditSafely } from "./audit";

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

  // Fast Port P3b(HumanLayer ACP AllowedResponderIDs pattern)。省略時
  // (既存の全呼び出し元)はcanonical owner-only(既定)のまま——
  // checkApproverAllowed()参照。
  allowedApproverIds?: string[] | null;

  metadata?: Record<string, unknown>;

  // Architecture Migration ARCH-P1b: 呼び出し元(core/tact-work/
  // execution.ts)が、既にcanonical integration action(service/
  // operation/input/connectionId)を持っている時点で
  // core/tact-work/approvalIntegrity.tsのbuildApprovalSubject()を使い
  // 組み立て済みのApproval Subject v1。このfile自身はSlack/Composio/
  // Integration固有のaction formatを一切知らない——既に構築済みの
  // 汎用ApprovalSubject型を受け取り、canonicalize+hashするだけ
  // (絶対条件、Approval layerがProvider固有formatを知らない設計を
  // 維持する)。省略時(Integration以外の将来Capability等、または
  // subject構築自体に失敗したTask)は、この承認にsubject evidenceを
  // 一切保存しない(fail closedはbuildApprovalSubject()呼び出し元
  // (execution.ts)の責務——この関数はsubjectが無いことをエラーとは
  // 扱わない、後方互換のため)。
  subject?: ApprovalSubject;

}

export interface ApprovalExecutionDeps {

  getWork: typeof getWork;

  createApproval: typeof createApproval;

  getApproval: typeof getApproval;

  updateApprovalStatus: typeof updateApprovalStatus;

  listApprovalsForWork: typeof listApprovalsForWork;

  updateWorkStatus: typeof updateWorkStatus;

  updateTaskStatus: typeof updateTaskStatus;

  // Fast Port P4b: Audit-safe emission(既定は実emitAuditSafely——
  // テストはfake実装を注入し、real Supabaseへの誤接続を防ぐ、Fast
  // Port P4a incidentの教訓、Step13)。
  emitAuditEvent: typeof emitAuditSafely;

}

const defaultDeps: ApprovalExecutionDeps = {
  getWork,
  createApproval,
  getApproval,
  updateApprovalStatus,
  listApprovalsForWork,
  updateWorkStatus,
  updateTaskStatus,
  emitAuditEvent: emitAuditSafely,
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
// Architecture Migration ARCH-P1b: request.subject(既に検証済みの
// ApprovalSubject、buildApprovalSubject()がJSON-safety検証済み)を、
// tact_approvals.subject_*列(core/tact-work/store.tsのCreateApprovalParams)
// へ渡すための最小限のfield集合へ変換する。canonicalize/hash自体は
// 決定論的なpure変換であり、ここで新たに失敗しうる検証は無い
// (subjectが有効なApprovalSubjectであることは呼び出し元の責務、
// buildApprovalSubject()が既に保証済み)。
function toSubjectStorageFields(subject: ApprovalSubject | undefined): {
  subjectVersion?: number | null;
  subjectJson?: Record<string, unknown> | null;
  subjectHash?: string | null;
  subjectCapturedAt?: string | null;
} {

  if (!subject) {
    return {};
  }

  const canonicalJson = canonicalizeApprovalSubject(subject);

  return {
    subjectVersion: subject.subjectVersion,
    subjectJson: subject as unknown as Record<string, unknown>,
    subjectHash: hashApprovalSubject(canonicalJson),
    // subject_captured_atはDB defaultを持たない(supabase/migrations/
    // 20260909000000_add_tact_approvals_integrity_fields.sql参照、
    // 将来の非同期capture等に備えてapp側で明示的に設定する設計)。
    // P1b時点ではApproval作成と同じタイミングでしか captureしない
    // ため、この時刻は実質requested_at(DB default now())とほぼ
    // 一致する。
    subjectCapturedAt: new Date().toISOString(),
  };

}

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
      allowedApproverIds: request.allowedApproverIds ?? null,
      reason: request.reason,
      payload: toApprovalPayload(request),
      ...toSubjectStorageFields(request.subject),
    }
  );

  if (!approval) {
    return undefined;
  }

  await deps.updateWorkStatus(request.workId, userId, accessToken, "waiting_for_approval");

  // Fast Port P4b(Step4): approval.requestedのcanonical emitter。
  // Approval row作成成功後にemitする(絶対条件: 事実が確定した地点、
  // 推測でemit位置を決めない)。details/reasonCodeはStep19の
  // data minimization方針に従い最小限(riskClass snapshotと
  // allowedApproverの件数のみ、subject_json/canonicalInput/secretは
  // 一切含めない)。
  await deps.emitAuditEvent(
    {
      workId: request.workId,
      taskId: approval.taskId,
      approvalId: approval.id,
      category: "approval",
      eventType: "approval.requested",
      actor: request.requestedByActor,
      details: {
        riskClass: request.subject?.riskClassSnapshot ?? null,
        allowedApproverCount: request.allowedApproverIds?.length ?? 0,
      },
    },
    userId,
    accessToken
  );

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
//
// Phase B3 Final Fix / Final Final Fix(Canonical invariant):
//   Approval can transition a Work only while
//   Work.status === "waiting_for_approval".
//     approve: waiting_for_approval -> running
//     reject:  waiting_for_approval -> failed
//   Terminal Work(completed/failed/cancelled、またはその他の
//   non-waiting state)は、approve/rejectのいずれからも一切変更
//   できない("work_not_resumable")——Approval自体もpendingのまま
//   残り、通常のapprove/rejectとして解決されない。
//
// 背景(発見された穴、Final Fix): WorkにApproval A/Bがpendingの状態で
// Aをrejectすると Workはfailedへ進むが、Bはpendingのまま残る。この
// 状態でBをapproveすると、「他にpendingが残っていない」という条件
// だけを見てWorkをrunningへ戻してしまい、rejectによって既に
// terminalへ確定したWorkが復活してしまっていた(approve側で修正)。
//
// 背景(発見された穴、Final Final Fix): 対称的に、既にcompleted等で
// 確定したWorkに対して古いpending Approvalをrejectすると、そのWork
// をfailedへ後退させてしまう余地が残っていた(「terminal Workの
// 復活」とは逆方向の「terminal Workの後退」)。reject側にも同じ
// guardを適用することで解消した。
export type ApprovalResolutionOutcome =
  | { status: "not_found" }
  | { status: "already_resolved"; approval: Approval }
  | { status: "invalid_transition"; approval: Approval }
  | { status: "work_not_resumable"; approval: Approval; workStatus: WorkStatus }
  // Fast Port P3b(Human Interaction Foundation拡張、絶対条件10/11)。
  | { status: "self_approval_forbidden"; approval: Approval }
  | { status: "approver_not_allowed"; approval: Approval }
  | { status: "approved"; approval: Approval; workResumed: boolean }
  | { status: "rejected"; approval: Approval };

// =========================
// Actor Restriction (Fast Port P3b: Anti-Self-Approval Enforcement)
// =========================
//
// Prior Art(ADAPT_AND_BORROW、source codeはコピーしない): HumanLayer
// ACPのAllowedResponderIDs pattern・PreloopのAI/self-like decision
// boundary defense。Commercial Reviewで確認済みのLindyの"the person
// who asked can approve their own request"というshipping
// counter-exampleを反面教師とする——TACTではこれを構造的に禁止する
// (絶対条件10/11、docs/prior-art/commercial-reference-review.md
// Section4)。
//
// 設計判断(Fast Port P3b指示のCritical design question、Option B採用、
// 実repo調査で確定): 現在の唯一のlive Approval producer
// (core/tact-work/execution.tsのapprovalRequirements drain loop、
// core/tact-integration/propose.tsのproposeIntegrationAction()は
// 現時点で呼び出し元が存在しない未配線のfoundationコードであることを
// grep調査で確認済み)は、requestedByActorKindを常に"ai"
// (Capability自身)として設定する——人間がrequesterになる経路は
// 現時点で存在しない。したがって:
//   - requestedByActorKind !== "user"(ai/bot/system)の場合、
//     self-checkは常にスキップされる(異なるactor kind同士は
//     「同一actor」たり得ない——Step4「system/agent requests, human
//     approves → allowed」)。これにより、現在の本番Slack E2E
//     (Capability → Approval → 人間owner承認)は一切影響を受けない
//     (Step17/18参照、Production Compatibility Review)。
//   - requestedByActorKind === "user"の場合のみ、requestedByActorIdと
//     決定を下すuserId(approveApproval()/rejectApproval()の既存の
//     呼び出し規約上、常にWeb JWT/Bot resolved tactUserIdという
//     人間アカウントのid)が一致するかどうかで判定する——一致すれば
//     self_approval_forbiddenとしてfail closedする。将来、人間が
//     requesterとなる経路(例: proposeIntegrationAction()の将来の
//     呼び出し元)が実装された場合に、初めて意味を持つ防御となる。
//
// allowedApproverIds(HumanLayer ACP AllowedResponderIDs pattern、
// core/tact-work/clarification.tsのallowedResponderIdsと同じ設計)。
// undefined/null/空配列 = canonical owner-only(既定、Work ownership
// 経由のgetApproval()が既に構造的に強制する)。non-empty配列 =
// 明示allowlist。P3b時点でこれを実際に設定するproducerは存在しない
// ため、Clarificationの同fieldと同じくfoundationのみ(型・チェック
// ロジックは実装するが、未populateの間は常にno-op)。
//
// LLM判定禁止(絶対条件9): このcheckは純粋な文字列比較のみで構成され、
// LLM・Provider・Search呼び出しのいずれも一切行わない。
export type ApprovalActorRestrictionFailure = "self_approval_forbidden" | "approver_not_allowed";

export function checkApproverAllowed(
  approval: Pick<Approval, "requestedByActorKind" | "requestedByActorId" | "allowedApproverIds">,
  decidingUserId: string
): { ok: true } | { ok: false; reason: ApprovalActorRestrictionFailure } {

  if (approval.requestedByActorKind === "user" && approval.requestedByActorId === decidingUserId) {
    return { ok: false, reason: "self_approval_forbidden" };
  }

  if (
    approval.allowedApproverIds &&
    approval.allowedApproverIds.length > 0 &&
    !approval.allowedApproverIds.includes(decidingUserId)
  ) {
    return { ok: false, reason: "approver_not_allowed" };
  }

  return { ok: true };

}

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

  // Phase B3 Final Fix: ApprovalをapprovedへUPDATEする前に、Workが
  // 実際に"waiting_for_approval"であることを確認する。Work自体が
  // reject等で既にterminal(completed/failed/cancelled)、またはその他
  // のnon-waiting stateへ進んでいた場合は、このApprovalを通常の
  // approveとして解決しない(Approval自体もpendingのまま残す——
  // "work_not_resumable"で安全に拒否するだけで、DBは一切書き換えない)。
  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  if (work.status !== "waiting_for_approval") {
    return { status: "work_not_resumable", approval, workStatus: work.status };
  }

  // Fast Port P3b(絶対条件10/11、最重要): ApprovalをapprovedへUPDATE
  // する前に、決定を下すactor(userId)がこのApprovalを承認可能かを
  // 確認する。checkApproverAllowed()参照——現在の唯一のlive producer
  // (requestedByActorKind="ai")には影響しない設計(Production
  // Compatibility Review、Fast Port P3b報告参照)。
  const actorCheck = checkApproverAllowed(approval, userId);

  if (!actorCheck.ok) {
    return { status: actorCheck.reason, approval };
  }

  await deps.updateApprovalStatus(workId, userId, accessToken, approvalId, "approved", response);

  // Fast Port P4b(Step5): approval.approvedのcanonical emitter。
  // status mutation成功後にemitする。actorは実際に決定を下した
  // canonical user(userId)——Step5絶対条件通り。self_approval_forbidden/
  // approver_not_allowed等の拒否されたattemptはこのPhaseではemit
  // しない(successful state transitionのみをcanonical lifecycle
  // eventとする、Step5の明示的な最小推奨——理由はFinal Reportで報告)。
  await deps.emitAuditEvent(
    {
      workId,
      taskId: approval.taskId,
      approvalId: approval.id,
      category: "approval",
      eventType: "approval.approved",
      actor: { kind: "user", id: userId },
    },
    userId,
    accessToken
  );

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
//
// Phase B3 Final Final Fix(Reject Terminal Work Guard): approveApproval()
// と全く同じCanonical invariant——「Approval resolutionがWorkを
// 変更できるのはWork.status === "waiting_for_approval"の場合だけ」
// ——をrejectにも適用する。既にcompleted/failed/cancelled(またはその
// 他のnon-waiting state)であるWorkに対して古いpending Approvalを
// rejectしても、そのWorkをfailedへ後退させてはならない
// ("Approval resolution must never mutate a terminal Work")。
// approve側と同じ"work_not_resumable"を再利用し、新しいresult
// variantは追加しない(呼び出し元からは「このApprovalはもう
// Work操作の対象にならない」という同じ意味として扱える)。
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

  // Phase B3 Final Final Fix: Approval/Task/WorkのいずれのUPDATEより
  // 前に、Workが実際に"waiting_for_approval"であることを確認する。
  // Work自体が(他の経路・他のApproval経由で)既にterminalまたは
  // その他のnon-waiting stateへ進んでいた場合は、このApprovalを
  // 通常のrejectとして解決しない——Approval/Task/Workのいずれも
  // 一切変更せず、"work_not_resumable"で安全に拒否するだけ。
  const work = await deps.getWork(workId, userId, accessToken);

  if (!work) {
    return { status: "not_found" };
  }

  if (work.status !== "waiting_for_approval") {
    return { status: "work_not_resumable", approval, workStatus: work.status };
  }

  // Fast Port P3b(絶対条件10/11、Step7: reject decisionもallowed
  // approverのみ——self-rejectはApproval rejectionとして扱わない。
  // requesterによるwithdrawalは別concept、今回は未実装)。
  const actorCheck = checkApproverAllowed(approval, userId);

  if (!actorCheck.ok) {
    return { status: actorCheck.reason, approval };
  }

  await deps.updateApprovalStatus(workId, userId, accessToken, approvalId, "rejected", response);

  // Fast Port P4b(Step5): approval.rejectedのcanonical emitter。
  // status mutation成功後にemitする(approval.approvedと対称)。
  await deps.emitAuditEvent(
    {
      workId,
      taskId: approval.taskId,
      approvalId: approval.id,
      category: "approval",
      eventType: "approval.rejected",
      actor: { kind: "user", id: userId },
    },
    userId,
    accessToken
  );

  if (approval.taskId) {
    await deps.updateTaskStatus(workId, userId, accessToken, approval.taskId, "failed");
  }

  await deps.updateWorkStatus(workId, userId, accessToken, "failed");

  return {
    status: "rejected",
    approval: { ...approval, status: "rejected", response: response ?? null },
  };

}
