// =========================
// TACT Work — Delegated Work Completion Ownership Regression
// (Architecture audit finding F-02: GMAIL-P1 Completion Ownership Audit fix)
// =========================
//
// 対象: core/tact-work/completion.tsのreconcileWorkCompletionStatus()と
// core/tact-work/delegatedCompletion.tsのfinalizeSemanticWorkAfterProtectedWrite()
// が、実際に協調して動くことを確認する統合的なregression suite
// (tests/tact/work/completion.test.ts・tests/tact/work/delegatedWork.test.ts
// は個々の関数を単体で検証しているのに対し、ここでは「classic Task-count
// reconcileが2回呼ばれても、durable semantic delivery markerが立つまでは
// Workがcompletedへ進まない」という、監査で確認された不変条件そのものを
// 直接再現する)。実Supabaseには一切接続しない——in-memory fake store
// (makeFakeWorkStore())経由でgetWork/listTasksForWork/listApprovalsForWork/
// updateWorkStatus/markWorkResultDeliveredを差し替える。

import {
  reconcileWorkCompletionStatus,
  type ReconcileWorkCompletionStatusDeps,
} from "../../../core/tact-work/completion";
import {
  finalizeSemanticWorkAfterProtectedWrite,
  type FinalizeSemanticWorkAfterProtectedWriteDeps,
} from "../../../core/tact-work/delegatedCompletion";
import type { Approval, Work, WorkTask } from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    workId: "work-1",
    description: "テスト",
    status: "pending",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

