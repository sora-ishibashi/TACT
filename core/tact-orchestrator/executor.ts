import { invokeCapability } from "../tact-core/capabilities/registry";
import { runChat } from "../tact-intent/chatHandler";
import { buildTaskContext } from "./taskContext";
import { resolveModelRouting } from "./modelRouter";
import { deriveAnswerConfidence } from "./confidence";
import { LLMProviderError } from "../llm/types";
import type { LLMProviderFailureReason } from "../llm/types";
import type { CoreCapability, LoadContextParams } from "../tact-core/types";
import type { ResearchResult, ResearchParams } from "../tact-research/types";
import type { Task, TaskExecutionSummary } from "./task";
import type { MemoryReference } from "./types";
import type { TaskContext } from "./taskContext";
import type { ConcurrencyGovernor } from "./concurrencyGovernor";
import type { AttachmentEvidence } from "../tact-attachment/types";
import { selectAttachmentEvidence } from "../tact-attachment/evidence";
// LW-P3: attachmentEvidenceと並行するLocal Workspace Evidence。
import type { LocalWorkspaceEvidence } from "../tact-context-source/localWorkspace/types";

// =========================
// 一時的失敗の最小限のRetry (Phase 19)
// =========================
//
// 対象範囲: chat経路・research以外のCapability経路(いずれもExecutor
// から見て「単発の外部呼び出し1回」であり、Retryのコスト増加が
// 呼び出し1回分に限定できる)。research経路は対象外とする——
// invokeCapability("research", ...)はSearch(既に自前でTavily→Brave
// fallbackを持つ、STEP151)+LLM 1回という複数ステップの内部パイプ
// ラインであり、Task全体をRetryするとSearch呼び出しごと再実行され、
// 「一時的失敗1回につき最大+1 call」という絶対条件(Step6)を満たせない
// ため(Research内部のLLM呼び出し1回だけを個別にRetryするには
// core/tact-research側の変更が必要になり、Step5の「Executor/
// Capability境界付近の最小変更」を超える)。ResearchResult.metadata.
// llmFailureReason(STEP184で既に構造化済み)は将来Research自身が
// 内部Retryを持つ場合の判定材料として使えるが、今回は変更しない。
//
// core/llm/runLLMWithFallback.ts(STEP168、Legacy Workflow向けの
// Provider横断フォールバック層)とは意図的に依存しない
// (core/tact-intent/chatHandler.ts・core/tact-research/llmAnswer.tsが
// 既に確立した「TACT新系列はLegacy向けFallback層を経由しない」という
// 方針をExecutorでも踏襲する)。quota_exceededはクレジットの補充等が
// 必要な恒久エラーのため、再試行しても回復しない。通常の一時的な
// rate_limited/network_errorだけを独立した定数として保持する。
const TEMPORARY_LLM_FAILURE_REASONS: ReadonlySet<LLMProviderFailureReason> =
  new Set(["rate_limited", "network_error"]);

// 認証エラー・不正なリクエスト(モデル名不正等)・分類不能な例外
// (Capability未登録等の設定ミス)はRetryしても回復しないため対象外
// (絶対条件: 「何でもRetry」ではない、Step8 False Recovery対策)。
// LLMProviderErrorでない例外(捕捉できない未知のエラー)も、回復可能かどうか
// 判断できないため保守的にRetryしない。
//
// Phase 20: exportする理由(Step10: Testabilityのための最小変更)。
// この判定ロジック自体がPhase19の中核(「どのFailureをRetryすべきで
// どれをすべきでないか」)であり、Evaluation Harness側でこの関数を
// 再実装して検証すると、実装と検証がズレた場合に気づけない
// (Step9: 実装詳細の複製ではなく実際の振る舞いを検証すべき)。
// 挙動そのものは一切変更していない(exportキーワードの追加のみ)。
export function isTemporaryFailure(error: unknown): boolean {

  return (
    error instanceof LLMProviderError &&
    TEMPORARY_LLM_FAILURE_REASONS.has(error.reason)
  );

}

