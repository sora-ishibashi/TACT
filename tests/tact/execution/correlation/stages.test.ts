// =========================
// TACT Canonical Execution — Correlation Stages Regression (SOR-52)
// =========================
//
// 対象: core/tact-execution/correlation/stages/配下の4段階
// (explicit/structural/temporalParticipant/aiAssisted)。実Supabase
// 接続は一切行わない(偽deps注入)。

import { runExplicitCorrelation } from "../../../../core/tact-execution/correlation/stages/explicit";
import { runStructuralCorrelation, type StructuralCorrelationDeps } from "../../../../core/tact-execution/correlation/stages/structural";
import {
  resolveTemporalParticipantCandidates,
  type TemporalParticipantCandidateDeps,
} from "../../../../core/tact-execution/correlation/stages/temporalParticipant";
import { runAiAssistedCorrelation } from "../../../../core/tact-execution/correlation/stages/aiAssisted";
import { resolveCorrelationContext } from "../../../../core/tact-execution/correlation/context";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import type { Work } from "../../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    schemaVersion: 1,
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
    connectionId: null,
    actorKind: "human",
    actorId: "U123",
    agentId: null,
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev1",
    adapterVersion: "v1",
    sourceMetadata: { teamId: "T1", channel: "C1", threadTs: "100.001" },
    rawPayloadRef: null,
    observationMode: null,
    preExecutionVisible: false,
    actionCategory: "create",
    operation: "app_mention",
    resourceType: "slack_message",
    resourceIdentifier: null,
    targetProvider: "slack",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    outcomeStatus: "unknown",
    outcomeKind: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T12:00:00.000Z",
    persistedAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =======================================================================
  // Stage1: Explicit
  // =======================================================================

  // ---- Test1: explicit workId -> matched ----
  {
    const decision = runExplicitCorrelation(makeExecution({ workId: "work-explicit-1" }));

    results.push(
      check(
        "[Test1] Executionが既にworkIdを持つ場合、method=explicit・confidence=1でmatchedを返す",
        decision?.status === "matched" && decision.workId === "work-explicit-1" && decision.method === "explicit" && decision.confidence === 1
      )
    );
  }

  {
    const decision = runExplicitCorrelation(makeExecution({ workId: null }));

    results.push(check("[Explicit/fallthrough] workId未設定はnull(次のstageへ委ねる)を返す", decision === null));
  }

  // =======================================================================
  // Stage2: Structural
  // =======================================================================

  // ---- Test12: Slack thread match(単一candidate) -> matched ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async (params) =>
        params.externalThreadId === "100.001" ? "conv-thread-1" : null,
      listWorksForConversation: async (conversationId) =>
        conversationId === "conv-thread-1" ? [makeWork({ id: "work-thread-1" })] : [],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(
      check(
        "[Test12/Slack thread match] thread単位のconversation linkが単一Workへ相関する場合matchedを返す",
        decision?.status === "matched" && decision.workId === "work-thread-1" && decision.reasonCode === "slack_thread_match"
      )
    );
  }

  // ---- Test11: Slack channel match(thread linkが無い場合のfallback) -> matched ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async (params) =>
        params.externalThreadId === undefined && params.externalConversationId === "C1" ? "conv-channel-1" : null,
      listWorksForConversation: async (conversationId) =>
        conversationId === "conv-channel-1" ? [makeWork({ id: "work-channel-1" })] : [],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeExecution({ sourceMetadata: { teamId: "T1", channel: "C1", threadTs: null } });
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(
      check(
        "[Test11/Slack channel match] thread指定が無くchannel単位のconversation linkから単一Workへ相関する場合matchedを返す",
        decision?.status === "matched" && decision.workId === "work-channel-1" && decision.reasonCode === "slack_channel_match"
      )
    );
  }

  // ---- Test4/Test9: multiple candidates -> ambiguous(順序保持) ----
  {
    const works = [makeWork({ id: "work-a" }), makeWork({ id: "work-b" })];

    const deps: StructuralCorrelationDeps = {
      findConversationLink: async () => "conv-multi-1",
      listWorksForConversation: async () => works,
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(
      check(
        "[Test4] 同じcontextに複数Workが紐付く場合、workIdをnullにしたままambiguousを返す(推測しない)",
        decision?.status === "ambiguous" && decision.workId === null
      )
    );

    results.push(
      check(
        "[Test9] candidateWorkIdsの順序はWork Resolverが返した順序をそのまま保持する(shuffleしない)",
        JSON.stringify(decision?.candidateWorkIds) === JSON.stringify(["work-a", "work-b"])
      )
    );
  }

  // ---- Test13: wrong Slack channel(conversation link自体が無い) -> null(unresolvedへ倒れる) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async () => null,
      listWorksForConversation: async () => [],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeExecution({ sourceMetadata: { teamId: "T1", channel: "C-unrelated", threadTs: null } });
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(check("[Test13] 一致するconversation linkが無い場合はnullを返す(誤ったWorkへ紐付けない)", decision === null));
  }

  // ---- Test5(tenant boundary): listWorksForConversationへ常にExecution本人のuserIdが渡る ----
  {
    let capturedUserId: string | undefined;

    const deps: StructuralCorrelationDeps = {
      findConversationLink: async () => "conv-tenant-1",
      listWorksForConversation: async (_conversationId, userId) => {
        capturedUserId = userId;
        return [makeWork({ id: "work-tenant-1", userId })];
      },
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };

    const execution = makeExecution({ userId: "user-tenant-42" });
    const context = resolveCorrelationContext(execution);
    await runStructuralCorrelation(execution, context, deps);

    results.push(check("[Test5/tenant boundary] Candidate ResolverへExecution本人のuserIdだけが渡り、他userのWorkへは到達しない", capturedUserId === "user-tenant-42"));
  }

  // ---- service role未設定 -> null(fail safe、次のstageへ) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async () => "conv-1",
      listWorksForConversation: async () => [makeWork()],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => null,
    };

    const execution = makeExecution();
    const context = resolveCorrelationContext(execution);
    const decision = await runStructuralCorrelation(execution, context, deps);

    results.push(check("[Structural/fail safe] service role未設定時はnullを返す(誤った確定をしない)", decision === null));
  }

  // ---- Workspace scope: identical Slack channel/thread identifiers may
  // exist in different workspaces, so teamId must participate in lookup. ----
  {
    const seenWorkspaceIds: string[] = [];
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async (params) => {
        seenWorkspaceIds.push(params.externalWorkspaceId ?? "");
        if (params.externalWorkspaceId === "T-alpha" && params.externalThreadId === "100.001") return "conv-alpha";
        if (params.externalWorkspaceId === "T-beta" && params.externalThreadId === "100.001") return "conv-beta";
        return null;
      },
      listWorksForConversation: async (conversationId) =>
        conversationId === "conv-alpha" ? [makeWork({ id: "work-alpha" })] :
          conversationId === "conv-beta" ? [makeWork({ id: "work-beta" })] : [],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };
    const makeWorkspaceExecution = (teamId: string) => makeExecution({ sourceMetadata: { teamId, channel: "C1", threadTs: "100.001" } });
    const alphaExecution = makeWorkspaceExecution("T-alpha");
    const betaExecution = makeWorkspaceExecution("T-beta");
    const wrongExecution = makeWorkspaceExecution("T-wrong");
    const alpha = await runStructuralCorrelation(alphaExecution, resolveCorrelationContext(alphaExecution), deps);
    const beta = await runStructuralCorrelation(betaExecution, resolveCorrelationContext(betaExecution), deps);
    const wrong = await runStructuralCorrelation(wrongExecution, resolveCorrelationContext(wrongExecution), deps);
    results.push(check(
      "[Slack workspace scope] identical channel/thread in distinct teamIds resolves only its own Work; an unknown team has no structural match",
      alpha?.workId === "work-alpha" && beta?.workId === "work-beta" && wrong === null &&
        seenWorkspaceIds.includes("T-alpha") && seenWorkspaceIds.includes("T-beta") && seenWorkspaceIds.includes("T-wrong")
    ));
  }

  // =======================================================================
  // Stage3: Temporal/Participant candidates
  // =======================================================================

  // ---- Test6: inactive/invalid Work(completed/failed/cancelled)は候補から除外される ----
  {
    const deps: TemporalParticipantCandidateDeps = {
      listRecentWorksForUser: async () => [
        makeWork({ id: "work-active-1", status: "running" }),
        makeWork({ id: "work-done-1", status: "completed" }),
        makeWork({ id: "work-failed-1", status: "failed" }),
        makeWork({ id: "work-cancelled-1", status: "cancelled" }),
      ],
      getServiceRoleKey: () => "service-role-key",
    };

    const context = resolveCorrelationContext(makeExecution());
    const candidates = await resolveTemporalParticipantCandidates(context, deps);

    results.push(
      check(
        "[Test6] completed/failed/cancelledのWorkは候補集合から除外される(active statusのみ残る)",
        candidates.length === 1 && candidates[0].id === "work-active-1"
      )
    );
  }

  // =======================================================================
  // Stage4: AI-assisted(deterministic stub)
  // =======================================================================

  {
    const decision = runAiAssistedCorrelation([], makeExecution());

    results.push(check("[AI-assisted] 候補0件はnullを返す(unresolvedへ倒す判断は呼び出し元)", decision === null));
  }

  // ---- Test13(SOR-52 Closeout Hardening Part5、最重要): recencyだけの
  // 単一候補は、どれだけ直近でもmatchedを返さない(auto match禁止) ----
  {
    const veryRecentWork = makeWork({ id: "work-very-recent-1", updatedAt: "2026-09-20T11:59:00.000Z" });
    const decision = runAiAssistedCorrelation([veryRecentWork], makeExecution({ observedAt: "2026-09-20T12:00:00.000Z" }));

    results.push(
      check(
        "[Test13] 直近性が極めて高い単一候補であってもmatchedを返さない(real semantic evidenceが無い限りrecencyだけでWork identityを確定しない)",
        decision === null
      )
    );
  }

  {
    const staleWork = makeWork({ id: "work-stale-1", updatedAt: "2026-09-01T00:00:00.000Z" });
    const decision = runAiAssistedCorrelation([staleWork], makeExecution({ observedAt: "2026-09-20T12:00:00.000Z" }));

    results.push(
      check(
        "[AI-assisted] 直近性が低い単一候補もnullを返す(unresolvedへ倒す)",
        decision === null
      )
    );
  }

  {
    const decision = runAiAssistedCorrelation(
      [makeWork({ id: "work-x" }), makeWork({ id: "work-y" })],
      makeExecution()
    );

    results.push(check("[Test14/AI-assisted/multiple] 複数候補は常にambiguous", decision?.status === "ambiguous" && decision.workId === null));
  }

  return summarize("TACT Canonical Execution — Correlation Stages", results);

}