// 1つのWorkの状態(status/resultDeliveredAt)・Task一覧・Approval一覧を
// in-memoryで保持する最小限のfake store。reconcileWorkCompletionStatus()
// とfinalizeSemanticWorkAfterProtectedWrite()の両方が「同じdurable state」
// を見ていることを確認するため、両方のDepsをこの同じstateから作る。
function makeFakeWorkStore(initialWork: Work, tasks: WorkTask[], approvals: Approval[] = []) {

  let work: Work = { ...initialWork };
  const updateWorkStatusCalls: string[] = [];
  const markWorkResultDeliveredCalls: number[] = [];

  const completionDeps: ReconcileWorkCompletionStatusDeps = {

    listTasksForWork: async () => tasks,

    listApprovalsForWork: async () => approvals,

    updateWorkStatus: async (_workId, _userId, _accessToken, status) => {
      updateWorkStatusCalls.push(status);
      work = { ...work, status };
    },

    getWork: async () => work,

  };

  const finalizeDeps: FinalizeSemanticWorkAfterProtectedWriteDeps = {

    getWork: async () => work,

    markWorkResultDelivered: async () => {
      markWorkResultDeliveredCalls.push(1);
      if (!work.resultDeliveredAt) {
        work = { ...work, resultDeliveredAt: "2026-09-12T00:05:00.000Z" };
      }
    },

    reconcileWorkCompletionStatus: (workId, userId, accessToken) =>
      reconcileWorkCompletionStatus(workId, userId, accessToken, completionDeps),

  };

  return {
    completionDeps,
    finalizeDeps,
    getCurrentWork: () => work,
    updateWorkStatusCalls,
    markWorkResultDeliveredCalls,
  };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // ORDERING TEST(central regression、監査指示のCentral test)
  // =========================
  //
  // Gmail send Run/Task completed -> classic Task-count reconcileだけでは
  // Workはcompletedへ進まない -> 最終durable deliveryが記録された後に
  // 初めてcompletedへ進む、という正確な順序を1つのtest caseで直接証明する。
  {
    const semanticActWork = makeWork({ requestType: "act", resultDeliveredAt: null });

    // 初期状態: 読み取りTaskは既に完了、send Taskもたった今completedに
    // なった(Approval経由の送信成功直後)、他に未解決Approvalは無い。
    const store = makeFakeWorkStore(
      semanticActWork,
      [
        makeTask({ id: "task-read-notion", status: "completed" }),
        makeTask({ id: "task-read-gmail", status: "completed" }),
        makeTask({ id: "task-send", status: "completed", assignedCapability: "integration.gmail.send_message" }),
      ],
      [{ id: "approval-1", workId: "work-1", taskId: "task-send", requestedByActorKind: "ai", requestedByActorId: "gmail-work", requestedFromActorKind: "user", requestedFromActorId: "user-1", status: "approved", reason: "test", payload: {}, requestedAt: "2026-09-12T00:00:00.000Z", createdAt: "2026-09-12T00:00:00.000Z" }]
    );

    // Step1: これはexecuteApprovedIntegrationAction()内部の
    // reconcileAfterTaskUpdate()が、send Task completed直後に呼ぶのと
    // 全く同じ呼び出し(BEFORE durable final delivery)。
    const beforeDelivery = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[ORDERING] BEFORE durable final delivery: send Task completedでもWork.status !== \"completed\"(awaiting_semantic_delivery)",
        beforeDelivery.status === "no_change" &&
          beforeDelivery.reason === "awaiting_semantic_delivery" &&
          store.getCurrentWork().status === "running" &&
          store.updateWorkStatusCalls.length === 0
      )
    );

    // Step2: Approval-resume boundary(core/tact-bot/execution/
    // trustedApprovalDecision.ts)が、write_executed+completedの直後に
    // 呼ぶのと全く同じ呼び出し。
    await finalizeSemanticWorkAfterProtectedWrite("work-1", "user-1", "token", store.finalizeDeps);

    results.push(
      check(
        "[ORDERING] AFTER durable final delivery: finalizeSemanticWorkAfterProtectedWrite()がresultDeliveredAtを設定し、Work.status === \"completed\"になる",
        store.getCurrentWork().resultDeliveredAt != null &&
          store.getCurrentWork().status === "completed" &&
          store.markWorkResultDeliveredCalls.length === 1 &&
          store.updateWorkStatusCalls.join(",") === "completed"
      )
    );
  }

  // ---- [3] delegated act Work、Approval pending中 -> Work.status !== completed ----
  {
    const semanticActWork = makeWork({ requestType: "act", status: "waiting_for_approval", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [
        makeTask({ id: "task-read", status: "completed" }),
        makeTask({ id: "task-send", status: "pending" }),
      ],
      [{ id: "approval-1", workId: "work-1", taskId: "task-send", requestedByActorKind: "ai", requestedByActorId: "gmail-work", requestedFromActorKind: "user", requestedFromActorId: "user-1", status: "pending", reason: "test", payload: {}, requestedAt: "2026-09-12T00:00:00.000Z", createdAt: "2026-09-12T00:00:00.000Z" }]
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[3] delegated act Work、Approval pending中(send Taskもpending) -> Workはcompletedにならない",
        outcome.status === "no_change" &&
          outcome.reason === "tasks_not_all_terminal" &&
          store.getCurrentWork().status === "waiting_for_approval"
      )
    );
  }

  // ---- [4] Approval approved単独 -> Workはcompletedにならない
  // (approveApproval()自身は"running"しか書かない、既存core/tact-work/
  // approval.tsの既存contract。ここではfinalizeSemanticWorkAfterProtected
  // Write()を一切呼ばないシナリオそのものがこの不変条件の直接証拠になる) ----
  {
    const semanticActWork = makeWork({ requestType: "act", status: "running", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [
        makeTask({ id: "task-read", status: "completed" }),
        makeTask({ id: "task-send", status: "pending" }),
      ],
      [] // Approval承認直後、まだ再解決していないためpendingは残っていない設定
    );

    // Approval承認直後、まだRunは開始していない(send Taskはpendingのまま)。
    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[4] Approval approved直後(send Taskはまだpending)だけではWorkはcompletedにならない",
        outcome.status === "no_change" &&
          outcome.reason === "tasks_not_all_terminal" &&
          store.getCurrentWork().status === "running"
      )
    );
  }

  // ---- [5]/[6] Gmail send Run/Task completed -> Workはまだcompletedに
  // ならない(すでにORDERING TESTのStep1と同じ内容だが、監査の個別項目
  // としても明示的にラベルする) ----
  {
    const semanticActWork = makeWork({ requestType: "act", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [makeTask({ id: "task-send", status: "completed" })],
      []
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[5][6] Gmail send Run/Task completed(delivery未記録) -> Workはまだcompletedにならない",
        outcome.status === "no_change" &&
          outcome.reason === "awaiting_semantic_delivery" &&
          store.getCurrentWork().status !== "completed"
      )
    );
  }

  // ---- [7] successful external send + 最終durable deliveryが無い ->
  // Workはcompletedにならない(finalizeSemanticWorkAfterProtectedWrite()
  // 自体を呼ばないシナリオ) ----
  {
    const semanticActWork = makeWork({ requestType: "act", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [makeTask({ id: "task-send", status: "completed" })],
      []
    );

    // finalizeSemanticWorkAfterProtectedWrite()を意図的に呼ばない
    // (何らかの理由でtrustedApprovalDecision.ts側の呼び出しに到達
    // しなかったケースの直接再現)。
    await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[7] successful send + 最終durable deliveryが無い -> Workはcompletedにならない",
        store.getCurrentWork().status !== "completed" && store.getCurrentWork().resultDeliveredAt == null
      )
    );
  }

  // ---- [8] successful send + 最終結果がdurablyに記録された -> Work completed ----
  {
    const semanticActWork = makeWork({ requestType: "act", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [makeTask({ id: "task-send", status: "completed" })],
      []
    );

    await finalizeSemanticWorkAfterProtectedWrite("work-1", "user-1", "token", store.finalizeDeps);

    results.push(
      check(
        "[8] successful send + 最終結果がdurablyに記録された -> Work completed",
        store.getCurrentWork().status === "completed" && store.getCurrentWork().resultDeliveredAt != null
      )
    );
  }

  // ---- [9]/[10] semantic Workがresumeされても、routingは durable
  // Work.requestType(現在のturnがResolvedWorkIntentを再構築したか否か
  // ではない)から判断される、という直接証拠。ここではcurrent-turnの
  // ResolvedWorkIntentという概念自体が一切存在しない(paramsに含まれ
  // ない)まま、Work自身の永続列だけでsemantic completionへ正しく
  // ルーティングされることを示す。 ----
  {
    const semanticInspectWork = makeWork({ requestType: "inspect", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticInspectWork,
      [makeTask({ id: "task-read", status: "completed" })],
      []
    );

    // reconcileWorkCompletionStatus()の呼び出し引数はworkId/userId/
    // accessTokenのみ——ResolvedWorkIntentという値はこの関数のシグネチャ
    // 自体に存在しない。durable Work.requestTypeだけが判断材料である
    // ことの構造的な証拠。
    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[9][10] routingはcurrent-turnのResolvedWorkIntent(この関数の引数に存在しない)ではなく、durable Work.requestTypeから決まる -> semantic completionへ正しく倒れ、classicのTask-countだけでcompletedにしない",
        outcome.status === "no_change" && outcome.reason === "awaiting_semantic_delivery"
      )
    );
  }

  // ---- [11] classic(非semantic)Work -> 従来通りclassic reconcilerが
  // Task terminal化だけでcompletedへ確定する(回帰なし) ----
  {
    const classicWork = makeWork(); // requestType未設定

    const store = makeFakeWorkStore(
      classicWork,
      [makeTask({ id: "task-1", status: "completed" })],
      []
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[11] classic Work(requestType未設定)はTask terminal化だけで即座にcompletedへ確定する(挙動変更なし)",
        outcome.status === "reconciled" &&
          outcome.workStatus === "completed" &&
          store.getCurrentWork().status === "completed"
      )
    );
  }

  // ---- [12] Approval rejected -> false successful completionにならない
  // (rejectApproval()自身がWork/Taskを直接failedへ書く既存経路であり、
  // reconcileWorkCompletionStatus()を経由しない。ここではその後に
  // reconcileが呼ばれても"failed"のまま動かないことを確認する) ----
  {
    const semanticActWork = makeWork({ requestType: "act", status: "failed", failedAt: "2026-09-12T00:01:00.000Z", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [makeTask({ id: "task-send", status: "failed" })],
      []
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[12] Approval rejected相当(send Task failed) -> reconcileが呼ばれてもfailedのまま、completedへは絶対にならない",
        outcome.status === "reconciled" &&
          outcome.workStatus === "failed" &&
          store.getCurrentWork().status === "failed"
      )
    );
  }

  // ---- [13] provider definite failure -> false successful completionに
  // ならない(resultDeliveredAt未設定でも即座にfailedへ確定する、
  // completion.test.tsの直接反復だがF-02文脈でも明示する) ----
  {
    const semanticActWork = makeWork({ requestType: "act", resultDeliveredAt: null });

    const store = makeFakeWorkStore(
      semanticActWork,
      [
        makeTask({ id: "task-read", status: "completed" }),
        makeTask({ id: "task-send", status: "failed" }),
      ],
      []
    );

    const outcome = await reconcileWorkCompletionStatus("work-1", "user-1", "token", store.completionDeps);

    results.push(
      check(
        "[13] provider definite failure -> resultDeliveredAt未設定でも即座にfailedへ確定し、completedにはならない",
        outcome.status === "reconciled" &&
          outcome.workStatus === "failed" &&
          store.getCurrentWork().status === "failed"
      )
    );
  }

  // ---- [15] 生成された完了ロジック(reconcileWorkCompletionStatus本体・
  // finalizeSemanticWorkAfterProtectedWrite本体)のsource自体に、Gmail/
  // Composio/provider固有の分岐が一切無いことをsource-levelで確認する ----
  {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repoRoot = join(__dirname, "..", "..", "..");
    const completionSource = readFileSync(join(repoRoot, "core/tact-work/completion.ts"), "utf-8");
    const delegatedCompletionSource = readFileSync(join(repoRoot, "core/tact-work/delegatedCompletion.ts"), "utf-8");

    // 絶対条件が禁止しているのは「Composio/Provider実装固有の識別子・
    // Tool slug」であり、evaluateDelegatedWorkCompletion()が既に持つ
    // 既存の"gmail"/"notion"という値(core/tact-integration/types.tsの
    // 既存canonical IntegrationServiceそのもの、Composio固有の識別子
    // ではない)まで機械的に禁止するものではない——このrepository全体で
    // "gmail"/"notion"はcanonical service名として随所で使われている
    // (絶対条件Section10で明示された区別: business capability/canonical
    // service名 と provider action slugは別物)。そのためcomposio
    // (Composio SDK/Adapter実装への言及、このfileには一切存在しては
    // ならない唯一の語)だけを対象にする。
    results.push(
      check(
        "[15][18] 完了ロジック本体(completion.ts・delegatedCompletion.ts)はComposio実装への言及を一切持たない(provider-neutral、将来のOutlook send/Notion write/Calendar create/Teams post等でも変更不要)",
        !/composio/i.test(completionSource) && !/composio/i.test(delegatedCompletionSource)
      )
    );

    results.push(
      check(
        "[17] finalizeSemanticWorkAfterProtectedWrite()自体はGmail固有の分岐(例: if serviceが'gmail'なら...)を一切持たない——Work.requestTypeという既存canonical fieldだけで判定する",
        (() => {
          const marker = "export async function finalizeSemanticWorkAfterProtectedWrite";
          const start = delegatedCompletionSource.indexOf(marker);
          const body = start >= 0 ? delegatedCompletionSource.slice(start) : "";
          return start >= 0 && !/gmail|notion|slack|outlook|calendar|teams/i.test(body);
        })()
      )
    );
  }

  return summarize("work/completionOwnership", results);

}
