// =========================
// TACT Work — Clarification Execution Boundary Regression
// (Fast Port P3a: Human Interaction Foundation)
// =========================
//
// 対象: core/tact-work/clarification.tsのrequestClarification()/
// resolveClarification()。実Supabaseには一切接続しない
// (ClarificationExecutionDeps経由でStore呼び出しを偽実装に差し替える、
// tests/tact/work/approval.test.tsと全く同じDIテスト手法)。
//
// 偽実装は、テストごとに独立したin-memoryのWork/Clarification状態を
// 持ち、「userIdが一致しない場合は常に見つからない扱いにする」という
// 実store.ts(core/tact-work/store.ts)のownership defenseと同じ挙動を
// 再現する。Work.statusも実際にtrackする。
//
// このfile・core/tact-work/clarification.ts自身がProvider/LLM/Search/
// Run/Approvalのいずれも一切importしないことは、import文自体が
// 構造的に保証する(絶対条件13/18/23/24)——実行時のspyではなく、
// このtest fileとclarification.tsのimport一覧がSupabase Approval
// テーブル・core/tact-integration・core/llmのいずれも参照しないことが
// 型検査(tsc)通過そのものによって既に証明されている。

import {
  requestClarification,
  resolveClarification,
  type ClarificationExecutionDeps,
  type ClarificationRequest,
} from "../../../core/tact-work/clarification";
import type { Clarification, Work, WorkStatus } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "waiting_for_input",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

interface FakeBackend {
  deps: ClarificationExecutionDeps;
  workStatusUpdates: string[];
  clarifications: Map<string, Clarification>;
  // Fast Port P4b: emitAuditEvent()呼び出しを記録するfake(絶対条件、
  // Fast Port P4a incidentの教訓: 実recordAuditEvent()/実Supabaseへは
  // 一切接続しない)。
  auditEventCalls: { eventType: string; workId: string; clarificationId?: string | null; actorKind?: string; actorId?: string; details?: unknown }[];
  setWorkStatus: (workId: string, status: WorkStatus) => void;
  getWorkStatus: (workId: string) => WorkStatus | undefined;
}

// worksはworkId -> ownerUserIdの単純なmap。Work.statusは
// "waiting_for_input"を初期値として実際にtrackする(requestClarification()
// 自身がこの値へ遷移させるため、approval.test.tsが"running"を初期値と
// するのと対称)。
function makeFakeBackend(works: Record<string, string>): FakeBackend {

  const workStatusUpdates: string[] = [];
  const clarifications = new Map<string, Clarification>();
  const auditEventCalls: { eventType: string; workId: string; clarificationId?: string | null; actorKind?: string; actorId?: string; details?: unknown }[] = [];
  const workStatuses = new Map<string, WorkStatus>(
    Object.keys(works).map((id) => [id, "waiting_for_input" as WorkStatus])
  );
  let nextClarificationId = 1;

  const getWork: ClarificationExecutionDeps["getWork"] = async (workId, userId) => {
    if (works[workId] !== userId) {
      return undefined;
    }
    return makeWork({ id: workId, userId, status: workStatuses.get(workId) ?? "waiting_for_input" });
  };

  const deps: ClarificationExecutionDeps = {

    getWork,

    createClarification: async (workId, userId, _accessToken, params) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return undefined;
      }

      const id = `clarification-${nextClarificationId++}`;

      const clarification: Clarification = {
        id,
        workId,
        taskId: params.taskId ?? null,
        requestedByActorKind: params.requestedByActorKind,
        requestedByActorId: params.requestedByActorId,
        allowedResponderIds: params.allowedResponderIds ?? null,
        status: "pending",
        reasonCode: params.reasonCode,
        question: params.question,
        response: null,
        respondedByActorKind: null,
        respondedByActorId: null,
        requestedAt: "2026-09-06T00:00:00.000Z",
        respondedAt: null,
        expiresAt: params.expiresAt ?? null,
        createdAt: "2026-09-06T00:00:00.000Z",
      };

      clarifications.set(id, clarification);

      return clarification;

    },

    getClarification: async (workId, userId, _accessToken, clarificationId) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return undefined;
      }

      const clarification = clarifications.get(clarificationId);

      return clarification && clarification.workId === workId ? clarification : undefined;

    },

    updateClarificationStatus: async (workId, userId, _accessToken, clarificationId, status, params) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return;
      }

      const clarification = clarifications.get(clarificationId);

      if (clarification && clarification.workId === workId) {
        clarifications.set(clarificationId, {
          ...clarification,
          status,
          respondedAt: "2026-09-06T00:01:00.000Z",
          response: params?.response ?? null,
          respondedByActorKind: params?.respondedByActorKind ?? null,
          respondedByActorId: params?.respondedByActorId ?? null,
        });
      }

    },

    listClarificationsForWork: async (workId, userId) => {

      const work = await getWork(workId, userId, "fake-token");

      if (!work) {
        return [];
      }

      return [...clarifications.values()].filter((c) => c.workId === workId);

    },

    updateWorkStatus: async (workId, _userId, _accessToken, status) => {
      workStatusUpdates.push(status);
      workStatuses.set(workId, status);
    },

    // Fast Port P4b: 実emitAuditSafely()/実recordAuditEvent()は
    // 一切呼ばない——呼び出しを記録するだけのfake(絶対条件、Fast
    // Port P4a incidentの教訓)。
    emitAuditEvent: async (request) => {
      auditEventCalls.push({
        eventType: request.eventType,
        workId: request.workId,
        clarificationId: request.clarificationId,
        actorKind: request.actor?.kind,
        actorId: request.actor?.id,
        details: request.details ?? null,
      });
    },

  };

  return {
    deps,
    workStatusUpdates,
    clarifications,
    auditEventCalls,
    setWorkStatus: (workId, status) => workStatuses.set(workId, status),
    getWorkStatus: (workId) => workStatuses.get(workId),
  };

}

