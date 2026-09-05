import { createSupabaseCoreCapability } from "../tact-core/supabaseCoreCapability";
import { bootstrapTactCapabilities } from "../tact-bootstrap";
import { decomposeTask } from "./decomposer";
import { runTasks } from "./executor";
import { aggregateResults } from "./aggregator";
import { buildMemoryCandidates } from "./memoryCandidateBuilder";
import { writeMemoryCandidates } from "./memoryWriter";
import { createConcurrencyGovernor, resolveMaxAgents } from "./concurrencyGovernor";
import { detectAmbiguity } from "./ambiguityDetector";
import { evaluateTaskExecution } from "./evaluation";
import type { OrchestrationRequest, OrchestrationResult, OrchestrationHooks } from "./types";

// =========================
// runOrchestration (Phase 3, Commander入口。Phase 4でTaskContext対応、
// Phase 15でAmbiguity Detectionを追加)
// =========================
//
// 絶対条件11: 呼び出し側は常にrunOrchestration(request)だけを呼べば
// よい。Simple TaskかComplex Taskかの判断(single executionか
// parallel/sequential swarmか)はCommander自身(実際にはdecomposeTask()
// の判定結果)が行い、呼び出し元(将来のAPI Route/UI)に
// 「if complex then swarm」のような分岐を持たせない。
//
// 構成: bootstrap(Capability Registry初期化) → Task分解(decomposer.ts)
// → dependenciesを尊重した実行、Taskごとに独立したTaskContextを
// 構築・Concurrency Governorで同時実行数を制御(executor.ts→
// taskContext.ts/concurrencyGovernor.ts) → 集約(aggregator.ts) →
// Memory Candidate生成・採否判断・書き込み(Phase 5、
// memoryCandidateBuilder.ts→memoryPolicy.ts→memoryWriter.ts)。各
// ステップは独立したファイル/関数に切り出してあり、Commander自体は
// これらを順番に呼ぶだけの薄い層に留める。
//
// Phase 6での変更点: OrchestrationRequest.constraints.maxAgents
// (Phase 1で型のみ定義済み、今回初めて実接続)から実効上限を解決し、
// このOrchestration実行1回につき1つのConcurrencyGovernorを生成して
// runTasks()へ渡す。Governorはこの1回の実行内の全waveを通じて同じ
// インスタンスを使う(wave単位でリセットしない、Kimiのresource lease
// と同じ「実行全体を通した枠の管理」)。
//
// Phase 5での変更点: 集約(aggregateResults())の後に、Task結果から
// Memory Candidateを生成→評価→書き込む段階を追加した。この段階は
// 集約より後に実行されるため、Memory Write自体が失敗しても
// summaries(=tasks[].status、既に確定済み)には一切影響しない
// (絶対条件: Memory Write失敗でTask全体を失敗させない)。
//
// Phase 4での変更点: Phase 3はここで`core.loadContext()`を1回呼び、
// 得たCoreContext(そのユーザーの全Knowledge/Memory/Example)を全Taskへ
// 同一のまま渡していた。Phase 4のMemory-aware Context Sharding方針
// (「全MemoryをすべてのAgentへ渡さない」)により、この一括読み込みを
// 廃止し、Taskごとの絞り込み済みTaskContextをexecutor.ts側で構築する
// 形へ変更した。これにより、Core retrievalが不要なTask(例: 挨拶の
// chat)ではCoreへのDB問い合わせ自体が発生しなくなる(Case A)。
// Commanderはowner識別情報(userId等)をrunTasks()へそのまま引き渡す
// だけで、Retrieval自体には関与しない。
// Architecture Migration Phase B2: hooksは省略可能(既定undefined)。
// core/tact-work/(Canonical Work Model)がWork Execution Boundary
// (core/tact-work/execution.ts)経由でTask/Runの永続化のためだけに
// 利用する観測用コールバックであり、hooksを渡さない既存呼び出し元
// (Web/Botのどの経路も含め、Phase B2完了時点でまだ1つも存在しない
// —— core/tact-conversation/orchestration.tsがPhase B2でこの引数を
// 渡すようになる)は一切影響を受けない。
export async function runOrchestration(
  request: OrchestrationRequest,
  hooks?: OrchestrationHooks
): Promise<OrchestrationResult> {

  const startedAt = Date.now();

  // Phase 15: Task分解・Capability呼び出し・Memory retrievalのいずれも
  // 行う前に、決定論的なAmbiguity判定を1回だけ行う(絶対条件2: LLM
  // 呼び出しは追加しない、絶対条件9: LLM callを増やさない)。曖昧と
  // 判定された場合は、bootstrap・Core接続・Decomposer・Executor・
  // Memory pipelineのいずれにも到達せず、質問だけを返して停止する
  // (絶対条件5: Clarificationは「Taskの失敗」ではない。tasks=[]の
  // ままであり、failed/cancelledなTaskExecutionSummaryを一切生成
  // しない)。
  const ambiguity = detectAmbiguity(request.input);

  if (ambiguity.ambiguous && ambiguity.question) {

    return {

      answer: ambiguity.question,

      executionId: crypto.randomUUID(),

      tasks: [],

      memoryUsed: [],

      toolsUsed: [],

      clarification: { question: ambiguity.question },

      memoryWrites: [],

      // Phase 28: Clarification経路はTaskExecutionSummaryを1件も
      // 生成しないため(既存Phase15設計)、tasks.map()では自然に
      // 導出できない。evaluateTaskExecution()自身もclarification:true
      // 指定時は入力summaryの中身に関わらず"clarification_required"を
      // 返す設計(Phase27)のため、ここでは同じ結論を直接記述する。
      learningSignals: ["clarification_required"],

      metadata: {

        executionMode: "clarification-needed",

        durationMs: Date.now() - startedAt,

      },

    };

  }

  // core/tact-bootstrap.ts(STEP176/178)は"research"/"design"を
  // 既にregisterCapability済み。bootstrapTactCapabilities()は
  // 呼び出し済みなら即returnする既存の冪等実装であり、Orchestratorが
  // 呼んでも既存の登録内容を変更・上書きしない。
  bootstrapTactCapabilities();

  const core = createSupabaseCoreCapability();

  // STEP211のapp/api/tact/research/route.tsと同じ既存方針:
  // organizationId/projectId/conversationIdは、呼び出し元が実際に
  // 指定した場合のみそのまま渡す(supabaseCoreCapability.ts側が
  // User Scope以外を明示的にErrorにする既存契約を、Orchestrator側で
  // 迂回・黙殺しない)。実際の読み込みはTaskごとにexecutor.ts→
  // taskContext.tsが行う。
  const ownerParams = {
    userId: request.userId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    conversationId: request.conversationId,
  };

  const tasks = decomposeTask(request);

  // Phase B2: decomposeTask()の結果(description/dependencies/
  // assignedCapabilityを含む完全なTask[])を、実行開始前にhooksへ
  // 通知する。TaskExecutionSummaryにはdescription/dependenciesが
  // 含まれないため、Work Execution Boundaryがtact_tasksへ永続化
  // できるのはこの時点だけ。
  await hooks?.onTasksPlanned?.(tasks);

  const governor = createConcurrencyGovernor(
    resolveMaxAgents(request.constraints)
  );

  const summaries = await runTasks(
    tasks,
    core,
    ownerParams,
    governor,
    request.attachmentEvidence ?? [],
    request.workspaceEvidence ?? [],
    hooks
  );

  const { answer } = aggregateResults(tasks, summaries);

  const memoryUsed = summaries.flatMap((summary) => summary.memoryUsed ?? []);

  const toolsUsed = summaries.flatMap((summary) => summary.toolsUsed ?? []);

  // Phase 5: Task結果からMemory Candidateを生成する。tasksとsummaries
  // は常に同じ順序・同じ長さ(decomposer.tsが返した順序をrunTasks()が
  // 維持する、Phase 3の既存契約)であるため、インデックスで対応付ける。
  const memoryCandidates = tasks.flatMap((task, index) =>
    buildMemoryCandidates(task, summaries[index], request)
  );

  const memoryWrites = await writeMemoryCandidates(memoryCandidates, core);

  // Phase 28: Phase27のevaluateTaskExecution()をtasks[]の各要素へ
  // 適用するだけの、単純な派生値(絶対条件: LLM/DB呼び出みを増やさない、
  // 判断には使わない)。summariesと同じ順序・同じ長さを保つ
  // (memoryUsed/toolsUsedと同じ既存規約)。
  const learningSignals = summaries.map((summary) =>
    evaluateTaskExecution(summary)
  );

  const executionMode =
    tasks.length === 1
      ? "single-execution"
      : tasks.some((task) => (task.dependencies?.length ?? 0) > 0)
        ? "sequential-swarm"
        : "parallel-swarm";

  return {

    answer,

    executionId: crypto.randomUUID(),

    tasks: summaries,

    memoryUsed,

    toolsUsed,

    memoryWrites,

    learningSignals,

    metadata: {

      executionMode,

      durationMs: Date.now() - startedAt,

    },

  };

}
