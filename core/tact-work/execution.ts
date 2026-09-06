import { runOrchestration as defaultRunOrchestration } from "../tact-orchestrator";
import type {
  OrchestrationRequest,
  OrchestrationResult,
  OrchestrationHooks,
  Task,
  TaskApprovalRequirement,
} from "../tact-orchestrator";
import {
  updateWorkStatus,
  createTask,
  createTaskDependency,
  updateTaskStatus,
  createRun,
  completeRun,
  failRun,
} from "./store";
import { requestApproval as defaultRequestApproval } from "./approval";
import { reconcileWorkCompletionStatus as defaultReconcileWorkCompletionStatus } from "./completion";
import type { Work } from "./types";

// =========================
// TACT Work — Work Execution Boundary (Architecture Migration Phase B2)
// =========================
//
// ARCH-R2 Section11の目標経路
// (... → Work → Work Execution Boundary → existing Orchestrator →
// Capability Registry → Capability)の「Work Execution Boundary」に
// 相当する。
//
// 責務(Phase B2指示Section5、最低限これだけ):
//   1. Work load/create(呼び出し元がresolveWork()で既に解決済みの
//      Workを受け取るだけ、ここでは行わない)
//   2. Work statusをplanning/runningへ遷移
//   3. 既存runOrchestration()を呼ぶ(core/tact-orchestrator、Phase A
//      で確立したCapability Invocation境界を含め一切書き換えない)
//   4. Orchestratorが生成したTaskをWork Taskとしてpersist
//   5. Capability executionをRunとしてpersist
//   6. 成功/失敗に応じてTask/Run/Work stateを更新
//   7. 呼び出し元(既存Conversation層)へOrchestrationResultをそのまま
//      返す——Response生成のSource of TruthはPhase B2でもまだ既存
//      Conversationのまま(絶対条件7: Execution lifecycleはWorkが
//      正式、Response compatibilityは既存Conversationを維持)。
//
// 絶対条件(Phase B2指示Section6): Orchestrator → Supabaseという
// 直接依存は作らない。core/tact-orchestrator/executor.ts・
// commander.tsは、このファイルの存在も、Supabaseの存在も一切知らない
// ——OrchestrationHooks(core/tact-orchestrator/types.ts、Phase B2で
// 追加した小さな観測用コールバック)を経由してこのファイルへ通知
// するだけであり、依存の向きはcore/tact-work → core/tact-orchestrator
// の一方向のまま(Phase Aで確立した既存の依存方向を踏襲)。
//
// テスト容易性のため、実際のStore呼び出し・runOrchestration()自体を
// Constructor/Parameter Injectionで差し替え可能にする(既定値は
// core/tact-work/store.tsの実関数・core/tact-orchestratorの実
// runOrchestration()。core/tact-bot/connector/conversationConnector.ts
// と同じDIパターン)。

// =========================
// resolveIntegrationConnection (Architecture Migration Phase C2.1b)
// =========================
//
// TACT Connection(core/tact-integration/connection.ts)は
// Integration infrastructure領域の概念であり、core/tact-integration/は
// core/tact-workへ依存する(一方向)——この逆方向(core/tact-work →
// core/tact-integration)のimportを作ると循環参照になるため、
// このfileはtact-integrationを一切importしない。
//
// 代わりに、core/tact-orchestrator/types.tsのOrchestrationHooksと
// 全く同じ設計思想(「下位層は汎用の拡張点だけを持ち、実際の配線は
// 合成ルート/上位層が行う」)を採用する: このfile自身はConnection
// 解決の「型」だけを知り、実装はRunWorkTurnDeps経由で呼び出し元
// (core/tact-conversation/orchestration.ts、runWorkTurn()の唯一の
// 呼び出し元)が注入する。既定実装(defaultResolveIntegrationConnection)
// は常に"none"を返す安全なfallbackであり、実Supabase/tact-integration
// への依存を一切持たない(呼び出し元が実装を注入しない限り、
// Integration機能は安全に無効のまま)。
export interface ResolveIntegrationConnectionParams {