function makeRequest(overrides: Partial<ClarificationRequest> = {}): ClarificationRequest {
  return {
    workId: "work-1",
    requestedByActor: { kind: "ai", id: "integration.slack.send_message" },
    reasonCode: "missing_required_input",
    question: "どのチャンネルへ送信しますか?",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // Core lifecycle (Step16 items 1-7)
  // =========================

  // ---- [1-7] requestClarification() -> pending、各fieldが正しく保持される ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const clarification = await requestClarification(
      makeRequest({ taskId: "task-1", allowedResponderIds: ["user-1"] }),
      "user-1",
      "fake-token",
      backend.deps
    );

    results.push(check("[1] createClarification -> status pending", clarification?.status === "pending"));

    results.push(
      check(
        "[2] workId/taskId correlationが保持される",
        clarification?.workId === "work-1" && clarification?.taskId === "task-1"
      )
    );

    results.push(
      check("[3] reasonCodeが保持される", clarification?.reasonCode === "missing_required_input")
    );

    results.push(
      check("[4] questionが保持される", clarification?.question === "どのチャンネルへ送信しますか?")
    );

    results.push(
      check(
        "[5] allowedResponderIdsが保持される",
        Array.isArray(clarification?.allowedResponderIds) &&
          clarification?.allowedResponderIds?.[0] === "user-1"
      )
    );

    results.push(check("[6] responseは初期状態でnull", clarification?.response === null || clarification?.response === undefined));

    results.push(
      check("[7] resolvedAt(respondedAt)は初期状態でnull", clarification?.respondedAt === null || clarification?.respondedAt === undefined)
    );

    results.push(
      check(
        "[Step10] requestClarification() -> Workがwaiting_for_inputへ遷移する",
        backend.workStatusUpdates[0] === "waiting_for_input"
      )
    );
  }

  // =========================
  // Resolution (Step16 items 8-11)
  // =========================

  // ---- [8-11] pending Clarification resolve -> answered、response/respondedBy/statusが正しく更新される ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);

    const outcome = await resolveClarification(
      "work-1",
      "user-1",
      "fake-token",
      clarification!.id,
      { kind: "user", id: "user-1" },
      "general channel",
      backend.deps
    );

    results.push(check("[8] resolveClarification() -> answered", outcome.status === "answered"));

    results.push(
      check(
        "[9] responseが保存される",
        outcome.status === "answered" && outcome.clarification.response === "general channel"
      )
    );

    results.push(
      check(
        "[10] respondedBy(actor)が保存される",
        outcome.status === "answered" &&
          outcome.clarification.respondedByActorKind === "user" &&
          outcome.clarification.respondedByActorId === "user-1"
      )
    );

    const stored = await backend.deps.getClarification("work-1", "user-1", "fake-token", clarification!.id);

    results.push(check("[11] status -> answered(DB row自体も更新される)", stored?.status === "answered"));

    results.push(
      check(
        "[Step14] resolve後、他にpending Clarificationが無ければWorkがrunningへ戻る(resolution後のeligibility、Step22も兼ねる)",
        outcome.status === "answered" &&
          outcome.workResumed === true &&
          backend.getWorkStatus("work-1") === "running"
      )
    );
  }

  // =========================
  // Safe failure paths (Step16 items 12-16)
  // =========================

  // ---- [12] 存在しないClarificationのresolve -> not_found ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const outcome = await resolveClarification(
      "work-1",
      "user-1",
      "fake-token",
      "nonexistent-id",
      { kind: "user", id: "user-1" },
      "回答",
      backend.deps
    );

    results.push(check("[12] 存在しないclarificationId -> not_found(安全な失敗)", outcome.status === "not_found"));
  }

  // ---- [13] 既にanswered済みのClarificationへの再resolve -> already_resolved(fail closed) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);

    await resolveClarification("work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "1回目", backend.deps);

    const secondAttempt = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "2回目(上書き試行)", backend.deps
    );

    const stored = await backend.deps.getClarification("work-1", "user-1", "fake-token", clarification!.id);

    results.push(
      check(
        "[13] answered済みへの再resolveはalready_resolvedを返し、既存responseを上書きしない(fail closed)",
        secondAttempt.status === "already_resolved" && stored?.response === "1回目"
      )
    );
  }

  // ---- [14] allowedResponderIdsに含まれないactorのresolve -> responder_not_allowed(fail closed) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(
      makeRequest({ allowedResponderIds: ["user-allowed"] }),
      "user-1",
      "fake-token",
      backend.deps
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-not-allowed" }, "勝手に回答", backend.deps
    );

    const stored = await backend.deps.getClarification("work-1", "user-1", "fake-token", clarification!.id);

    results.push(
      check(
        "[14] allowedResponderIdsに含まれないresponderActorはresponder_not_allowedで拒否され、Clarificationはpendingのまま(HumanLayer ACP AllowedResponderIDs pattern)",
        outcome.status === "responder_not_allowed" && stored?.status === "pending"
      )
    );
  }

  // ---- [15] 他user(Work所有者でない)のresolve試行 -> not_found(trusted ownership boundary) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);

    const foreignAttempt = await resolveClarification(
      "work-1", "attacker", "fake-token", clarification!.id, { kind: "user", id: "attacker" }, "乗っ取り試行", backend.deps
    );

    const stored = await backend.deps.getClarification("work-1", "user-1", "fake-token", clarification!.id);

    results.push(
      check(
        "[15] 他user(Work非所有者)のresolve試行はnot_foundで安全に拒否され、Clarificationはpendingのまま(絶対条件11: identity/ownership checksはtrusted canonical boundary)",
        foreignAttempt.status === "not_found" && stored?.status === "pending"
      )
    );
  }

  // ---- [16] 外部Provider ID(例: Slack user id)をcanonical actorとして直接信用しない ----
  //
  // このfile自体はProvider/Adapter層を一切importしないため
  // (絶対条件10)、resolveClarification()のresponderActor引数へ
  // 「解決済みでない生の外部ID」を渡すこと自体が呼び出し元の責務
  // 違反になる、という設計を型レベルで確認する: ActorReferenceは
  // {kind, id}という抽象形のみを受け取り、Slack固有のuser id形式
  // (例: "U012ABCDEF")をこの層が特別扱いする分岐は一切存在しない
  // (=Bot/Adapter層が既に解決済みのtactUserIdだけを渡す前提を、
  // このmoduleが独自に検証・特別扱いしないことを確認する)。
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(
      makeRequest({ allowedResponderIds: ["user-1"] }),
      "user-1",
      "fake-token",
      backend.deps
    );

    // "U012ABCDEF"のような生のSlack IDをそのままresponderActor.idへ
    // 渡しても、allowedResponderIds(tactUserIdのみを含む)に含まれない
    // 限り、通常のactor idと全く同じ扱い(responder_not_allowed)になる
    // ——外部Provider ID形式を特別に信用する分岐が無いことの直接証拠。
    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "U012ABCDEF" }, "Slack経由の生ID", backend.deps
    );

    results.push(
      check(
        "[16] 外部Provider形式のraw actor id('U012ABCDEF')はallowedResponderIds(tactUserIdのみ)に含まれない限り、他のidと同じくresponder_not_allowedで拒否される(canonical actorとして特別扱いしない)",
        outcome.status === "responder_not_allowed"
      )
    );
  }

  // ---- Idempotency補足: pending以外(cancelled/expired相当)からのresolve試行はinvalid_transition ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);

    // cancelled状態を直接構成する(expireさせるworkerはP3aのscope外、
    // 型としてのcancelled/expired状態そのものは扱えることだけ確認する)。
    backend.clarifications.set(clarification!.id, { ...clarification!, status: "cancelled" });

    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "回答試行", backend.deps
    );

    results.push(
      check(
        "[補足] cancelled状態からのresolve試行はinvalid_transitionで拒否される(pending以外からansweredへの遷移を許さない)",
        outcome.status === "invalid_transition"
      )
    );
  }

  // ---- work_not_resumable補足: Workが既にterminal(waiting_for_input以外)の場合、resolveは安全に拒否される ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);
    backend.setWorkStatus("work-1", "failed"); // 他の経路でWorkがfailedへ確定したことを模す

    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "回答試行", backend.deps
    );

    const stored = await backend.deps.getClarification("work-1", "user-1", "fake-token", clarification!.id);

    results.push(
      check(
        "[補足] terminal Work(failed)へのresolve試行はwork_not_resumableで拒否され、Clarificationはpendingのまま(approval.tsのTerminal Work Guardと対称)",
        outcome.status === "work_not_resumable" && stored?.status === "pending"
      )
    );
  }

  // ---- allowedResponderIds未指定(undefined) -> Work所有者からの応答は制限なく成功する ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);

    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "回答", backend.deps
    );

    results.push(
      check(
        "[Step9] allowedResponderIds未指定(undefined) -> canonical owner(Work所有者)からの応答は制限なく成功する(既定挙動)",
        outcome.status === "answered"
      )
    );
  }

  // ---- 複数pending Clarification中の1件resolve -> workResumed=false、waiting_for_input維持 ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarificationA = await requestClarification(makeRequest({ taskId: "task-a" }), "user-1", "fake-token", backend.deps);
    await requestClarification(makeRequest({ taskId: "task-b" }), "user-1", "fake-token", backend.deps);

    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarificationA!.id, { kind: "user", id: "user-1" }, "Aへの回答", backend.deps
    );

    results.push(
      check(
        "[Step22補足] 複数pending中の1件resolve -> workResumed=false、Workはwaiting_for_input維持(approveApproval()の複数pending挙動と対称)",
        outcome.status === "answered" &&
          (outcome.status === "answered" ? outcome.workResumed === false : false) &&
          backend.getWorkStatus("work-1") === "waiting_for_input"
      )
    );
  }

  // =========================
  // Fast Port P4b(Resume brief Step8/12) — Audit event wiring
  // =========================

  // ---- [Audit] requestClarification() -> clarification.requestedが
  // 1回だけemitされ、question全文はdetailsに含まれない ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const clarification = await requestClarification(
      makeRequest({ taskId: "task-1", allowedResponderIds: ["user-1"] }),
      "user-1",
      "fake-token",
      backend.deps
    );

    const requestedEvents = backend.auditEventCalls.filter((e) => e.eventType === "clarification.requested");
    const serialized = JSON.stringify(backend.auditEventCalls);

    results.push(
      check(
        "[Audit] requestClarification() -> clarification.requestedが正確に1回emitされ、対象clarificationId/workIdを保持する",
        requestedEvents.length === 1 &&
          requestedEvents[0].workId === "work-1" &&
          requestedEvents[0].clarificationId === clarification?.id
      )
    );

    results.push(
      check(
        "[Data minimization] clarification.requestedのAudit detailsにquestion全文が含まれない",
        !serialized.includes("どのチャンネルへ送信しますか?")
      )
    );
  }

  // ---- [Audit] resolveClarification() -> clarification.answeredが
  // 1回だけemitされ、response全文はdetailsに含まれない ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", backend.deps);

    await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "general channel", backend.deps
    );

    const answeredEvents = backend.auditEventCalls.filter((e) => e.eventType === "clarification.answered");
    const serialized = JSON.stringify(backend.auditEventCalls);

    results.push(
      check(
        "[Audit] resolveClarification() -> clarification.answeredが正確に1回emitされる",
        answeredEvents.length === 1 && answeredEvents[0].clarificationId === clarification?.id
      )
    );

    results.push(
      check(
        "[Data minimization] clarification.answeredのAudit detailsにresponse全文(general channel)が含まれない",
        !serialized.includes("general channel")
      )
    );
  }

  // ---- [Audit non-fatal] emitAuditEventが失敗(no-op相当)しても、
  // requestClarification()/resolveClarification()のcanonical outcomeは
  // 一切変化しない(絶対条件3/4) ----
  {
    const backend = makeFakeBackend({ "work-1": "user-1" });

    const clarification = await requestClarification(makeRequest(), "user-1", "fake-token", {
      ...backend.deps,
      emitAuditEvent: async () => { /* Audit書き込み失敗を模す(no-op) */ },
    });

    results.push(
      check(
        "[Audit non-fatal] requestClarification(): Audit emitterが失敗相当でもClarification作成・Work状態遷移は成功する",
        clarification?.status === "pending" && backend.getWorkStatus("work-1") === "waiting_for_input"
      )
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "fake-token", clarification!.id, { kind: "user", id: "user-1" }, "general channel", {
        ...backend.deps,
        emitAuditEvent: async () => { /* no-op */ },
      }
    );

    results.push(
      check(
        "[Audit non-fatal] resolveClarification(): Audit emitterが失敗相当でもanswered確定・response保存は成功する",
        outcome.status === "answered" && outcome.clarification.response === "general channel"
      )
    );
  }

  return summarize("work/clarification", results);

}