// 最大1回だけRetryする汎用ラッパー。無限Retry・指数バックオフは
// 実装しない(絶対条件、必要性が実証されていない)。1回目が一時的
// 失敗でなければ即座にthrow(Retryしない)。1回目が一時的失敗で
// 2回目も失敗した場合、両方の失敗理由を1つのエラーメッセージへ
// 保持したままthrowする(絶対条件: 失敗を隠さない)。
//
// Phase 20: isTemporaryFailure()と同じ理由でexportする(Step10)。
export async function withTemporaryFailureRetry<T>(
  attempt: () => Promise<T>
): Promise<{ result: T; retried: boolean }> {

  try {

    const result = await attempt();
    return { result, retried: false };

  } catch (firstError) {

    if (!isTemporaryFailure(firstError)) {
      throw firstError;
    }

    try {

      const result = await attempt();
      return { result, retried: true };

    } catch (secondError) {

      const firstMessage =
        firstError instanceof Error ? firstError.message : String(firstError);

      const secondMessage =
        secondError instanceof Error ? secondError.message : String(secondError);

      throw new Error(
        `temporary failure persisted after 1 retry ` +
        `(1st attempt: ${firstMessage}; 2nd attempt: ${secondMessage})`
      );

    }

  }

}

// =========================
// executeTask / runTasks (Phase 3、Phase 4でTaskContext対応)
// =========================
//
// 責務分離: executeTask()は「1 Taskを、そのTask専用のTaskContextを
// 使ってどう実行するか」だけを知り、runTasks()は「複数Taskを
// dependenciesを守りながら、Taskごとに独立したTaskContextを構築して
// どう並べて実行するか」だけを知る。Commander(commander.ts)はこの2つを
// 呼び出すだけで、実行順序・Context構築そのものには関与しない。
//
// 絶対条件8(Agentのnest禁止): executeTask()は新しいTaskを生成しない。
// invokeCapability()経由で呼ぶ既存Capability(research/design)も、
// core/tact-research・core/tact-designのどちらもOrchestrator/Task
// 概念を一切知らないため、Sub-agentがさらにSub-agentを生成する経路は
// 構造的に存在しない。

// =========================
// buildMemoryReferences(Research実行結果から)
// =========================
//
// STEP208時点でPersistent CoreはUser Scopeのみ実装のため、scopeは
// 常に"user"として扱う。Organization/Project/Conversation Scope対応時
// はここも合わせて拡張する。
//
// 重要(Phase 4での位置づけの明確化): これはTaskContext.memoryReferences
// (「Taskに提示された=関連候補として渡した」)とは別物で、「Researchが
// 実際に回答へ使った」実データ(ResearchMetadata.usedKnowledgeIds等)
// から作る。「渡した」と「使った」を混同しない(STEP195以来の既存方針)。
//
// Phase 20: isTemporaryFailure()と同じ理由でexportする(Step10)。
// Research Evidence flow(ResearchResult.metadata.used*Ids →
// MemoryReference[])をEvaluation Harnessが実LLM/Search無しで検証
// できるようにするための最小限の変更。
export function buildMemoryReferencesFromResearch(
  result: ResearchResult
): MemoryReference[] {

  const refs: MemoryReference[] = [];

  for (const id of result.metadata.usedKnowledgeIds) {
    refs.push({ kind: "knowledge", id, scope: "user" });
  }

  for (const id of result.metadata.usedMemoryIds) {
    refs.push({ kind: "memory", id, scope: "user" });
  }

  for (const id of result.metadata.usedExampleIds) {
    refs.push({ kind: "example", id, scope: "user" });
  }

  return refs;

}

