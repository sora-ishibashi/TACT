import { runOrchestration as defaultRunOrchestration } from "../tact-orchestrator";
import type {
  OrchestrationRequest,
  OrchestrationResult,
  OrchestrationHooks,
  Task,
  TaskApprovalRequirement,
  TaskApprovalAction,
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
// Fast Port P3a: Human Interaction Foundation(require_input branchの
// wiring先)。
import { requestClarification as defaultRequestClarification } from "./clarification";
import { reconcileWorkCompletionStatus as defaultReconcileWorkCompletionStatus } from "./completion";
import type { Work } from "./types";
import { buildApprovalSubject, type ApprovalSubject } from "./approvalIntegrity";
// Fast Port P4b: Audit emission。onTaskFinished()が受理した
// canonical PolicyDecisionの初回評価(policy.evaluated)のcanonical
// emitterである(Step1: 「evaluatePolicyDecision()を呼んだだけでは
// なく、live callerがそのDecisionを受理した地点」)。
import { emitAuditSafely as defaultEmitAuditSafely } from "./audit";

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

// =========================
// executeReadIntegrationAction seam (Architecture Migration Phase C2.2)
// =========================
//
// resolveIntegrationConnectionと全く同じ設計思想: このfile自身は
// core/tact-integrationを一切importせず(循環依存回避、上記コメント
// 参照)、実行の「型」だけを知る。実装はRunWorkTurnDeps経由で呼び出し元
// (core/tact-conversation/orchestration.ts)が注入する。actionは
// IntegrationAction(core/tact-integration所有の型)ではなく、既に
// このfileがimport可能なTaskApprovalAction(core/tact-orchestrator所有、
// {kind, summary, metadata:{service, operation, input, connectionId}})
// をそのまま使う——新しい型を追加せず、write pathのapprovalRequirements
// が既に使っているのと同じcanonical action表現を再利用する(絶対条件
// Correction2)。
export interface ExecuteReadIntegrationActionParams {

  workId: string;

  userId: string;

  accessToken: string;

  taskId: string;

  connectionId: string;

  action: TaskApprovalAction;

}

// write側のIntegrationActionExecutionOutcome(core/tact-integration/
// execution.ts)と意図的に同じstatus語彙を使うが、この型自体は
// core/tact-integrationをimportせずここで独立して定義する(循環依存
// 回避のため、値では無くstringのunionとして再宣言するだけ)。
export type ExecuteReadIntegrationActionOutcome =
  | { status: "completed"; resultOutput?: string }
  | { status: "failed" }
  | { status: "connection_unavailable" }
  | { status: "invalid_action" }
  | { status: "task_not_executable" }
  | { status: "not_found" }
  | { status: "work_not_runnable" }
  // Fast Port P5c: Runtime(Trigger.dev)へhandoffされ、実際のprovider
  // 実行はTrigger.dev task側で非同期に行われる状態。canonical Run
  // は既にTACT側で作成済み(policy.evaluated→run.created完了)だが、
  // このTurn内ではread結果を同期的に返せない——絶対条件(Resume
  // brief Critical P5c architecture question、Option C): original
  // caller result deliveryはこのPhaseの対象外(このstatusは既存の
  // "completed"分岐(if文、exhaustive switchではない)には一致しない
  // ため、単に何もせず素通りする——既存呼び出し元コードの変更は
  // 不要)。
  | { status: "runtime_dispatched" };

export type ExecuteReadIntegrationAction = (
  params: ExecuteReadIntegrationActionParams
) => Promise<ExecuteReadIntegrationActionOutcome>;

// 既定はinvalid_actionへ安全にfallbackする(defaultResolveIntegration
// Connectionが常に"none"を返すのと同じ理由——実Integration実行機能が
// 必要な呼び出し元だけがこのfieldを上書きする、それ以外は安全に
// 無効のまま)。
async function defaultExecuteReadIntegrationAction(): Promise<ExecuteReadIntegrationActionOutcome> {
  return { status: "invalid_action" };
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

  // Fast Port P3a(Human Interaction Foundation)。policyDecision===
  // "require_input"のonTaskFinished()分岐から、Clarificationを作成
  // できるようにする(Step11-B)。P3a時点でこの値を実際に生成する
  // Capability Producerは存在しない(P2a/P2bで確認済み)ため、live
  // productionでは通常到達しない(Step11-C、明示的に許容された状態)。
  requestClarification: typeof defaultRequestClarification;

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

  // Architecture Migration Phase C2.2。既定はdefaultExecuteReadIntegration
  // Action(常にinvalid_action)——実read実行が必要な呼び出し元
  // (core/tact-conversation/orchestration.ts)がこのfieldを上書きする。
  executeReadIntegrationAction: ExecuteReadIntegrationAction;

  // Fast Port P4b: Audit-safe emission(既定は実emitAuditSafely、
  // approval.ts/clarification.tsと同じDI pattern、Step13)。
  emitAuditEvent: typeof defaultEmitAuditSafely;

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
  requestClarification: defaultRequestClarification,
  reconcileWorkCompletionStatus: defaultReconcileWorkCompletionStatus,
  resolveIntegrationConnection: defaultResolveIntegrationConnection,
  executeReadIntegrationAction: defaultExecuteReadIntegrationAction,
  emitAuditEvent: defaultEmitAuditSafely,
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
    // Architecture Migration ARCH-P1b: この時点で既にbuildApprovalSubject()
    // を通過済みのApproval Subject v1。承認presentation用のrequirement
    // (summary等)とは別に、machine-verifiable canonical action
    // semanticsを保持する(docs/architecture/approval-integrity.md参照)。
    //
    // 絶対条件(Step8、Legacy/非Integration Approval): この配列は
    // Integration write以外の汎用Approval機構(Phase B3由来、下記の
    // summary.approvalRequirement分岐)にも引き続き使われる。汎用
    // TaskApprovalRequirement.action(kind/summary/metadataのみの
    // 開かれた形)にはIntegration canonical action(service/operation/
    // input/connectionId)が存在しない場合があるため、subjectを
    // 無理に構築できない——今回はprotected integration actionのみを
    // capture対象とし、それ以外はsubject: undefinedのまま
    // (=Approval Subject evidenceを保存しない)とする(将来の
    // generic Approval Integrity拡張ポイントを壊さない、Step8絶対条件)。
    subject?: ApprovalSubject;
  }[] = [];

  // Architecture Migration ARCH-P1b: Approval Subject自体の構築
  // (canonicalize検証)に失敗したWorkTaskのポインタを集める
  // (絶対条件、Step7: fail closed——subject無しでApprovalを作って
  // 続行しない)。integrationConnectionIssuesと同じ「実行に必要な
  // 前提条件が満たせなかった」という扱いにする(新しいWork/Task
  // statusを追加しない、既存waiting_for_inputパターンを再利用する)。
  const subjectBuildFailures: { workTaskId: string }[] = [];

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

  // Architecture Migration Phase C2.2: Connectionがsingleに解決でき、
  // かつpolicy上requiresApproval===false(read)だったIntegration Task
  // を集める。approvalRequirementsと同じく「どのWorkTaskが対象か」
  // というポインタの集合であり、実際のexecuteReadIntegrationAction()
  // 呼び出しはrunOrchestration()の戻り値を受け取った後(下記)で行う
  // (絶対条件: readのためにfake Approvalを作らない、Approval作成
  // 経路とは完全に別のpathとして扱う)。
  const integrationReadExecutions: {
    workTaskId: string;
    connectionId: string;
    action: TaskApprovalAction;
  }[] = [];

  // Fast Port P3a(Human Interaction Foundation): policyDecision===
  // "require_input"だったIntegration Taskを集める。approvalRequirements/
  // integrationReadExecutionsと同じく「どのWorkTaskが対象か」という
  // ポインタの集合であり、実際のrequestClarification()呼び出しは
  // runOrchestration()の戻り値を受け取った後(下記)で行う(絶対条件13:
  // resolveClarification()同様、この時点でもProvider/Run呼び出しは
  // 一切発生しない)。P3a時点でこの値を実際に生成するCapability
  // Producerは存在しないため、この配列は通常空のままである
  // (Step11-C、明示的に許容された状態)。
  const clarificationRequirements: {
    workTaskId: string;
    capability?: string;
    question: string;
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
      // Architecture Migration Phase C2.2(Read/Write Policy): Integration
      // Capability専用のsignal。write(requiresApproval===true)・read
      // (requiresApproval===false)いずれの場合もConnection解決
      // (deps.resolveIntegrationConnection())が最初の前段判定である
      // 点は変わらない——0件/複数件ならTaskをpendingのまま据え置き、
      // single解決できて初めて次(Approval作成 or 即時read実行)へ進む
      // (絶対条件Section15: Connection解決はTask completionより
      // 必ず前、Approval経由でもread経由でも同じ)。
      if (summary.integrationRequirement) {

        const metadata = summary.integrationRequirement.action.metadata as
          | { service?: unknown; operation?: unknown; input?: unknown }
          | undefined;

        const service = typeof metadata?.service === "string" ? metadata.service : undefined;

        // Architecture Migration ARCH-P1b: Approval Subject構築
        // (buildApprovalSubject())にはservice単体だけでなく
        // operation/inputも必要なため、ここで同時に抽出する
        // (service単独チェックだった既存の防御的fallbackを拡張する
        // だけで、requiresApproval===falseのread pathの挙動は
        // 変えない——operation/input欠落は通常到達しない
        // ——Integration Capabilityは必ずmetadata.{service,operation,
        // input}を設定する)。
        const operation = typeof metadata?.operation === "string" ? metadata.operation : undefined;
        const input =
          metadata && typeof metadata.input === "object" && metadata.input !== null
            ? (metadata.input as Record<string, unknown>)
            : undefined;

        if (!service || !operation || !input) {

          // service/operation/input自体を特定できない防御的fallback
          // (通常到達しない——Integration Capabilityは必ず
          // metadata.{service,operation,input}を設定する)。
          // Approvalを作らずTaskはpendingのまま据え置く安全側にとどめる。
          return;

        }

        const connectionResolution = await deps.resolveIntegrationConnection({
          service,
          userId,
          accessToken,
        });

        if (connectionResolution.status !== "single") {

          // Connection未解決。Approvalも作らず、read実行もキューしない
          // (integrationConnectionIssuesへpushするだけ)。Taskは
          // updateTaskStatus()を一切呼ばずpendingのまま据え置く。
          integrationConnectionIssues.push(
            connectionResolution.status === "none"
              ? { service, status: "none" }
              : { service, status: "multiple", count: connectionResolution.count }
          );

          return;

        }

        // status === "single": 解決できたconnectionIdをmetadataへ
        // 追加する(write/read共通)。Taskはここでもcompletedへ
        // 進めない(pendingのまま、Approval承認後 or read実行完了後に
        // 初めてrunning→completed/failedへ進む)。
        const resolvedAction: TaskApprovalAction = {
          ...summary.integrationRequirement.action,
          metadata: { ...metadata, connectionId: connectionResolution.connectionId },
        };

        // Fast Port P4b(Step1/Step3): policy.evaluated(初回評価)の
        // canonical emitter。「evaluatePolicyDecision()を呼んだだけ
        // ではなく、live callerがそのDecisionを受理した地点」
        // (Step1)——このonTaskFinished()がConnection解決を終え、
        // 実際にswitch文でrouting判断を行う直前が該当する。ALLOW/
        // REQUIRE_APPROVAL/REQUIRE_INPUT/DENYのいずれの結果でも
        // 無条件にemitする(Step17/24: DENYでもpolicy.evaluatedは
        // 残る)。canonicalInput/secret等は一切含めない(Step19: 安全な
        // service/operation/decision/riskClassのみ)。actorはpolicy
        // evaluator自体をsystem actorとして扱う(Step3で検討・確定)。
        await deps.emitAuditEvent(
          {
            workId: work.id,
            taskId: workTaskId,
            category: "policy",
            eventType: "policy.evaluated",
            actor: { kind: "system", id: "policy-evaluator" },
            reasonCode: summary.integrationRequirement.policyReasonCode ?? null,
            details: {
              service: service ?? null,
              operation: operation ?? null,
              decision: summary.integrationRequirement.policyDecision,
              riskClass: summary.integrationRequirement.riskClass ?? null,
            },
          },
          userId,
          accessToken
        );

        // Fast Port P2b(docs/architecture/p2-p5-final-architecture.md
        // Section5-9、絶対条件10/11を継承): 旧
        // `if (summary.integrationRequirement.requiresApproval) {...} else {...}`
        // というboolean分岐を、canonical PolicyDecisionの4値
        // (core/tact-orchestrator/task.tsのTaskIntegrationPolicyDecision、
        // core/tact-integration/policy.tsのPolicyDecisionOutcomeと
        // 同じ値)によるexhaustive switchへformalizeする。allow/
        // require_approvalの2分岐は既存挙動と完全に同一
        // (summary.integrationRequirement.requiresApprovalは
        // policyDecision==="require_approval"からの導出fieldであり、
        // 二重判断はしていない)。require_input/denyはP2a時点で
        // 実際にこの値を生成するCapability Producerが存在しないため
        // 通常到達しないが、型としてのcanonical decisionが4値である
        // 以上、防御的に必ず処理する(絶対条件: fail-closed、
        // Provider call 0・Run作成0・Approval作成0を保証する)。
        switch (summary.integrationRequirement.policyDecision) {

          case "require_approval": {

            // Architecture Migration ARCH-P1b: Approval作成前に、この
            // 時点で確定しているcanonical integration action(service/
            // operation/input/connectionId)から、machine-verifiableな
            // Approval Subject v1を構築する。human-visible summary
            // (resolvedAction.summary)と全く同じresolvedActionオブジェクト
            // (=同じCapability呼び出しが同時に生成した値)からderiveする
            // ため、別sourceからの再構築は発生しない(絶対条件、
            // docs/architecture/approval-integrity.md Step5)。
            const subjectResult = buildApprovalSubject({
              workId: work.id,
              taskId: workTaskId,
              service,
              operation,
              input,
              connectionId: connectionResolution.connectionId,
              riskClassSnapshot: summary.integrationRequirement.riskClass ?? null,
            });

            if (!subjectResult.ok) {

              // 絶対条件(Step7、fail closed): Integrity evidenceを
              // 生成できないprotected actionは、subject無しでApprovalを
              // 作って続行しない——Approval自体を一切作らず(provider
              // callはもちろん0)、Taskはpendingのまま据え置く。raw
              // canonical payload/secretはログへ出さない(reasonという
              // 短い分類ラベルだけを記録する、既存のconsole.warn
              // best-effortログパターンを踏襲)。
              console.warn(
                "[tact-work/execution] buildApprovalSubject() failed for a protected action; " +
                "Approvalを作らず安全に停止する(Task/Workは変更しない)。",
                subjectResult.reason
              );

              subjectBuildFailures.push({ workTaskId });

              return;

            }

            approvalRequirements.push({
              workTaskId,
              capability: summary.capability,
              requirement: {
                reason: summary.integrationRequirement.reason ?? resolvedAction.summary,
                action: resolvedAction,
              },
              subject: subjectResult.subject,
            });

            return;

          }

          case "allow": {

            // 絶対条件(Correction2、Section9): readのためにfake Approval
            // を作らない。Approvalとは完全に別のpath(integrationReadExecutions)
            // へ積み、実行はrunOrchestration()の戻り値を受け取った後
            // (下記)で行う。
            integrationReadExecutions.push({
              workTaskId,
              connectionId: connectionResolution.connectionId,
              action: resolvedAction,
            });

            return;

          }

          case "require_input": {

            // Fast Port P3a(Step11-A/B): P2bのno-op stubを、実際に
            // requestClarification()を呼べる構造へ配線する。question
            // には既存のintegrationRequirement.reason(無ければ
            // resolvedAction.summary)をそのまま使う——このために新しい
            // fieldをTaskIntegrationRequirementへ追加しない(絶対条件
            // Step18: core/tact-integration/execution.tsを含む
            // Integration Gateway側は今回変更しない、既存の開かれた
            // 形をそのまま再利用する)。reasonCodeはP3a時点で唯一
            // 登録済みの"missing_required_input"を使う(絶対条件Step4)。
            //
            // Step11-C: P3a時点でpolicyDecision==="require_input"を
            // 実際に生成するCapability Producerは存在しない
            // (P2a/P2bで確認済み)ため、このcase自体はlive production
            // では通常到達しない——型としてのcanonical decisionが4値
            // である以上、handler側は必ず実装する(実際にはこの配列は
            // 通常空のまま、後段のdrain loopも実行されない)。
            clarificationRequirements.push({
              workTaskId,
              capability: summary.capability,
              question: summary.integrationRequirement.reason ?? resolvedAction.summary,
            });

            return;

          }

          case "deny": {

            // Fast Port P2b Step9: DENYはApprovalで突破不可
            // (絶対条件11)。Provider call 0・Run 0・Approval 0を保証
            // するため、既存のinvalid_action/task_not_executable等の
            // execution boundary rejectionと同じ規約(Task statusを
            // 変更しない、pendingのまま据え置く)にそのまま従う。
            // 通常到達しない(Integration Capability自身が
            // evaluatePolicyDecision()===denyの時点でsuccess:falseを
            // 返し、integrationRequirement自体を生成しないため)が、
            // 将来policy.ts側の登録が変更された場合に備えた防御的
            // ハンドリング。
            console.warn(
              "[tact-work/execution] policyDecision==='deny' for a protected action; " +
              "Approvalを作らず安全に停止する(Task/Workは変更しない)。",
              { workTaskId, service, operation }
            );

            return;

          }

          default: {

            // Fast Port P2b Step10絶対条件: PolicyDecisionはexhaustive
            // switchで網羅する。ここに到達する値が増えた場合は
            // コンパイルエラーになる(型レベルの網羅性保証、
            // production helperを別途増やさない)。
            const exhaustiveCheck: never = summary.integrationRequirement.policyDecision;
            void exhaustiveCheck;

            return;

          }

        }

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
      //
      // Architecture Migration Phase C2.2: Integration Capability自身は
      // もうこのapprovalRequirementを一切返さない(上のintegrationRequirement
      // 分岐へ完全に移行した)。この分岐は、将来の非Integration
      // Capabilityが汎用Approval機構(Phase B3由来)を使う場合のためだけに
      // 残す(tests/tact/work/execution.test.tsのkind="external_write_test"
      // 参照、既存の非Integration用途を壊さない)。
      //
      // Architecture Migration ARCH-P1b(Step8): この汎用pathは
      // canonical integration action(service/operation/input)を
      // 持たないため、subjectを構築しない(subject: undefinedのまま
      // ——このApprovalにはSubject evidenceが保存されない)。P1bは
      // protected integration actionのみをcapture対象とする、という
      // 明示的なscope限定(将来generic化する場合は、汎用
      // TaskApprovalAction自体にcanonical action semanticsを表現できる
      // 形が必要になる——今回は行わない)。
      if (summary.approvalRequirement) {

        approvalRequirements.push({
          workTaskId,
          capability: summary.capability,
          requirement: summary.approvalRequirement,
        });

        return;

      }

      // approvalRequirement/integrationRequirementが無い通常Task:
      // 従来通りTaskExecutionSummary.
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
    for (const { workTaskId, capability, requirement, subject } of approvalRequirements) {

      const approval = await deps.requestApproval(
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
          // Architecture Migration ARCH-P1b: onTaskFinished()時点で
          // 既に構築・検証済みのApproval Subject v1をそのまま渡す。
          subject,
        },
        userId,
        accessToken
      );

      // Architecture Migration Phase C2.1c-b: 呼び出し元(Bot/Web両方が
      // 経由するConversation層)が、このTurnで新規Approvalが発生した
      // ことをOrchestrationResult経由で観測できるようにする
      // (result.clarificationと同じ既存pattern)。複数件ある場合は
      // 最初の1件を代表として設定する(絶対条件: 巨大なmulti-approval
      // UIをこのPhaseで作らない、C2.1bと同じ単純化)。
      if (approval && !result.pendingApproval) {

        result = {
          ...result,
          pendingApproval: {
            approvalId: approval.id,
            summary: requirement.action?.summary ?? requirement.reason,
            reason: requirement.reason,
          },
        };

      }

    }

  }

  // Architecture Migration Phase C2.2: Connection解決済み・Approval
  // 不要(read)と判定されたIntegration Taskを、この時点で同期的に
  // 実行する(絶対条件Section16: Slack list_channels程度の短いreadは
  // 同期実行を許容する。Generic Orchestrator executor自身にComposio/
  // provider実行を持ち込まない——ここはWork Execution Boundary側の
  // 責務)。1 Task = executeReadIntegrationAction()呼び出し1回のみ
  // (絶対条件Section30: 自動retryしない)。
  if (integrationReadExecutions.length > 0) {

    for (const { workTaskId, connectionId, action } of integrationReadExecutions) {

      const executionOutcome = await deps.executeReadIntegrationAction({
        workId: work.id,
        userId,
        accessToken,
        taskId: workTaskId,
        connectionId,
        action,
      });

      // Architecture Migration Phase C2.2: 呼び出し元(Bot/Web両方が
      // 経由するConversation層)が、read結果を観測できるようにする
      // (result.pendingApprovalと同じ既存pattern)。複数件ある場合は
      // 最初の1件を代表として設定する(絶対条件: 巨大なmulti-result
      // UIをこのPhaseで作らない、pendingApprovalと同じ単純化)。
      // Task/Run/Work状態自体はexecuteReadIntegrationAction()内部
      // (core/tact-integration/execution.tsのgeneric core)が既に
      // 確定させている——ここではOrchestrationResultへの反映だけを行う。
      if (executionOutcome.status === "completed" && !result.integrationReadResult) {

        const metadata = action.metadata as { service?: unknown; operation?: unknown } | undefined;

        result = {
          ...result,
          integrationReadResult: {
            service: typeof metadata?.service === "string" ? metadata.service : "unknown",
            operation: typeof metadata?.operation === "string" ? metadata.operation : "unknown",
            output: executionOutcome.resultOutput ?? "null",
          },
        };

      } else if (
        // LIVE-1A(Read Failure Surfacing、絶対条件、最重要): "completed"
        // 以外は"runtime_dispatched"を除きすべてread failureとして扱う。
        // "runtime_dispatched"は実行が非同期Runtimeへ正常にhandoffされた
        // だけであり(このTurn内ではまだ結果が確定していない、既存の
        // 「素通り」挙動そのまま——このPhaseで新しい非同期completion
        // architectureは作らない)、failureではない。integrationReadResult
        // と同じ「最初の1件を代表として保持する」単純化方針(複数
        // Integration Taskがあっても、失敗表示は1件だけ)。
        executionOutcome.status !== "completed" &&
        executionOutcome.status !== "runtime_dispatched" &&
        !result.integrationReadFailure
      ) {

        const metadata = action.metadata as { service?: unknown; operation?: unknown } | undefined;

        result = {
          ...result,
          integrationReadFailure: {
            service: typeof metadata?.service === "string" ? metadata.service : "unknown",
            operation: typeof metadata?.operation === "string" ? metadata.operation : "unknown",
            status: executionOutcome.status,
          },
        };

      }

    }

  }

  // Fast Port P3a(Human Interaction Foundation): clarificationRequirements
  // に積まれた各entryをrequestClarification()する。approvalRequirements
  // と同じく、requestClarification()自体がWork→waiting_for_inputへの
  // 遷移を行う(1件ごとに呼んでも冪等——同じstatusへ複数回更新するだけ、
  // core/tact-work/store.tsのupdateWorkStatus()の既存の「タイムスタンプ
  // 二重設定防止」ロジックに支えられる)。P3a時点でこの配列は通常空の
  // まま(Step11-C)。
  if (clarificationRequirements.length > 0) {

    for (const { workTaskId, capability, question } of clarificationRequirements) {

      await deps.requestClarification(
        {
          workId: work.id,
          taskId: workTaskId,
          // Clarificationを提案した主体はCapability自身(人間・Bot
          // ではない)。approvalRequirements draining loopと同じ
          // 表現規約(ARCH-R2 Section9)。
          requestedByActor: { kind: "ai", id: capability ?? "orchestrator" },
          reasonCode: "missing_required_input",
          question,
        },
        userId,
        accessToken
      );

    }

  }

  if (approvalRequirements.length > 0) {

    // requestApproval()が既にWork→waiting_for_approvalへの遷移を
    // 行っているため、ここでは何もしない。

  } else if (clarificationRequirements.length > 0) {

    // Fast Port P3a: requestClarification()が既にWork→
    // waiting_for_inputへの遷移を行っているため、ここでは何もしない
    // (approvalRequirements分岐と対称、Approvalの方が優先度が高い
    // ——既存コメント通り、人間の承認待ちは最優先で扱う)。

  } else if (result.clarification || integrationConnectionIssues.length > 0 || subjectBuildFailures.length > 0) {

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
    //
    // Architecture Migration ARCH-P1b: Approval Subject構築失敗
    // (subjectBuildFailures)も同じ扱いにする——新しいWork/Task status
    // を追加せず、既存のruntime required inputパターンをそのまま
    // 再利用する。raw canonical payload/secretはuser向けmessageへ
    // 一切出さない(固定文言のみ)。
    if (integrationConnectionIssues.length > 0 && !result.clarification) {

      const issue = integrationConnectionIssues[0];

      result = {
        ...result,
        answer:
          issue.status === "none"
            ? `${issue.service}連携が見つかりません。先に連携を行ってください。`
            : `${issue.service}連携が複数見つかりました。現在、複数連携からの選択には対応していません。`,
      };

    } else if (subjectBuildFailures.length > 0 && !result.clarification) {

      result = {
        ...result,
        answer: "この操作の実行内容を確認できませんでした。もう一度お試しください。",
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
