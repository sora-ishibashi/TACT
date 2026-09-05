// =========================
// Conversation → Work Link Repair Regression
// (Phase B2 Final Fix)
// =========================
//
// 対象:
//   - core/tact-conversation/orchestration.tsのshouldRepairConversationWorkLink()
//     (純粋関数、DBアクセスなし)
//   - 同ファイルのresolveAndRunWork()(実Supabase・実Orchestratorには
//     一切接続しない。ResolveAndRunWorkDeps経由でresolveWork()/
//     linkConversationWork()/runWorkTurn()を偽実装に差し替える、
//     core/tact-work/{intake,execution}.test.tsと同じDIテスト手法)。
//
// 修正前の不具合: conversation.workIdが既に設定されている(=nullでは
// ない)場合、そのWorkがstale(存在しない)・foreign(他user所有)で
// あってもConversation側のlinkは書き戻されず、次のTurnも同じ無効な
// linkを読み続けてしまっていた。本testはこれが再発しないことを
// 確認する。

import {
  shouldRepairConversationWorkLink,
  resolveAndRunWork,
  type ResolveAndRunWorkDeps,
} from "../../../core/tact-conversation/orchestration";
import type { Conversation } from "../../../core/tact-conversation/types";
import type { Work } from "../../../core/tact-work/types";
import type { OrchestrationResult, OrchestrationRequest } from "../../../core/tact-orchestrator";
import { check, summarize, type CheckResult } from "../lib/check";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    userId: "user-1",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
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
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function makeOrchestrationResult(): OrchestrationResult {
  return {
    answer: "回答",
    executionId: "exec-1",
    tasks: [],
    memoryUsed: [],
    toolsUsed: [],
    memoryWrites: [],
    learningSignals: [],
    metadata: { executionMode: "single-execution" },
  };
}

