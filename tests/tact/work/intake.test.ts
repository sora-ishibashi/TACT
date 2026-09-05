// =========================
// TACT Work — Work Intake Regression (Architecture Migration Phase B2)
// =========================
//
// 対象: core/tact-work/intake.tsのresolveWork()。実Supabaseには
// 一切接続しない(ResolveWorkDeps経由でgetWork/createWorkを偽実装に
// 差し替える、core/tact-bot/connector/conversationConnector.tsと
// 同じDIテスト手法)。LLM/Search API呼び出みは一切発生しない。

import { resolveWork, type ResolveWorkDeps, type WorkIntakeRequest } from "../../../core/tact-work/intake";
import type { Work } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-existing",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const baseRequest: WorkIntakeRequest = {
  userId: "user-1",
  requestedByActor: { kind: "user", id: "user-1" },
  content: "SROIについて調べて",
  source: "web",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- existingWorkIdが無い場合、新規Workを作成する
  // (conversationId無しでもWorkが作れることの確認、絶対条件) ----
  {
    let createWorkCalled = false;
    let capturedPrimaryConversationId: string | null | undefined = "not-called";

    const deps: ResolveWorkDeps = {
      getWork: async () => {
        throw new Error("existingWorkId未指定のためgetWork()は呼ばれないはず");
      },
      createWork: async (params) => {
        createWorkCalled = true;
        capturedPrimaryConversationId = params.primaryConversationId;
        return makeWork({ id: "work-new", primaryConversationId: params.primaryConversationId ?? null });
      },
    };

    const work = await resolveWork(
      { ...baseRequest, conversationId: null },
      "fake-token",
      deps
    );

    results.push(
      check(
        "[conversationId無し] conversationId未指定でもWorkが作れる(絶対条件: Conversation無しでWorkを作れない設計を禁止)",
        createWorkCalled && work.id === "work-new" && capturedPrimaryConversationId === null
      )
    );
  }

  // ---- existingWorkIdが指定され、本人所有として解決できる場合は
  // そのWorkを再利用する(Web/Bot問わず「既存Conversation Work link
  // があれば再利用される」の core) ----
  {
    let createWorkCalled = false;

    const deps: ResolveWorkDeps = {
      getWork: async (workId, userId) => {
        return workId === "work-existing" && userId === "user-1"
          ? makeWork()
          : undefined;
      },
      createWork: async () => {
        createWorkCalled = true;
        throw new Error("既存Workが再利用されるはずなのでcreateWork()は呼ばれないはず");
      },
    };

    const work = await resolveWork(
      { ...baseRequest, conversationId: "conv-1", existingWorkId: "work-existing" },
      "fake-token",
      deps
    );

    results.push(
      check(
        "[既存link再利用] 本人所有のexistingWorkIdはそのまま再利用され、新規作成されない",
        work.id === "work-existing" && createWorkCalled === false
      )
    );
  }

  // ---- existingWorkIdが他user所有(getWork()が解決できない)の場合、
  // そのWorkは再利用されず新規Workを作成する(絶対条件: 他user Work
  // linkは再利用されない・stale/wrong linkでcross-user execution不可) ----
  {
    const state = { createWorkCalled: false };

    const deps: ResolveWorkDeps = {
      // 「存在しない」と「他user所有」を区別しない既定挙動
      // (core/tact-work/store.tsのgetWork()と同じ規約)。
      getWork: async () => undefined,
      createWork: async (params) => {
        state.createWorkCalled = true;
        return makeWork({ id: "work-fresh", userId: params.userId });
      },
    };

    const work = await resolveWork(
      { ...baseRequest, conversationId: "conv-1", existingWorkId: "stale-or-other-user-work" },
      "fake-token",
      deps
    );

    results.push(
      check(
        "[stale/他user link] 解決できないexistingWorkIdは再利用されず、新規Workへフォールバックする",
        state.createWorkCalled &&
          work.id === "work-fresh" &&
          ("stale-or-other-user-work" as string) !== work.id
      )
    );
  }

  // ---- 新規作成時、requestedByActor/source/conversationIdが
  // createWork()へ正しく渡る ----
  {
    let capturedParams: Parameters<ResolveWorkDeps["createWork"]>[0] | undefined;

    const deps: ResolveWorkDeps = {
      getWork: async () => undefined,
      createWork: async (params) => {
        capturedParams = params;
        return makeWork({ id: "work-new-2" });
      },
    };

    await resolveWork(
      {
        userId: "user-1",
        requestedByActor: { kind: "user", id: "user-1" },
        content: "とても長い依頼文".repeat(20),
        source: "bot",
        conversationId: "conv-2",
      },
      "fake-token",
      deps
    );

    results.push(
      check(
        "[新規作成time] userId/createdByActorKind/createdByActorId/primaryConversationIdが正しく渡る",
        capturedParams?.userId === "user-1" &&
          capturedParams?.createdByActorKind === "user" &&
          capturedParams?.createdByActorId === "user-1" &&
          capturedParams?.primaryConversationId === "conv-2"
      )
    );

    results.push(
      check(
        "[新規作成time] metadata.sourceにWorkIntakeRequest.sourceが記録される(Bot経由の観測用タグ)",
        (capturedParams?.metadata as { source?: string } | null | undefined)?.source === "bot"
      )
    );

    results.push(
      check(
        "[新規作成time] titleは長い本文を切り詰めて設定される(60文字+...)",
        typeof capturedParams?.title === "string" &&
          capturedParams.title.length <= 63 &&
          capturedParams.title.endsWith("...")
      )
    );
  }

  return summarize("work/intake", results);

}
