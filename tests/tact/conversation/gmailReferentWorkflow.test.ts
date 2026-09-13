// =========================
// TACT Conversation — REF-P1f Referent-Aware Gmail Work Wiring
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのprepareGmailWorkAction()/
// createGmailReferentApproval()(REF-P1f、production referent path)。
// 実Supabase/実Composio APIには一切接続しない(既存
// tests/tact/integration/sourceReferentExecution.test.tsと同じDI手法)。
//
// LIVE-READINESS TEST(このphaseの明示的要求): 「Provider network
// executionはmockしてよいが、内部production path(real ApprovalSubject
// building/real protected-write extraction/real Approval Integrity)は
// real でなければならない」という要求に従い、Approval構築の実ロジック
// (core/tact-work/approval.tsのrequestApproval()、
// core/tact-work/approvalIntegrity.tsのbuildApprovalSubject())は
// このtest自身が再実装せず、実関数をI/O境界(store.tsのcreateApproval)
// だけ差し替えて呼ぶ。connectionId round tripの最終確認は、実際の
// core/tact-integration/execution.tsのexecuteApprovedIntegrationAction()
// (Approval Integrity検証・Provider入力生成を完全に内包する既存境界)
// へ通すことで行う。

import {
  prepareGmailWorkAction,
  createGmailReferentApproval,
  type GmailReferentWorkflowDeps,
} from "../../../core/tact-conversation/orchestration";
import type { ContextResolutionResult } from "../../../core/tact-context-resolution";
import {
  requestApproval as realRequestApproval,
  buildApprovalSubject,
  type ApprovalExecutionDeps,
} from "../../../core/tact-work";
import type { Approval, ResolvedWorkIntent, Work, WorkTask, Run } from "../../../core/tact-work/types";
import type { GmailMessageSummary } from "../../../core/tact-integration/types";
import type { ResolveIntegrationConnectionOutcome } from "../../../core/tact-work/execution";
import type { CommunicationCandidate, SourceReferentSnapshot } from "../../../core/tact-referent/types";
import { buildCandidateSnapshot, hashCandidateSnapshot } from "../../../core/tact-referent/clarification";
import { executeApprovedIntegrationAction, type ExecuteApprovedIntegrationActionDeps } from "../../../core/tact-integration/execution";
import { mapGmailActionToComposioTool } from "../../../core/tact-integration/providers/composio/mappings/gmail";
import type { Connection, IntegrationExecutionResult } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";
const WORK_ID = "work-1";

function makeIntent(overrides: Partial<ResolvedWorkIntent> = {}): ResolvedWorkIntent {
  return {
    subject: "TACTテスト商事の更新案件",
    objective: "TACTテスト商事の更新案件について返信する",
    title: "TACTテスト商事への返信",
    requestType: "act",
    completionConditions: [],
    requiredCapabilities: [],
    ...overrides,
  };
}

function gmailMessage(overrides: Partial<GmailMessageSummary> & Pick<GmailMessageSummary, "messageId">): GmailMessageSummary {
  return { ...overrides };
}

function contextResolutionWithGmail(messages: GmailMessageSummary[]): ContextResolutionResult {
  return {
    plan: { kind: "ready", requestText: "trigger", sources: { gmail: { query: "更新案件" } } },
    pack: { request: { text: "trigger" }, subject: { queryTerms: [] }, evidence: [], metrics: { evidenceCount: 0, totalChars: 0, truncated: false } },
    sources: { gmail: "available" },
    rawGmailSearch: { messages },
  };
}

let taskCounter = 0;

