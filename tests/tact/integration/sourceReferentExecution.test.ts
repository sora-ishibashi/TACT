// =========================
// TACT Integration — SourceReferent Approval Integrity + Provider Leak
// Prevention Regression (REF-P1e)
// =========================
//
// 対象: core/tact-integration/execution.tsのexecuteApprovedIntegrationAction()
// が、Approval.payload.action.metadata.sourceReferentを安全に
// round-tripさせ、Approval Integrityで検証し、Provider(Composio)側へは
// 絶対に漏らさないことを検証する。実Supabase・実Composio APIには
// 一切接続しない(既存tests/tact/integration/execution.test.tsと同じ
// DI手法)。
//
// 絶対条件(このphaseの明示的指示、最重要):
//   - sourceReferentが変更されればApproval Integrityはfail closedし、
//     Provider(executeIntegrationAction)は一切呼ばれない。
//   - sourceReferentを持たない既存(v1)Approvalは、これまで通り
//     実行できる(後方互換性)。
//   - executeIntegrationAction()へ渡されるrequest.actionには、
//     sourceReferentというkeyそのものが一切現れない(mapperが未知
//     keyを無視するから安全、という前提には頼らない——型構造自体で
//     leakageを構造的に防ぐ)。

import {
  executeApprovedIntegrationAction,
  type ExecuteApprovedIntegrationActionDeps,
} from "../../../core/tact-integration/execution";
import { mapGmailActionToComposioTool } from "../../../core/tact-integration/providers/composio/mappings/gmail";
import type { Work, Approval, Run, WorkTask } from "../../../core/tact-work/types";
import type { Connection, IntegrationExecutionResult } from "../../../core/tact-integration/types";
import {
  buildApprovalSubject,
  canonicalizeApprovalSubject,
  hashApprovalSubject,
  type ApprovalSubject,
} from "../../../core/tact-work/approvalIntegrity";
import type { SourceReferentSnapshot } from "../../../core/tact-referent/types";
import { check, summarize, type CheckResult } from "../lib/check";

const OWNER_USER_ID = "user-1";

const GMAIL_INPUT = { to: ["tanaka@example.com"], subject: "Re: 更新案件について", bodyText: "本文" };

const SOURCE_REFERENT: SourceReferentSnapshot = {
  sourceType: "gmail",
  sourceMessageRef: "m-a",
  threadRef: "t-a",
  sender: "tanaka@example.com",
  normalizedSubject: "更新案件について",
  observedAt: "2026-09-11T00:00:00.000Z",
};

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: OWNER_USER_ID,
    createdByActorKind: "user",
    createdByActorId: OWNER_USER_ID,
    status: "running",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeMatchingSubject(overrides: Partial<ApprovalSubject> = {}, sourceReferent: SourceReferentSnapshot | null = SOURCE_REFERENT): ApprovalSubject {

  const result = buildApprovalSubject({
    workId: "work-1",
    taskId: "task-1",
    service: "gmail",
    operation: "send_message",
    input: GMAIL_INPUT,
    connectionId: "conn-1",
    riskClassSnapshot: "write",
    sourceReferent,
  });

  if (!result.ok) {
    throw new Error("test fixture itself must be buildable");
  }

  return { ...result.subject, ...overrides };

}

function subjectStorageFields(subject: ApprovalSubject): Pick<Approval, "subjectVersion" | "subject" | "subjectHash"> {
  return {
    subjectVersion: subject.subjectVersion,
    subject: subject as unknown as Record<string, unknown>,
    subjectHash: hashApprovalSubject(canonicalizeApprovalSubject(subject)),
  };
}