  service: string;

  userId: string;

  accessToken: string;

}

export type ResolveIntegrationConnectionOutcome =
  | { status: "none" }
  | { status: "single"; connectionId: string }
  | { status: "multiple"; count: number };

export type ResolveIntegrationConnection = (
  params: ResolveIntegrationConnectionParams
) => Promise<ResolveIntegrationConnectionOutcome>;

async function defaultResolveIntegrationConnection(): Promise<ResolveIntegrationConnectionOutcome> {
  return { status: "none" };
}

export interface RunWorkTurnDeps {

  updateWorkStatus: typeof updateWorkStatus;

  createTask: typeof createTask;

  createTaskDependency: typeof createTaskDependency;

  updateTaskStatus: typeof updateTaskStatus;

  createRun: typeof createRun;

  completeRun: typeof completeRun;

  failRun: typeof failRun;

  runOrchestration: typeof defaultRunOrchestration;

  // Architecture Migration Phase B3(Approval Execution)。
  requestApproval: typeof defaultRequestApproval;

  // Architecture Migration Phase C2.1a(Work Completion Reconciliation)。
  // 以前はこのfile内にインライン実装されていたWork completion
  // judgment(anyFailed ? failed : completed)を、Integration経由の
  // 実行とも共有できる責務としてcore/tact-work/completion.tsへ
  // 切り出した。
  reconcileWorkCompletionStatus: typeof defaultReconcileWorkCompletionStatus;

  // Architecture Migration Phase C2.1b。既定はdefaultResolveIntegration
  // Connection(常に"none")——実Connection lookupが必要な呼び出し元
  // (core/tact-conversation/orchestration.ts)がこのfieldを上書きする。
  resolveIntegrationConnection: ResolveIntegrationConnection;

}

// core/tact-conversation/orchestration.ts(runWorkTurn()の唯一の
// 呼び出し元)が、resolveIntegrationConnectionだけを実装(core/
// tact-integration/connection.tsのlistConnectionsForUser())へ差し替え
// つつ、他の全dependencyはこの既定値をそのまま使えるようexportする。
export const defaultRunWorkTurnDeps: RunWorkTurnDeps = {
  updateWorkStatus,
  createTask,
  createTaskDependency,
  updateTaskStatus,
  createRun,
  completeRun,
  failRun,
  runOrchestration: defaultRunOrchestration,
  requestApproval: defaultRequestApproval,
  reconcileWorkCompletionStatus: defaultReconcileWorkCompletionStatus,
  resolveIntegrationConnection: defaultResolveIntegrationConnection,
};

export interface RunWorkTurnParams {

  work: Work;

  userId: string;

  accessToken: string;

  orchestrationRequest: OrchestrationRequest;

}