function makeWork(): Work {
  return {
    id: WORK_ID,
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

interface DepsCalls {
  createTaskCalls: number;
  requestApprovalCalls: number;
  requestReferentClarificationCalls: number;
  executeReadIntegrationActionCalls: number;
  lastReferentClarificationCandidates?: readonly CommunicationCandidate[];
  lastApprovalPayload?: Record<string, unknown>;
}

function makeDeps(overrides: Partial<GmailReferentWorkflowDeps> = {}): { deps: GmailReferentWorkflowDeps; calls: DepsCalls } {

  const calls: DepsCalls = {
    createTaskCalls: 0,
    requestApprovalCalls: 0,
    requestReferentClarificationCalls: 0,
    executeReadIntegrationActionCalls: 0,
  };

  const approvalExecutionDeps: ApprovalExecutionDeps = {
    getWork: async () => makeWork(),
    createApproval: async (workId, userId, _accessToken, params) => ({
      id: "approval-1",
      workId,
      taskId: params.taskId ?? null,
      requestedByActorKind: params.requestedByActorKind,
      requestedByActorId: params.requestedByActorId,
      requestedFromActorKind: params.requestedFromActorKind,
      requestedFromActorId: params.requestedFromActorId,
      allowedApproverIds: params.allowedApproverIds ?? null,
      status: "pending",
      reason: params.reason,
      payload: params.payload,
      subjectVersion: params.subjectVersion ?? null,
      subject: params.subjectJson ?? null,
      subjectHash: params.subjectHash ?? null,
      requestedAt: "2026-09-13T00:00:00.000Z",
      createdAt: "2026-09-13T00:00:00.000Z",
    }),
    getApproval: async () => undefined,
    updateApprovalStatus: async () => {},
    listApprovalsForWork: async () => [],
    updateWorkStatus: async () => {},
    updateTaskStatus: async () => {},
    emitAuditEvent: async () => {},
  };

  const deps: GmailReferentWorkflowDeps = {

    listApprovalsForWork: async () => [],

    listClarificationsForWork: async () => [],

    resolveIntegrationConnection: async (): Promise<ResolveIntegrationConnectionOutcome> => ({ status: "single", connectionId: "conn-1" }),

    createTask: async (workId, _userId, _accessToken, params): Promise<WorkTask> => {
      calls.createTaskCalls += 1;
      taskCounter += 1;
      return {
        id: `task-${taskCounter}`,
        workId,
        description: params.description,
        assignedCapability: params.assignedCapability ?? null,
        status: "pending",
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      };
    },

    // 既定はnarrow re-queryを一切実行しない(呼ばれないはずのtestで
    // 誤って"completed"を返し、broad-only fail closedを覆い隠さない
    // ようにする)。narrow re-queryを検証するtestだけがoverrideする。
    executeReadIntegrationAction: async () => {
      calls.executeReadIntegrationActionCalls += 1;
      return { status: "invalid_action" };
    },

    buildApprovalSubject,

    requestApproval: async (request) => {
      calls.requestApprovalCalls += 1;
      calls.lastApprovalPayload = request.action?.metadata;
      return realRequestApproval(request, OWNER_USER_ID, "token", approvalExecutionDeps);
    },

    requestReferentClarification: async (request) => {
      calls.requestReferentClarificationCalls += 1;
      calls.lastReferentClarificationCandidates = request.candidates;
      const snapshot = buildCandidateSnapshot(request.candidates);
      return {
        id: "clarification-1",
        workId: request.workId,
        taskId: request.taskId ?? null,
        requestedByActorKind: request.requestedByActor.kind,
        requestedByActorId: request.requestedByActor.id,
        status: "pending",
        reasonCode: "missing_required_input",
        question: request.question,
        requestedAt: "2026-09-13T00:00:00.000Z",
        createdAt: "2026-09-13T00:00:00.000Z",
        candidateSnapshot: snapshot,
        candidateSnapshotHash: hashCandidateSnapshot(snapshot),
      };
    },

    ...overrides,

  };

  return { deps, calls };

}

// =========================
// executeApprovedIntegrationAction()経由での実connectionId round trip確認
// (Part A最終確認: prepareGmailWorkAction()が作ったApprovalが実際に
// 実行境界を通過できること)
// =========================

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "gmail",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_gmail_1",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: WORK_ID,
    taskId: "task-1",
    attempt: 1,
    capability: "integration.gmail.send_message",
    provider: "composio",
    status: "running",
    startedAt: "2026-09-13T00:00:00.000Z",
    createdAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

async function executeApprovalForReal(approval: Approval): Promise<{ outcome: Awaited<ReturnType<typeof executeApprovedIntegrationAction>>; providerCalls: number }> {

  let providerCalls = 0;

  const deps: ExecuteApprovedIntegrationActionDeps = {
    getWork: async (workId, userId) => (userId === OWNER_USER_ID ? { ...makeWork(), id: workId } : undefined),
    getApproval: async (_workId, userId, _accessToken, approvalId) =>
      userId === OWNER_USER_ID ? { ...approval, id: approvalId } : undefined,
    getConnection: async (connectionId, userId) => (userId === OWNER_USER_ID ? makeConnection({ id: connectionId }) : undefined),
    listTasksForWork: async () => [{ id: approval.taskId ?? "task-1", workId: WORK_ID, description: "test", status: "pending", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" }],
    listRunsForTask: async () => [],
    createRun: async (workId, _userId, _accessToken, taskId, params) =>
      makeRun({ workId, taskId, attempt: params.attempt, capability: params.capability, provider: params.provider ?? null }),
    completeRun: async () => {},
    failRun: async () => {},
    attachRunExternalRef: async () => {},
    updateTaskStatus: async () => {},
    executeIntegrationAction: async (): Promise<IntegrationExecutionResult> => {
      providerCalls += 1;
      return { status: "completed", providerExecutionRef: "log-1", output: { ok: true } };
    },
    reconcileWorkCompletionStatus: async () => ({ status: "no_change", reason: "tasks_not_all_terminal" }),
    emitAuditEvent: async () => {},
  };

  const outcome = await executeApprovedIntegrationAction(WORK_ID, OWNER_USER_ID, "token", approval.id, deps);

  return { outcome, providerCalls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. narrowed一意一致 -> resolved -> Approvalが作られ、
  // connectionIdがmetadataへ実際に含まれ、実executeApprovedIntegrationAction()
  // をprovider callまで完走できる(Part A: pre-existing connectionId gapの修正確認) ----
  {
    const narrowMessage = gmailMessage({
      messageId: "m1", threadId: "t1", from: "tanaka@example.com",
      subject: "更新案件の追加確認", date: "2026-09-12T02:00:00.000Z",
    });

    const { deps, calls } = makeDeps({
      executeReadIntegrationAction: async () => {
        calls.executeReadIntegrationActionCalls += 1;
        return { status: "completed", resultOutput: JSON.stringify({ messages: [narrowMessage] }) };
      },
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail([narrowMessage]),
      currentTriggerText: "「更新案件の追加確認」ってメール、これ対応しといて",
    }, deps);

    const approval = outcome.kind === "approval" ? outcome.approval : undefined;
    const metadata = approval?.payload.action && typeof approval.payload.action === "object"
      ? (approval.payload.action as { metadata?: Record<string, unknown> }).metadata
      : undefined;

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 1. narrowed一意一致はresolvedとなりApprovalが作られる",
      outcome.kind === "approval" && calls.executeReadIntegrationActionCalls === 1
    ));

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 2. Part A: Approval.payload.action.metadataにconnectionIdが実際に含まれる(pre-existing gapの修正)",
      metadata?.connectionId === "conn-1"
    ));

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 3. Approval.payload.action.metadataにsourceReferent(SourceReferentSnapshot)が含まれる",
      !!metadata?.sourceReferent &&
        (metadata.sourceReferent as SourceReferentSnapshot).sourceMessageRef === "m1" &&
        (metadata.sourceReferent as SourceReferentSnapshot).sender === "tanaka@example.com"
    ));

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 4. sourceReferentはaction.input側には一切現れない(provider leak防止)",
      !!metadata?.input && !("sourceReferent" in (metadata.input as Record<string, unknown>))
    ));

    if (approval) {

      const { outcome: execOutcome, providerCalls } = await executeApprovalForReal({ ...approval, status: "approved" });

      results.push(check(
        "[REF-P1f gmailReferentWorkflow] 5. Part A最終確認: 実executeApprovedIntegrationAction()がconnectionIdを正しく抽出しProviderを1回だけ呼ぶ(invalid_actionにならない)",
        execOutcome.status === "completed" && providerCalls === 1
      ));

      const mapped = mapGmailActionToComposioTool({
        service: "gmail", operation: "send_message",
        input: (metadata!.input as { to: string[]; subject: string; bodyText: string }),
      });

      results.push(check(
        "[REF-P1f gmailReferentWorkflow] 6. 実mapGmailActionToComposioTool()もこのApprovalのinputをそのまま正常にProvider引数化できる",
        mapped.ok === true
      ));

    } else {
      results.push(check("[REF-P1f gmailReferentWorkflow] 5/6. (skipped: no approval)", false, "approval was not created"));
    }

  }

  // ---- 7. connectionId解決不可 -> unavailable、Approval/Task/検索は一切発生しない ----
  {
    const { deps, calls } = makeDeps({
      resolveIntegrationConnection: async () => ({ status: "none" }),
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail([gmailMessage({ messageId: "m1", from: "tanaka@example.com", subject: "更新案件について" })]),
      currentTriggerText: "「更新案件について」ってメール、これ対応しといて",
    }, deps);

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 7. connectionId解決不可(none)はunavailableとなり、Task作成・Approval作成のいずれも発生しない",
      outcome.kind === "unavailable" && calls.createTaskCalls === 0 && calls.requestApprovalCalls === 0
    ));
  }

  // ---- 8. 既存pending Approvalの再利用(重複生成防止) ----
  {
    const existingApproval: Approval = {
      id: "approval-existing", workId: WORK_ID, taskId: "task-existing",
      requestedByActorKind: "ai", requestedByActorId: "gmail-work",
      requestedFromActorKind: "user", requestedFromActorId: OWNER_USER_ID,
      status: "pending", reason: "test",
      payload: { action: { kind: "external_message", summary: "s", metadata: { service: "gmail", operation: "send_message" } } },
      requestedAt: "2026-09-13T00:00:00.000Z", createdAt: "2026-09-13T00:00:00.000Z",
    };

    const { deps, calls } = makeDeps({
      listApprovalsForWork: async () => [existingApproval],
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail([gmailMessage({ messageId: "m1", from: "tanaka@example.com", subject: "更新案件について" })]),
      currentTriggerText: "「更新案件について」ってメール、これ対応しといて",
    }, deps);

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 8. 既存pending Gmail Approvalがある場合は再利用し、新規Task/Approval/検索を一切発生させない",
      outcome.kind === "approval" && outcome.approval.id === "approval-existing" &&
        calls.createTaskCalls === 0 && calls.requestApprovalCalls === 0 && calls.executeReadIntegrationActionCalls === 0
    ));
  }

  // ---- 9. 既存pending referent Clarificationの再利用(重複生成防止) ----
  {
    const { deps, calls } = makeDeps({
      listClarificationsForWork: async () => [{
        id: "clarification-existing", workId: WORK_ID, taskId: null,
        requestedByActorKind: "ai", requestedByActorId: "gmail-work",
        status: "pending", reasonCode: "missing_required_input", question: "既存の質問文",
        requestedAt: "2026-09-13T00:00:00.000Z", createdAt: "2026-09-13T00:00:00.000Z",
        candidateSnapshot: [{ index: 1, sourceMessageRef: "m1" }],
        candidateSnapshotHash: "deadbeef",
      }],
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail([gmailMessage({ messageId: "m1", from: "tanaka@example.com", subject: "更新案件について" })]),
      currentTriggerText: "「更新案件について」ってメール、これ対応しといて",
    }, deps);

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 9. 既存pending referent Clarificationがある場合は再利用し(その質問文をそのまま返す)、新規検索/Clarificationを一切発生させない",
      outcome.kind === "clarification_pending" && outcome.question === "既存の質問文" &&
        calls.executeReadIntegrationActionCalls === 0 && calls.requestReferentClarificationCalls === 0
    ));
  }

  // ---- 10. SEARCH COMPLETENESS: narrowing signalが無いbroad-onlyの
  // 場合、たとえ1件だけの一見有望な候補があってもWRITEを自動解決しない ----
  {
    const { deps, calls } = makeDeps();

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail([gmailMessage({ messageId: "m1", from: "tanaka@example.com", subject: "更新案件について", date: "2026-09-12T00:00:00.000Z" })]),
      // 引用subjectも明示的なsender「から」も含まない、素朴な依頼文
      // (narrowing signalが一切抽出されない)。
      currentTriggerText: "この件、対応しといて",
    }, deps);

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 10. narrowing signalが無いbroad-onlyのcandidate universeは、1件だけの候補でもWRITEを自動解決しない(narrow re-query自体が試みられない)",
      outcome.kind === "fail_closed" && calls.executeReadIntegrationActionCalls === 0 && calls.requestApprovalCalls === 0
    ));
  }

  // ---- 11. NO BROAD FALLBACK AFTER FAILED NARROW SEARCH: narrow
  // re-queryがprovider errorで失敗した場合、broadへフォールバックして
  // 自動解決しない ----
  {
    const { deps, calls } = makeDeps({
      executeReadIntegrationAction: async () => {
        calls.executeReadIntegrationActionCalls += 1;
        return { status: "failed" };
      },
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail([gmailMessage({ messageId: "m1", from: "tanaka@example.com", subject: "更新案件について" })]),
      currentTriggerText: "「更新案件について」ってメール、これ対応しといて",
    }, deps);

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 11. narrow re-query失敗後にbroad candidate universeへフォールバックしてWRITE解決しない(fail closed)",
      outcome.kind === "fail_closed" && calls.executeReadIntegrationActionCalls === 1 && calls.requestApprovalCalls === 0
    ));
  }

  // ---- 12. AMBIGUOUS CASE: 2件が同じ件名で差別化要因が無い -> referent
  // Clarificationが作られ、候補がそのまま渡される ----
  {
    const twinMessages = [
      gmailMessage({ messageId: "m1", from: "tanaka@example.com", subject: "更新案件について" }),
      gmailMessage({ messageId: "m2", from: "sato@example.com", subject: "更新案件について" }),
    ];

    const { deps, calls } = makeDeps({
      executeReadIntegrationAction: async () => {
        calls.executeReadIntegrationActionCalls += 1;
        return { status: "completed", resultOutput: JSON.stringify({ messages: twinMessages }) };
      },
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail(twinMessages),
      currentTriggerText: "「更新案件について」ってメール、これ対応しといて",
    }, deps);

    const question = outcome.kind === "clarification_pending" ? outcome.question : undefined;

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 12. 差別化要因の無い2件同一件名はambiguousとなり、referent Clarificationが作られ2件の候補がそのまま渡される",
      outcome.kind === "clarification_pending" &&
        calls.requestReferentClarificationCalls === 1 &&
        calls.lastReferentClarificationCandidates?.length === 2 &&
        !!question && question.includes("1.") && question.includes("2.") &&
        question.includes("番号で選んでください")
    ));

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 13. Clarification質問文に内部message ID(m1/m2)が一切露出しない",
      !!question && !question.includes("m1") && !question.includes("m2")
    ));
  }

  // ---- 14. CLARIFICATION SIZE LIMIT: 6件(MAX_DIRECT_REFERENT_CHOICES超)
  // -> 番号付き選択肢を一切生成せず、安全な「もう少し条件を」メッセージへ
  // 倒す。Clarificationも一切作らない ----
  {
    const manyMessages = Array.from({ length: 6 }, (_, i) =>
      gmailMessage({ messageId: `m${i + 1}`, from: `sender${i}@example.com`, subject: "更新案件について" })
    );

    const { deps, calls } = makeDeps({
      executeReadIntegrationAction: async () => {
        calls.executeReadIntegrationActionCalls += 1;
        return { status: "completed", resultOutput: JSON.stringify({ messages: manyMessages }) };
      },
    });

    const outcome = await prepareGmailWorkAction({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(),
      contextResolution: contextResolutionWithGmail(manyMessages),
      currentTriggerText: "「更新案件について」ってメール、これ対応しといて",
    }, deps);

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 14. 候補が安全上限(5件)を超える場合、番号付き選択肢を提示せずclarification_too_largeとなり、Clarificationも一切作らない",
      outcome.kind === "clarification_too_large" && calls.requestReferentClarificationCalls === 0
    ));
  }

  // ---- 15. PINNED SELECTION -> createGmailReferentApproval(): Clarification
  // でpinされたcandidate(CandidateSnapshotEntry → SourceReferentSnapshot)
  // からも、connectionId/sourceReferentを含む同じApprovalが正しく作られる
  // (runReferentClarificationAnswerTurn()が内部で使う経路と同一)。ここでも
  // body/snippetは一切参照しない(SourceReferentSnapshot自体に無いため)。 ----
  {
    const pinnedReferent: SourceReferentSnapshot = {
      sourceType: "gmail",
      sourceMessageRef: "m2",
      threadRef: "t2",
      sender: "sato@example.com",
      normalizedSubject: "更新案件について",
      observedAt: "2026-09-12T00:00:00.000Z",
    };

    const { deps, calls } = makeDeps();

    const created = await createGmailReferentApproval({
      workId: WORK_ID, userId: OWNER_USER_ID, accessToken: "token",
      intent: makeIntent(), referent: pinnedReferent,
    }, deps);

    const metadata = created.approval?.payload.action && typeof created.approval.payload.action === "object"
      ? (created.approval.payload.action as { metadata?: Record<string, unknown> }).metadata
      : undefined;

    results.push(check(
      "[REF-P1f gmailReferentWorkflow] 15. pinされたcandidate(SourceReferentSnapshot)からもconnectionId/sourceReferentを含むApprovalが正しく作られる",
      !!created.approval && calls.requestApprovalCalls === 1 &&
        metadata?.connectionId === "conn-1" &&
        (metadata?.sourceReferent as SourceReferentSnapshot | undefined)?.sourceMessageRef === "m2" &&
        (metadata?.input as { to: string[] } | undefined)?.to?.[0] === "sato@example.com"
    ));
  }

  return summarize("conversation/gmailReferentWorkflow", results);

}