// 絶対条件(このtest fileの核心): storedSourceReferent(承認時に確定・
// 永続化されたApproval Subject側)とmetadataSourceReferent(payload側、
// 実行直前にextractIntegrationActionFromApproval()が読み直す側)を
// 独立にparametrizeできるようにする——改ざんシナリオは「storedは
// 元のまま、payload(=execution-time再構築の材料)だけが後から書き
// 換わった」という状況を表す。両方を常に同じ値にしてしまうと、
// 改ざんそのものを再現できない(このtest実装時に発見・修正した
// 自己バグ)。
function makeApproval(
  overrides: Partial<Approval> = {},
  metadataSourceReferent: SourceReferentSnapshot | null = SOURCE_REFERENT,
  storedSourceReferent: SourceReferentSnapshot | null = SOURCE_REFERENT
): Approval {
  return {
    id: "approval-1",
    workId: "work-1",
    taskId: "task-1",
    requestedByActorKind: "ai",
    requestedByActorId: "gmail-work",
    requestedFromActorKind: "user",
    requestedFromActorId: OWNER_USER_ID,
    status: "approved",
    reason: "test",
    payload: {
      action: {
        kind: "external_message",
        summary: "メール返信を送信",
        metadata: {
          service: "gmail",
          operation: "send_message",
          input: GMAIL_INPUT,
          connectionId: "conn-1",
          ...(metadataSourceReferent ? { sourceReferent: metadataSourceReferent } : {}),
        },
      },
    },
    requestedAt: "2026-09-11T00:00:00.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
    ...subjectStorageFields(makeMatchingSubject({}, storedSourceReferent)),
    ...overrides,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: OWNER_USER_ID,
    service: "gmail",
    status: "active",
    provider: "composio",
    providerConnectionRef: "ca_gmail_1",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "test",
    status: "pending",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    workId: "work-1",
    taskId: "task-1",
    attempt: 1,
    capability: "integration.gmail.send_message",
    provider: "composio",
    status: "running",
    startedAt: "2026-09-11T00:00:00.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(
  approvalOverride: Approval,
  overrides: Partial<ExecuteApprovedIntegrationActionDeps> = {}
) {

  const calls = {
    executeIntegrationActionCalls: 0,
    lastExecuteIntegrationActionRequest: undefined as { action: { service: string; operation: string; input: Record<string, unknown> } } | undefined,
  };

  const deps: ExecuteApprovedIntegrationActionDeps = {

    getWork: async (workId, userId) => (userId === OWNER_USER_ID ? makeWork({ id: workId }) : undefined),

    getApproval: async (_workId, userId, _accessToken, approvalId) =>
      userId === OWNER_USER_ID ? { ...approvalOverride, id: approvalId } : undefined,

    getConnection: async (connectionId, userId) => (userId === OWNER_USER_ID ? makeConnection({ id: connectionId }) : undefined),

    listTasksForWork: async () => [makeTask()],

    listRunsForTask: async () => [],

    createRun: async (workId, _userId, _accessToken, taskId, params) =>
      makeRun({ workId, taskId, attempt: params.attempt, capability: params.capability, provider: params.provider ?? null }),

    completeRun: async () => {},

    failRun: async () => {},

    attachRunExternalRef: async () => {},

    updateTaskStatus: async () => {},

    executeIntegrationAction: async (request): Promise<IntegrationExecutionResult> => {
      calls.executeIntegrationActionCalls += 1;
      calls.lastExecuteIntegrationActionRequest = request as unknown as typeof calls.lastExecuteIntegrationActionRequest;
      return { status: "completed", providerExecutionRef: "log-1", output: { ok: true } };
    },

    reconcileWorkCompletionStatus: async () => ({ status: "no_change", reason: "tasks_not_all_terminal" }),

    emitAuditEvent: async () => {},

    ...overrides,

  };

  return { deps, calls };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. round-trip: sourceReferent unchanged -> Approval Integrity一致、実行される ----
  {
    const { deps, calls } = makeDeps(makeApproval());
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 1. sourceReferentが変わっていない場合、Approval Integrityは一致し実行される",
        outcome.status === "completed" && calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- 2. target substitution: sourceMessageRef改ざん -> fail closed、実行されない ----
  {
    const tampered = makeApproval({}, { ...SOURCE_REFERENT, sourceMessageRef: "m-b" });
    const { deps, calls } = makeDeps(tampered);
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 2. sourceMessageRef改ざん(A→B)はapproval_integrity_failedとなり、Provider実行は一切呼ばれない",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- 3. threadRef改ざん ----
  {
    const tampered = makeApproval({}, { ...SOURCE_REFERENT, threadRef: "t-b" });
    const { deps, calls } = makeDeps(tampered);
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 3. threadRef改ざんはapproval_integrity_failedとなり、Provider実行は呼ばれない",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- 4. sender改ざん ----
  {
    const tampered = makeApproval({}, { ...SOURCE_REFERENT, sender: "attacker@example.com" });
    const { deps, calls } = makeDeps(tampered);
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 4. sender改ざんはapproval_integrity_failedとなり、Provider実行は呼ばれない",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- 5. normalizedSubject改ざん ----
  {
    const tampered = makeApproval({}, { ...SOURCE_REFERENT, normalizedSubject: "別件について" });
    const { deps, calls } = makeDeps(tampered);
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 5. normalizedSubject改ざんはapproval_integrity_failedとなり、Provider実行は呼ばれない",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- 6. Action(recipient/subject/body)改ざん — 既存保護が引き続き機能する ----
  {
    const approval = makeApproval({
      payload: {
        action: {
          kind: "external_message",
          summary: "メール返信を送信",
          metadata: {
            service: "gmail",
            operation: "send_message",
            input: { ...GMAIL_INPUT, to: ["attacker@example.com"] }, // 改ざん
            connectionId: "conn-1",
            sourceReferent: SOURCE_REFERENT,
          },
        },
      },
    });
    const { deps, calls } = makeDeps(approval);
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 6. sourceReferentが一致していても、recipient(to)改ざんは既存のAction Integrityによりapproval_integrity_failedになる(referent保護追加で既存保護が弱まっていない)",
        outcome.status === "approval_integrity_failed" && calls.executeIntegrationActionCalls === 0
      )
    );
  }

  // ---- 7. V1(sourceReferent無し)Approvalは引き続き実行できる ----
  {
    const v1Approval = makeApproval({}, null, null);
    const { deps, calls } = makeDeps(v1Approval);
    const outcome = await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 7. sourceReferentを一切持たないV1 Approvalは、これまで通り実行できる(後方互換性)",
        outcome.status === "completed" && calls.executeIntegrationActionCalls === 1
      )
    );
  }

  // ---- 8. Provider leak prevention: executeIntegrationActionへ渡される
  // request.actionにsourceReferentが一切現れない。実mapGmailActionToComposioTool()
  // へ通しても、清潔なProvider引数だけが得られる。 ----
  {
    const { deps, calls } = makeDeps(makeApproval());
    await executeApprovedIntegrationAction("work-1", OWNER_USER_ID, "token", "approval-1", deps);

    const passedAction = calls.lastExecuteIntegrationActionRequest?.action;
    const serialized = JSON.stringify(passedAction);

    const mapped = passedAction ? mapGmailActionToComposioTool(passedAction as never) : undefined;

    results.push(
      check(
        "[REF-P1e sourceReferentExecution] 8. Providerへ渡されるaction自体にsourceReferentというkeyが一切現れず(型構造で保証)、実mapGmailActionToComposioTool()も正常にProvider引数のみを生成する(sourceReferentが混入していればこのmapperはallowlist違反でreject するはずだが、そもそもaction.inputにsourceReferentが存在しないため混入しようがない)",
        passedAction !== undefined &&
          !("sourceReferent" in passedAction) &&
          !serialized.includes("sourceReferent") &&
          !serialized.includes("m-a") &&
          mapped?.ok === true
      )
    );
  }

  return summarize("integration/sourceReferentExecution", results);

}