export async function runWorkTurn(
  params: RunWorkTurnParams,
  deps: RunWorkTurnDeps = defaultRunWorkTurnDeps
): Promise<OrchestrationResult> {

  const { work, userId, accessToken, orchestrationRequest } = params;

  // Work.status="created"(初回Turn、まだTaskが1件も計画されていない)
  // の場合のみ、実行開始の意図を示すため先に"planning"へ遷移する。
  // 実際の"running"遷移はonTasksPlanned(下記、decomposeTask()が
  // 実際にTaskを生成した時点)で行う——Ambiguity Detectionにより
  // Clarificationだけを返して終わる場合(decomposeTask()自体が
  // 呼ばれない)、Workは"running"へは進まない。
  if (work.status === "created") {
    await deps.updateWorkStatus(work.id, userId, accessToken, "planning");
  }

  // decomposeTask()が生成したOrchestrator Task.id(runtime UUID)から、
  // 永続化したWorkTask.idへのmapping。同一Work Turn内でのみ有効な
  // 一時的な対応表であり、永続化はしない。
  const workTaskIdByOrchestratorTaskId = new Map<string, string>();

  // Architecture Migration Phase B3: このTurn内でApproval要求
  // signal(TaskExecutionSummary.approvalRequirement)を返したTaskを
  // 集める。Approval待機そのものはRunとして扱わない(絶対条件14)
  // ——ここで集めるのは「どのWorkTaskがApprovalを必要としたか」
  // というポインタだけであり、Run/Capability呼び出しとは独立して
  // 扱う。
  const approvalRequirements: {
    workTaskId: string;
    capability?: string;
    requirement: TaskApprovalRequirement;
  }[] = [];

  // Architecture Migration Phase C2.1b-fix2: Integration Taskで
  // Connection解決がnone/multipleだった場合の記録。onTaskFinished()
  // はOrchestrationResult(result変数)が確定する前に呼ばれるため、
  // ここでは呼び出し元へ見せるanswer文言の材料だけを集め、実際の
  // result.answer上書き・Work→waiting_for_input遷移は
  // runOrchestration()の戻り値を受け取った後(下記)で行う。
  const integrationConnectionIssues: {
    service: string;
    status: "none" | "multiple";
    count?: number;
  }[] = [];

  const hooks: OrchestrationHooks = {

    onTasksPlanned: async (tasks: Task[]) => {

      await deps.updateWorkStatus(work.id, userId, accessToken, "running");

      for (const task of tasks) {

        const workTask = await deps.createTask(
          work.id,
          userId,
          accessToken,
          {
            description: task.description,
            assignedCapability: task.assignedCapability ?? null,
            tableSchema: task.tableSchema ?? null,
          }
        );

        if (workTask) {
          workTaskIdByOrchestratorTaskId.set(task.id, workTask.id);
        }

      }

      // dependenciesは全WorkTaskが作られた後の2周目で解決する
      // (Task.dependenciesは同じtasks[]内の他Taskのidを指すため)。
      for (const task of tasks) {

        const workTaskId = workTaskIdByOrchestratorTaskId.get(task.id);

        if (!workTaskId || !task.dependencies?.length) {
          continue;
        }

        for (const dependsOnOrchestratorTaskId of task.dependencies) {

          const dependsOnWorkTaskId = workTaskIdByOrchestratorTaskId.get(
            dependsOnOrchestratorTaskId
          );

          if (dependsOnWorkTaskId) {

            await deps.createTaskDependency(
              work.id,
              userId,
              accessToken,
              workTaskId,
              dependsOnWorkTaskId
            );

          }

        }

      }

    },

    onAttempt: async (task, record) => {

      const workTaskId = workTaskIdByOrchestratorTaskId.get(task.id);

      if (!workTaskId) {
        return;
      }

      const run = await deps.createRun(
        work.id,
        userId,
        accessToken,
        workTaskId,
        {
          attempt: record.attempt,
          capability: record.capability,
          provider: record.provider ?? null,
          model: record.model ?? null,
        }
      );

      if (!run) {
        return;
      }

      if (record.status === "completed") {

        await deps.completeRun(work.id, userId, accessToken, run.id, {
          result: record.result ?? null,
        });

      } else {

        await deps.failRun(work.id, userId, accessToken, run.id, {
          error: record.error ?? "unknown error",
        });

      }

    },

    onTaskFinished: async (task, summary) => {

      const workTaskId = workTaskIdByOrchestratorTaskId.get(task.id);

      if (!workTaskId) {
        return;
      }

      // Architecture Migration Phase C2.1c-a(絶対条件、最重要):
      // Approvalは「Task completionの後に付随するレビュー」ではなく
      // 「Task completionそのものの前提となるgate」である(既存の
      // protected external write sequence: prepare/propose → Approval
      // → execute external side effectがそのまま根拠——Approvalが
      // 実行を許可するまで、そのTaskが表す仕事はまだ何も完了していない)。
      // そのため、approvalRequirementを返したTaskは、この時点では
      // 一切completedとしてpersistしない——createTask()が付与した
      // 初期status(pending)のまま据え置く。Approvalが承認され、
      // 実際にexecuteApprovedIntegrationAction()が実行を開始する
      // 時点で初めてpending→runningへ進み、その結果でrunning→
      // completed/failedへ進む(絶対条件: terminal stateから
      // 非terminalへ戻る、または一度completedにしてから他statusへ
      // 動かすような非単調な遷移をTask status historyへ持ち込まない)。
      if (summary.approvalRequirement) {

        if (summary.approvalRequirement.action?.kind === "integration_action") {

          // Architecture Migration Phase C2.1b由来: Connection解決は
          // 「Approvalを実際に作ってよいか」を決めるための前段判定
          // であり、Task status persistenceには一切関与しない
          // (Provider resolution自体はここへ持ち込まない、
          // deps.resolveIntegrationConnection()が返す既に
          // canonical化された結果だけを見る)。
          const metadata = summary.approvalRequirement.action.metadata as
            | { service?: unknown }
            | undefined;

          const service = typeof metadata?.service === "string" ? metadata.service : undefined;

          if (service) {

            const connectionResolution = await deps.resolveIntegrationConnection({
              service,
              userId,
              accessToken,
            });

            if (connectionResolution.status !== "single") {

              // Connection未解決。Approvalを作らない
              // (approvalRequirementsへpushしない)。Taskは
              // updateTaskStatus()を一切呼ばずpendingのまま据え置く。
              integrationConnectionIssues.push(
                connectionResolution.status === "none"
                  ? { service, status: "none" }
                  : { service, status: "multiple", count: connectionResolution.count }
              );

              return;

            }

            // status === "single": 解決できたconnectionIdをmetadataへ
            // 追加してからApproval requirementへ積む。Taskは
            // ここでもcompletedへ進めない(pendingのまま)。
            approvalRequirements.push({
              workTaskId,
              capability: summary.capability,
              requirement: {
                ...summary.approvalRequirement,
                action: {
                  ...summary.approvalRequirement.action,
                  metadata: { ...metadata, connectionId: connectionResolution.connectionId },
                },
              },
            });

            return;

          }

        }

        // 汎用のapprovalRequirement(kind!=="integration_action"、
        // またはservice未解決の防御的fallback)。Taskをcompletedへ
        // 進めず、そのままApproval requirementへ積む。
        approvalRequirements.push({
          workTaskId,
          capability: summary.capability,
          requirement: summary.approvalRequirement,
        });

        return;

      }

      // approvalRequirementが無い通常Task: 従来通りTaskExecutionSummary.
      // statusをそのままpersistする(pending/running/completed/failed/
      // cancelled、ARCH-R2 Section4、Phase B1で既に揃えてある)。
      await deps.updateTaskStatus(work.id, userId, accessToken, workTaskId, summary.status);

    },

  };

  let result: OrchestrationResult;

  try {

    result = await deps.runOrchestration(orchestrationRequest, hooks);

  } catch (error) {

    // 絶対条件17(既存executor.tsと同じ精神): Work Execution Boundary
    // 自体も、Orchestrator全体が予期せず例外を投げた場合(Ambiguity
    // Detection/decomposeTask()自体のバグ等、通常到達しない)にWorkを
    // "failed"のまま放置しない。
    await deps.updateWorkStatus(work.id, userId, accessToken, "failed");

    throw error;

  }

  // Architecture Migration Phase C2.1b-fix2: onTaskFinished()の時点で
  // Connection解決(none/single/multiple)・connectionId注入は既に
  // 完了しているため、approvalRequirementsに積まれた各entryは
  // 「そのままrequestApproval()してよいもの」だけになった(絶対条件
  // Phase B3をそのまま踏襲、既存のシンプルな形へ戻す)。
  if (approvalRequirements.length > 0) {

    // Architecture Migration Phase B3: 人間の承認待ちは、Clarification
    // (曖昧な依頼内容の確認)やTask失敗とは別種の「実行を続けてよいか」
    // という判断であり、最優先で扱う(Clarification/failed/completed
    // いずれの判定よりも先にWorkをwaiting_for_approvalへ進める)。
    // requestApproval()自体がWork→waiting_for_approvalへの遷移を
    // 行う(1件ごとに呼んでも冪等——同じstatusへ複数回更新するだけ)。
    for (const { workTaskId, capability, requirement } of approvalRequirements) {

      await deps.requestApproval(
        {
          workId: work.id,
          taskId: workTaskId,
          scope: "task",
          // Approvalを提案した主体はCapability自身(人間・Botではない)。
          // ARCH-R2 Section9の方針通り、AIごとの行を作らずcapability名を
          // 固定文字列のActor idとして使う。
          requestedByActor: { kind: "ai", id: capability ?? "orchestrator" },
          // 判断を仰ぐ相手は常にWork所有者本人(Bot経由でも、
          // server側で解決済みのtactUserId=userId、BOT-P2.5の絶対
          // 条件をそのまま継承)。
          requestedFromActor: { kind: "user", id: userId },
          reason: requirement.reason,
          action: requirement.action,
        },
        userId,
        accessToken
      );

    }

  }

  if (approvalRequirements.length > 0) {

    // requestApproval()が既にWork→waiting_for_approvalへの遷移を
    // 行っているため、ここでは何もしない。

  } else if (result.clarification || integrationConnectionIssues.length > 0) {

    // Phase B2 Section11/12: Clarificationが必要な場合、Workは
    // "waiting_for_input"のまま(または遷移する)。ユーザーが回答すると
    // 次回のTurnでonTasksPlanned()が呼ばれ、"running"へ戻る
    // (Clarification subsystem自体は変更していない)。
    //
    // Architecture Migration Phase C2.1b-fix2: Connection未解決
    // (none/multiple、onTaskFinished()で検出済み)も同じ
    // waiting_for_inputを使う。ambiguityDetector経由の古典的
    // Clarification(pending_clarification_message_id等の専用
    // persistence/resend機構)へは乗せない——今回発生しているのは
    // 「入力が曖昧だった」のではなく「Integration実行に必要な外部
    // 前提条件(Connection)が満たされていない」という別種のruntime
    // required inputであり、既存Clarification answer resendロジックを
    // 誤って作動させないため。Work statusの値自体だけを共有する。
    if (integrationConnectionIssues.length > 0 && !result.clarification) {

      const issue = integrationConnectionIssues[0];

      result = {
        ...result,
        answer:
          issue.status === "none"
            ? `${issue.service}連携が見つかりません。先に連携を行ってください。`
            : `${issue.service}連携が複数見つかりました。現在、複数連携からの選択には対応していません。`,
      };

    }

    await deps.updateWorkStatus(work.id, userId, accessToken, "waiting_for_input");

  } else {

    // Architecture Migration Phase C2.1a: 以前はこのTurnの
    // OrchestrationResult.tasksだけを見てWork全体のcompleted/failedを
    // 即断していたが、Workが所有する全Task(過去のTurn分も含む)を見て
    // 判定する共有責務(reconcileWorkCompletionStatus())へ委譲する。
    // Approval一覧も内部で確認するため、Task自体はterminalに見えても
    // pending Approvalが残っている(Phase B3のapprovalRequirement
    // pattern)場合はWork statusを変更しない——この安全側の判定は
    // 既存のテストされている挙動を変えない(このelse分岐へ到達する
    // のはapprovalRequirements.length===0の場合のみであり、既存の
    // regression testはいずれも単一Turン内で完結するため、Workが
    // 所有する全Taskの集合はこのTurnのresult.tasksと一致する)。
    await deps.reconcileWorkCompletionStatus(work.id, userId, accessToken);

  }

  return result;

}