// =========================
// composeInputWithDependencies
// =========================
//
// 絶対条件(Task Result ≠ TACT Memory、依存関係): 依存Taskの「必要な
// 結果」だけをTask本文へ織り込む。依存Taskの全Context(取得した
// Memory・使ったProvider・cost等)は一切引き継がない
// (TaskContext.dependencyResultsが既にoutputだけへ絞られているため、
// ここではそれをそのまま文字列化するだけ)。
function composeInputWithDependencies(
  description: string,
  dependencyResults: { taskId: string; output?: string }[]
): string {

  const priorOutputs = dependencyResults
    .map((dep) => dep.output)
    .filter((output): output is string => !!output);

  if (priorOutputs.length === 0) {
    return description;
  }

  return (
    `前段のTaskの結果:\n${priorOutputs.join("\n\n")}\n\n` +
    `上記を踏まえて: ${description}`
  );

}

// =========================
// executeTask
// =========================
//
// assignedCapabilityが指定されている場合のみ、既存Capability Registry
// (core/tact-core/capabilities/registry.ts、STEP176)のinvokeCapability()
// を経由する。新しいCapability呼び出し機構は作らない(絶対条件3)。
// Research(assignedCapability === "research")には、taskContext.coreContext
// (このTask専用に絞り込み済みのCoreContext)をそのまま渡す。既存の
// ResearchParams.context契約(core/tact-research/types.ts)は変更しない
// ——値の中身をOrchestrator側で絞り込むだけであり、型は同じ
// CoreContextのまま(絶対条件: 既存APIを変更せずOrchestrator側で
// Contextを構築する)。
//
// assignedCapability未指定の場合は、core/tact-intent/chatHandler.ts
// (STEP216)のrunChat()を直接呼ぶ。chatはCapability Registryへ
// registerCapability()されていない既存の位置づけを変更しない。
//
// Phase 7: 実行前に必ずmodelRouter.tsのresolveModelRouting(task)を
// 呼ぶ(STEP4)。解決に失敗した場合(未知のProvider・未実装Provider・
// 確定的なProvider/Model不整合)は、LLM/Capability呼び出しを一切行わず
// 即座にstatus:"failed"を返す(絶対条件: 実行時まで黙って進めない、
// 例外をOrchestrator全体へ無条件にthrowしない)。
//
// 例外は一切外へ投げない(絶対条件17: 1 Taskの失敗が他Taskへ伝播
// しない)。失敗はTaskExecutionSummary.status="failed"として表現する。
export async function executeTask(
  task: Task,
  core: CoreCapability,
  taskContext: TaskContext,
  attachmentEvidence: AttachmentEvidence[] = [],
  workspaceEvidence: LocalWorkspaceEvidence[] = []
): Promise<TaskExecutionSummary> {

  const startedAt = Date.now();

  const input = composeInputWithDependencies(
    task.description,
    taskContext.dependencyResults
  );

  const routing = resolveModelRouting(task);

  if (!routing.success) {

    return {

      taskId: task.id,

      status: "failed",

      capability: task.assignedCapability,

      durationMs: Date.now() - startedAt,

      error: `model routing failed: ${routing.error}`,

    };

  }

  const { provider, model } = routing;

  try {

    if (task.assignedCapability === "research") {

      const result = await invokeCapability<ResearchParams, ResearchResult>(
        "research",
        {
          query: input,
          context: taskContext.coreContext,
          attachmentEvidence: selectAttachmentEvidence(input, attachmentEvidence),
          // LW-P3: workspaceEvidenceは既にclient側のWorkspace Context
          // Resolver(core/tact-context-source/localWorkspace/resolver.ts)
          // でbounded済み(最大3file・合計最大5万文字)のため、
          // attachmentEvidenceのようなTask単位の追加selectionは行わず
          // そのまま渡す(絶対条件10: 追加のLLM/API呼び出しを増やさない
          // 範囲での最小変更)。
          workspaceEvidence,
          // Phase90: task.tableSchema(Table要求を事前検知できた場合の
          // 列構成・要求件数)をResearchOptionsへそのまま橋渡しする。
          // 省略時(既存Phase1〜89のTask)はundefinedのまま、既存挙動を
          // 維持する。
          options: { llmProvider: provider, llmModel: model, tableSchema: task.tableSchema },
        },
        core
      );

      return {

        taskId: task.id,

        status: result.success ? "completed" : "failed",

        capability: "research",

        provider,

        model,

        memoryUsed: buildMemoryReferencesFromResearch(result),

        durationMs: Date.now() - startedAt,

        error: result.success ? undefined : result.errorMessage,

        output: result.success ? result.answer : undefined,

        // Phase 5: memoryCandidateBuilder.tsが「Coreに既にあった情報の
        // 再掲か、Web検索で得た新しい情報か」を区別するために使う。
        researchExecutionMode: result.metadata.executionMode,

        evidenceCount: result.evidence.length,

        // Phase76: これまでevidenceCountのみが転記され、実際の
        // Evidence配列自体は破棄されていた(Repository Evidence)。
        // TACT Artifact Mutation(core/tact-conversation/orchestration.ts)
        // がEvidence Blockを構築できるよう、result.evidenceをそのまま
        // 透過する(新しいRetrieval/LLM呼び出しは発生しない)。
        evidence: result.evidence,

        keyFindings: result.keyFindings,

        // Phase 21: confidence.tsのderiveAnswerConfidence()(純粋関数、
        // 新しいLLM呼び出し無し)。result.success===falseの場合は
        // undefinedを返す(Execution confidenceとの混同を避ける)。
        answerConfidence: deriveAnswerConfidence(result),

        uncertaintyNote: result.uncertainty,

        presentations: result.presentations,

        presentationWarnings: result.presentationWarnings,

        presentationRequested: result.presentationRequested,
        frameworkArtifacts: result.frameworkArtifacts,
        frameworkArtifactRequested: result.frameworkArtifactRequested,
        analysisArtifactPlan: result.analysisArtifactPlan,
        cortexArtifactPlanRequested: result.cortexArtifactPlanRequested,

      };

    }

    if (task.assignedCapability) {

      // research以外の登録済みCapability(例: "design")を、汎用の
      // 形のまま呼び出す。Orchestrator側でCapability固有の分岐を
      // 増やさない(絶対条件12)。Research(ResearchOptions)のような
      // Provider/Model差し込み口を持つとは限らないため、resolveした
      // provider/modelは強制注入せず記録のみに留める(呼び出し先の
      // 契約を推測しない)。Phase 4のテスト範囲では実際には到達しない
      // 経路(Decomposerがresearch以外を割り当てないため)だが、
      // Task.assignedCapabilityが将来他の値を持つ場合に備えて
      // Capability Registry経由の呼び出し自体は塞がない。
      // Phase 19: 単発の外部呼び出しであるため(research経路とは異なり
      // 内部に複数ステップを持たない)、一時的失敗のRetry対象にする。
      const { result, retried } = await withTemporaryFailureRetry(() =>
        invokeCapability<unknown, unknown>(
          task.assignedCapability!,
          { query: input, context: taskContext.coreContext },
          core
        )
      );

      return {

        taskId: task.id,

        status: "completed",

        capability: task.assignedCapability,

        provider,

        model,

        retried: retried || undefined,

        durationMs: Date.now() - startedAt,

        output:
          typeof result === "object" && result !== null && "answer" in result
            ? String((result as { answer: unknown }).answer)
            : JSON.stringify(result),

      };

    }

    // chat: Phase 7でrunChat()がProvider/Model上書きを受け取れるように
    // なったため、Model Routerの解決結果をそのまま渡す。
    // Phase 9: taskContext.coreContext(Phase 4のTask単位Memory-aware
    // Context Sharding、今回buildTaskContext()がchatタスクにも適用
    // されるよう変更した)をrunChat()へ渡す。Chat Handler自身は
    // retrievalを一切行わない(options.contextをsystem promptへ整形
    // するだけ、絶対条件8)。依存Taskの結果(input)は引き続き反映する。
    // Phase 19: chatはLLM呼び出し1回だけの単発経路のため、一時的失敗
    // (rate limit/network error等)のRetry対象にする。成功時
    // (retried===false)は既存(Phase18まで)と全く同じ経路・同じコスト。
    const { result: answer, retried } = await withTemporaryFailureRetry(() =>
      runChat(input, {
        provider,
        model,
        context: taskContext.coreContext,
      })
    );

    return {

      taskId: task.id,

      status: "completed",

      provider,

      model,

      retried: retried || undefined,

      // Phase 9: chatはResearchのようなusedKnowledgeIds等の「実際に
      // 引用したか」の検証機構を持たない(LLM応答テキストからの
      // 逆解析はしない、絶対条件8: 新しいロジックを追加しない)。
      // ここでのmemoryUsedは「system promptへ実際に注入された
      // (=taskContext.memoryReferencesとして取得済みの)候補」を表す
      // ——Researchの「Coreから実際に引用したことを検証済み」という
      // より厳密な意味とは異なることに注意(絶対条件7: 取得できな
      // かったことと存在しないことを混同しない、と同じ精神で、
      // 「注入した」と「LLMが実際に使った」も混同せず、ここでは
      // 前者だけを表す値であることをコメントで明示する)。
      memoryUsed: taskContext.memoryReferences,

      durationMs: Date.now() - startedAt,

      output: answer,

    };

  } catch (error) {

    return {

      taskId: task.id,

      status: "failed",

      capability: task.assignedCapability,

      provider,

      model,

      durationMs: Date.now() - startedAt,

      error: error instanceof Error ? error.message : String(error),

    };

  }

}