const baseOrchestrationRequest: OrchestrationRequest = { input: "テスト依頼" };

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // 純粋関数: shouldRepairConversationWorkLink()
  // =========================

  results.push(
    check(
      "[Pure] currentWorkId未設定(undefined) -> 常にrepair対象(true)",
      shouldRepairConversationWorkLink(undefined, "work-1") === true
    )
  );

  results.push(
    check(
      "[Pure] currentWorkId=null -> repair対象(true)",
      shouldRepairConversationWorkLink(null, "work-1") === true
    )
  );

  results.push(
    check(
      "[Pure] currentWorkIdとresolvedWorkIdが一致 -> repair不要(false)",
      shouldRepairConversationWorkLink("work-1", "work-1") === false
    )
  );

  results.push(
    check(
      "[Pure] currentWorkIdとresolvedWorkIdが不一致(stale/foreign経由の新規作成) -> repair対象(true)",
      shouldRepairConversationWorkLink("work-stale-or-foreign", "work-new") === true
    )
  );

  // =========================
  // resolveAndRunWork(): DI経由のケース網羅
  // =========================

  // ---- Case 1: no work link -> new Work作成 -> Conversation linked ----
  {
    const conversation = makeConversation({ workId: null });
    let resolveWorkCalledWithExistingWorkId: string | null | undefined = "not-called";
    let linkedWorkId: string | undefined;

    const deps: ResolveAndRunWorkDeps = {
      resolveWork: async (request) => {
        resolveWorkCalledWithExistingWorkId = request.existingWorkId;
        return makeWork({ id: "work-new" });
      },
      linkConversationWork: async (_conversation, _accessToken, workId) => {
        linkedWorkId = workId;
      },
      runWorkTurn: async () => makeOrchestrationResult(),
    };

    await resolveAndRunWork(conversation, "fake-token", baseOrchestrationRequest, "依頼", "web", deps);

    results.push(
      check(
        "[Case1] link無し -> resolveWork()はexistingWorkId=nullで呼ばれ、新規Workがlinkされ、conversation.workIdも更新される",
        resolveWorkCalledWithExistingWorkId === null &&
          linkedWorkId === "work-new" &&
          conversation.workId === "work-new"
      )
    );
  }

  // ---- Case 2: valid same-user work link -> 再利用、new Work作成なし、linkも変更なし ----
  {
    const conversation = makeConversation({ workId: "work-existing" });
    let linkCalled = false;

    const deps: ResolveAndRunWorkDeps = {
      resolveWork: async () => makeWork({ id: "work-existing" }),
      linkConversationWork: async () => {
        linkCalled = true;
      },
      runWorkTurn: async () => makeOrchestrationResult(),
    };

    await resolveAndRunWork(conversation, "fake-token", baseOrchestrationRequest, "依頼", "web", deps);

    results.push(
      check(
        "[Case2] 有効な自分のWorkへのlink -> 同じWorkを再利用し、linkConversationWork()は呼ばれない(無駄なUPDATEをしない)",
        linkCalled === false && conversation.workId === "work-existing"
      )
    );
  }

  // ---- Case 3: stale/nonexistent work link -> new Work作成 -> Conversation link repaired ----
  {
    const conversation = makeConversation({ workId: "work-stale" });
    let linkedWorkId: string | undefined;

    const deps: ResolveAndRunWorkDeps = {
      // resolveWork()自体(実装)は「存在しない/所有者不一致のWorkは
      // 再利用せず新規作成する」——ここではその結果だけを模する。
      resolveWork: async () => makeWork({ id: "work-repaired" }),
      linkConversationWork: async (_conversation, _accessToken, workId) => {
        linkedWorkId = workId;
      },
      runWorkTurn: async () => makeOrchestrationResult(),
    };

    await resolveAndRunWork(conversation, "fake-token", baseOrchestrationRequest, "依頼", "web", deps);

    results.push(
      check(
        "[Case3] staleなlink -> 新しいWorkへrepairされ、conversation.workIdもwork-stale以外に更新される",
        linkedWorkId === "work-repaired" &&
          conversation.workId === "work-repaired" &&
          (conversation.workId as string) !== "work-stale"
      )
    );
  }

  // ---- Case 4: foreign-user work link -> foreign Work再利用せず、
  // current userのWorkを新規作成 -> Conversation link repaired ----
  {
    const conversation = makeConversation({ userId: "user-1", workId: "work-foreign" });
    let linkedWorkId: string | undefined;
    let linkCalledForConversationId: string | undefined;

    const deps: ResolveAndRunWorkDeps = {
      // 他user所有のWorkは再利用できないため、resolveWork()は
      // (実装同様)current user所有の新規Workを返す。
      resolveWork: async (request) => {
        return makeWork({ id: "work-new-for-user-1", userId: request.userId });
      },
      linkConversationWork: async (conversation, _accessToken, workId) => {
        linkedWorkId = workId;
        linkCalledForConversationId = conversation.id;
      },
      runWorkTurn: async () => makeOrchestrationResult(),
    };

    await resolveAndRunWork(conversation, "fake-token", baseOrchestrationRequest, "依頼", "web", deps);

    results.push(
      check(
        "[Case4] foreignなWork link -> foreign Workは再利用されず、user-1所有の新規Workが作られる",
        linkedWorkId === "work-new-for-user-1" && (linkedWorkId as string) !== "work-foreign"
      )
    );

    results.push(
      check(
        "[Case4] repairはconversation自身(current userのConversation)に対してのみ行われる",
        linkCalledForConversationId === conversation.id &&
          conversation.workId === "work-new-for-user-1"
      )
    );
  }

  // ---- Case 5: repaired Conversationの次Turn -> repaired Workを
  // reuse、さらにnew Workを作らない ----
  {
    // Case3のconversationをそのまま「次のTurn」に見立てる
    // (in-memoryのconversation.workIdが既にrepair済みの値へ更新済み、
    // 実運用では次TurnはDBから再取得したConversationがこの値を持つ)。
    const conversation = makeConversation({ workId: "work-repaired" });

    let resolveWorkCalledWithExistingWorkId: string | null | undefined;
    let createWorkAttempted = false;
    let linkCalled = false;

    const deps: ResolveAndRunWorkDeps = {
      resolveWork: async (request) => {
        resolveWorkCalledWithExistingWorkId = request.existingWorkId;
        if (request.existingWorkId === "work-repaired") {
          return makeWork({ id: "work-repaired" });
        }
        createWorkAttempted = true;
        return makeWork({ id: "work-unexpected-new" });
      },
      linkConversationWork: async () => {
        linkCalled = true;
      },
      runWorkTurn: async () => makeOrchestrationResult(),
    };

    await resolveAndRunWork(conversation, "fake-token", baseOrchestrationRequest, "次の依頼", "web", deps);

    results.push(
      check(
        "[Case5] repair済みのConversationは次Turnでrepaired Workをそのまま再利用し、新しいWorkを作らない",
        resolveWorkCalledWithExistingWorkId === "work-repaired" &&
          createWorkAttempted === false &&
          linkCalled === false &&
          conversation.workId === "work-repaired"
      )
    );
  }

  return summarize("conversation/workLinkRepair", results);

}