// =========================
// runTasks
// =========================
//
// dependenciesを尊重した波(wave)単位の並列実行。絶対条件7・10:
// 「並列実行すること」自体が目的ではなく、依存の無いTask同士は並列に
// 実行しつつ、依存があるTaskは前段の完了を待つ(critical pathの
// 尊重)。Promise.allに渡す各Task処理は例外を投げない
// (executeTask自身がtry/catchで守っているため)、1 Taskの失敗が
// Promise.all自体を失敗させることはない。
//
// Phase 4での変更点: 以前は全Taskへ同一のCoreContextを渡していたが、
// 各Taskの実行直前に、そのTask専用のTaskContext(buildTaskContext()、
// このTaskのdescriptionによるMemory retrieval + このTaskのdependencies
// にあたる完了済みTaskのoutputだけ)を構築してから実行する
// (絶対条件: 「全MemoryをすべてのAgentへ渡さない」「Task BにTask Aの
// 全Contextを渡さない」)。
//
// Phase 6での変更点: 1つのwave内で「準備完了(ready)」なTaskが
// governor.maxAgents()を超える数だけ同時に存在しても、実際に
// executeTask()(=Capability/Chat呼び出し、コストが発生する箇所)へ
// 進めるのは同時にmaxAgents件までに制限する。Promise.allで一括
// 起動する構造自体は変更しない(絶対条件: Promise.allを無制限に
// 発火させる実装にしない、というのはexecuteTask本体の同時実行数の
// 話であり、Promise自体の生成数を制限する話ではない——空き枠が無い
// Taskはgovernor.acquire()の中でイベント駆動に待機するだけで、
// busy loop等は発生しない)。dependency失敗によりcancelledとなる
// Taskはgovernor.acquire()を一切呼ばない(絶対条件9: dependency
// check→cancel判定→acquire不要、の順序を守る)。
export async function runTasks(
  tasks: Task[],
  core: CoreCapability,
  ownerParams: LoadContextParams,
  governor: ConcurrencyGovernor,
  attachmentEvidence: AttachmentEvidence[] = [],
  workspaceEvidence: LocalWorkspaceEvidence[] = []
): Promise<TaskExecutionSummary[]> {

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const summaries = new Map<string, TaskExecutionSummary>();
  const remaining = new Set(tasks.map((task) => task.id));

  while (remaining.size > 0) {

    const ready: Task[] = [];

    for (const id of remaining) {

      const task = taskById.get(id);

      if (!task) {
        continue;
      }

      const deps = task.dependencies ?? [];
      const unresolved = deps.filter((depId) => !summaries.has(depId));

      if (unresolved.length === 0) {
        ready.push(task);
      }

    }

    if (ready.length === 0) {

      // 依存関係が解決不能(循環参照、または存在しないTask IDへの
      // 依存)。無限ループを避けるため、残り全Taskをcancelledとして
      // 打ち切る。Phase 3以降のDecomposerは常に解決可能な
      // dependenciesしか生成しないため、通常この分岐には到達しない
      // (将来LLMベースDecomposerを導入した際の安全弁)。
      for (const id of remaining) {

        const task = taskById.get(id);

        summaries.set(id, {
          taskId: id,
          status: "cancelled",
          capability: task?.assignedCapability,
          error: "unresolved dependency (cycle or missing dependency)",
        });

      }

      break;

    }

    await Promise.all(
      ready.map(async (task) => {

        const deps = task.dependencies ?? [];

        const failedDep = deps.find(
          (depId) => summaries.get(depId)?.status !== "completed"
        );

        if (failedDep) {

          // 絶対条件17: 依存先が失敗した場合、このTaskは実行せず
          // cancelledとして記録する(実行しないため追加コストは
          // 発生しない。TaskContext構築(Memory retrieval)も行わない)。
          summaries.set(task.id, {
            taskId: task.id,
            status: "cancelled",
            capability: task.assignedCapability,
            error: `dependency task ${failedDep} did not complete successfully`,
          });

          return;

        }

        // このTaskのdependenciesに該当する完了済みsummaryだけを
        // 集める(他Taskの結果は一切渡さない、絶対条件6)。
        const dependencySummaries = deps
          .map((depId) => summaries.get(depId))
          .filter((summary): summary is TaskExecutionSummary => !!summary);

        // Governorの責務はTaskContext構築(Memory retrieval、Core
        // への軽量なDB読み取り)には及ばない(Phase 6絶対条件2:
        // Governor自身はMemory retrievalを判断しない)。実行枠が
        // 必要になるのは、実コスト(LLM/Capability呼び出し)が発生する
        // executeTask()だけ。
        //
        // Phase 8 Reality Testで発見・修正した不具合: buildTaskContext()
        // (Memory retrieval)がtry/catchで守られておらず、Core側が
        // 例外を投げた場合(例: organizationId等の未実装scopeが誤って
        // 渡された)、この1 Taskの失敗のはずが、外側のPromise.all全体を
        // rejectさせ、Orchestration全体を無条件にクラッシュさせて
        // いたことを実データで確認した(絶対条件17「1 Taskの失敗が
        // 他Taskへ伝播しない」への違反)。executeTask()と同じ設計
        // (例外を外へ投げず、status:"failed"として表現する)を
        // buildTaskContext()の呼び出しにも適用する。
        let taskContext;

        try {

          taskContext = await buildTaskContext(
            task,
            core,
            ownerParams,
            dependencySummaries
          );

        } catch (error) {

          summaries.set(task.id, {
            taskId: task.id,
            status: "failed",
            capability: task.assignedCapability,
            error:
              `task context build failed: ` +
              (error instanceof Error ? error.message : String(error)),
          });

          return;

        }

        const lease = await governor.acquire();

        let summary: TaskExecutionSummary;

        try {

          summary = await executeTask(task, core, taskContext, attachmentEvidence, workspaceEvidence);

        } finally {

          // 絶対条件3: 成功・失敗・例外の全経路でreleaseされること。
          // executeTask()自体は例外を外へ投げない設計(絶対条件17)だが、
          // 万一の想定外の例外(taskContext構築後・実行前のバグ等)でも
          // finallyによりleaseは必ず解放される。
          lease.release();

        }

        summaries.set(task.id, summary);

      })
    );

    for (const task of ready) {
      remaining.delete(task.id);
    }

  }

  // 呼び出し元の可読性のため、Decomposerが返した元の順序で返す。
  return tasks.map(
    (task) =>
      summaries.get(task.id) ?? {
        taskId: task.id,
        status: "cancelled",
        capability: task.assignedCapability,
        error: "task was never scheduled",
      }
  );

}
