// =========================
// TACT Orchestrator — Orchestration Contract (Phase 1)
// =========================
//
// 目的: Memory-aware Dynamic Agent Orchestratorの外部契約(入力/出力の型)
// だけを定義する。実行ロジック(Task分解・並列実行・Verification等)は
// このPhaseでは一切実装しない。
//
// 依存方向: core/tact-core(Memory)・core/tact-intent(Intent)・
// core/agent(Provider)・core/llm(Usage/Cost)という、既に確立済みの
// 「新TACT系列」の型のみを再利用する。core/workflow・core/agents・
// core/planner・core/conversation(Legacy Workflow Engine)は一切
// importしない。
//
// 既存資産の再利用(調査結果、詳細は本STEPの投資調査・設計差分報告を
// 参照):
//   - Memory参照      → core/tact-core(CoreMemory/KnowledgeItem/Example)
//   - Capability分岐  → core/tact-core/capabilities/registry.ts
//                        (invokeCapability。research/designは既に
//                        registerCapability済み。Orchestrator自身も
//                        将来ここへ登録される1つの「能力」になりうる)
//   - Intent          → core/tact-intent/types.ts(TactIntent、STEP216)
//   - Provider         → core/agent/types.ts(Provider、既存唯一の
//                        Provider列挙)
//   - Usage/Cost       → core/llm/types.ts(LLMUsage/LLMCost、Legacy
//                        WorkflowのExecutionRecord.costと同じ形状を
//                        既に踏襲している既存型)
//
// 新しい型は「既存のどれとも重ならない概念」にのみ追加する
// (MemoryReference・TaskExecutionSummary等)。

import type { TactIntent } from "../tact-intent/types";
import type { Provider } from "../agent/types";
import type { LLMUsage, LLMCost } from "../llm/types";
import type { AttachmentEvidence } from "../tact-attachment/types";
// LW-P3: attachmentEvidenceと並行する、Local Workspace由来の
// Evidence(type-onlyのimportのため、Browser固有実装への依存は生じない)。
import type { LocalWorkspaceEvidence } from "../tact-context-source/localWorkspace/types";
// Phase A(Capability Invocation Decoupling): CapabilityInvocationRequest
// が「Taskごとに絞り込み済みのCoreContext」を表すために使う。
import type { CoreContext } from "../tact-core/context/types";

// =========================
// Memory Reference
// =========================
//
// Orchestratorが1回の実行で「参照した」Core上のデータへのポインタ。
// CoreMemory/KnowledgeItem/Exampleの中身を複製しない
// (core/tact-core/execution/types.tsのCoreExecution.relatedExecutionRecordId
// と同じ考え方: 実体は既存Coreのテーブル/型に残したまま、参照だけを
// 持つ)。UIやExecution Logは、このid+kindで元のCoreデータへ
// 引けることを前提にする。
export type MemoryReferenceKind = "memory" | "knowledge" | "example";

// core/tact-core/memory/types.tsのMemoryScopeとcore/tact-core/knowledge/
// types.tsのKnowledgeScopeは、値の集合としては同一("user"|
// "organization"|"project"|"conversation")だが、それぞれ独立した
// interfaceとして定義されている(knowledge/types.ts冒頭コメント:
// 「他モジュールとの循環参照を避け、各Core概念モジュールを自己完結
// させるため」)。MemoryReferenceはmemory/knowledge/example全種類を
// 横断して参照するため、片方の型に寄せず同じ理由でここでも独立した
// 値の集合として再定義する。
export type CoreReferenceScope =
  | "user"
  | "organization"
  | "project"
  | "conversation";

export interface MemoryReference {

  kind: MemoryReferenceKind;

  id: string;

  scope: CoreReferenceScope;

  // どの程度この実行に関連していたか(0〜1)。Retrieval側
  // (mockCoreCapability.ts/supabaseCoreCapability.tsの簡易relevance
  // scorer)が算出できる場合のみ設定する。算出できない場合は
  // undefinedのまま(推測で埋めない)。
  relevance?: number;

}

// =========================
// Tool Execution Summary
// =========================
//
// core/tools/types.tsのToolResultをそのまま使わない理由: ToolResultは
// 「1回のTool呼び出しの生の戻り値」(dataを含む)であり、Orchestrator
// Resultに載せる要約としては重すぎる。ここではTool呼び出しが
// 「あったこと」と「成否」だけを持つ軽量な要約とし、実データは
// 各Taskの実行結果(将来のTask実行ログ)側に残す。
export interface ToolExecutionSummary {

  toolId: string;

  taskId?: string;

  success: boolean;

  durationMs?: number;

  error?: string;

}

// =========================
// Verification Summary
// =========================
//
// STEP(本Orchestrator設計)絶対条件12: Verificationは必須ではない。
// 「実行されなかった」場合はOrchestrationResult.verification自体が
// undefinedになる(この型はVerificationが実際に実行された場合の
// 結果だけを表す)。
export interface VerificationSummary {

  verified: boolean;

  verifiedBy?: string;

  issues?: string[];

  confidence?: "low" | "medium" | "high";

}

// =========================
// Orchestration Request
// =========================
//
// 設計時の指示例ではuserId: stringだったが、既存Route
// (app/api/tact/research/route.ts・app/api/tact/core/push/route.ts)は
// クライアント入力のuserIdを信頼せず、getCurrentUserContext()が
// server側で検証した値だけを使う既存方針を持つ。Orchestratorが
// 実際にAPI化される際も同じ方針を踏襲する前提のため、ここでは
// userIdをoptionalとし、「クライアントがこの型を組み立てて送る」
// 用途ではなく「server側で検証済みの値を詰めて渡す」用途の型として
// 定義する(既存2 Routeと同じ整合性)。
export interface OrchestrationRequest {

  userId?: string;

  projectId?: string;

  organizationId?: string;

  input: string;

  // 省略時、Orchestrator自身がcore/tact-intent/ruleRouter.tsの
  // classifyIntent()相当の判定を行う想定(Phase 1時点では未実装)。
  // 呼び出し元(将来のResearchSection.tsx等)が既に判定済みの場合は
  // ここに渡すことで二重判定を避けられる。
  intent?: TactIntent;

  conversationId?: string;

  attachmentEvidence?: AttachmentEvidence[];

  // LW-P3: client-side Workspace Context Resolverが既にbound済みの
  // Local Workspace Evidence。attachmentEvidenceと同じ位置づけで
  // Task実行(research capability)へ渡す。
  workspaceEvidence?: LocalWorkspaceEvidence[];

  // Phase86: 直前Turnのuser発言(存在する場合のみ)。decomposeTask()が
  // classifyIntent()へ渡し、「具体例を5件追加で確認してください」の
  // ような、単独では研究/雑談どちらとも解釈できる追加調査要求を、
  // 直前Turnが実際にResearchだった場合に限りResearchとして扱うために
  // 使う(Section3「Conversation Contextを利用する」)。新しいMemory/
  // Context Architectureは追加しない——呼び出し元(core/tact-conversation/
  // orchestration.tsのrunNormalTurn())が既存のgetConversationMessages()/
  // findPrecedingUserInput()(Phase68で確立済み)で取得した値をそのまま
  // 詰めるだけの、単純な文字列受け渡し。省略時は既存(Phase1〜85)と
  // 完全に同じ挙動になる(後方互換)。
  previousUserInput?: string;

  // Phase90(Structured Research Dataset Section4〜6): Table要求を
  // 事前検知できた場合の列構成・要求件数。呼び出し元
  // (core/tact-conversation/orchestration.tsのrunNormalTurn()/
  // runSupplementalResearchForArtifact())が既存のhasTableIntent()・
  // classifyTablePurpose()・parseComparisonColumns()・
  // parseRequestedRowCount()(core/tact-conversation/artifactMutation.ts、
  // Phase79〜85で確立済み)を合成したbuildResearchTableSchema()の
  // 結果をそのまま渡す。tact-orchestrator/tact-researchはtact-conversation
  // に依存できない(既存の一方向依存)ため、型はここで独立して同じ
  // 形を宣言するだけで、ロジックの共有・importは行わない。
  // decomposeTask()がcapability="research"のTaskにのみ引き継ぎ、
  // Research Prompt(assembleResearchContext())へ注入される。省略時は
  // 既存(Phase1〜89)と完全に同じ挙動(後方互換)。
  tableSchema?: {
    columns: string[];
    requestedRowCount?: number;
  };

  constraints?: {

    maxAgents?: number;

    maxCost?: number;

    maxLatencyMs?: number;

  };

}

// =========================
// Task Execution Summary / Memory Write Outcome(前方参照)
// =========================
//
// 本体の定義はcore/tact-orchestrator/task.ts(Phase 2)・
// memoryWriter.ts(Phase 5)に置く。OrchestrationResultがこれらの
// 実行結果一覧を持つ必要があるため、型だけをここでimportする
// (循環参照にはならない: task.ts/memoryWriter.tsはこのファイルを
// importしない)。
import type { TaskExecutionSummary } from "./task";
import type { MemoryWriteOutcome } from "./memoryWriter";
import type { LearningSignal } from "./evaluation";

// =========================
// Capability Invocation Contract (Architecture Migration Phase A:
// Capability Invocation Decoupling)
// =========================
//
// 背景: executor.ts(executeTask())には従来
// `if (task.assignedCapability === "research") { ... }`という
// 文字列直書きの分岐があり、その中でOrchestratorがResearchParams
// (core/tact-research/types.ts)の内部構造(options.llmProvider/
// llmModel/tableSchema等)を直接組み立て、戻り値のResearchResultの
// フィールド(evidence/keyFindings/presentations等)を直接読んで
// TaskExecutionSummaryへ転記していた。「research以外の登録済み
// Capability」は全く別の、貧弱な経路(query/contextのみ・Provider/
// Model未伝達)を通っており、Capability名によって扱いが非対称
// だった。
//
// 目的: Orchestrator → Capability Registry
// (core/tact-core/capabilities/registry.ts) → Capability、という
// 経路をCapability名に関わらず単一化する。この2つの型は、
// Orchestrator(executor.ts)がCapability名を問わず構築できる
// 「入力」と、Capability側(の薄いAdapter、例:
// core/tact-research/capabilityAdapter.ts)から受け取ってよい
// 「出力」を表す、Orchestrator自身の語彙。個々のCapabilityの公開型
// (ResearchParams/ResearchResult・DesignParams/DesignResult)は
// 変更しない——executor.tsはそれらを一切importせず、この語彙だけを
// 扱う。
export interface CapabilityInvocationRequest {

  query: string;

  // Taskごとに絞り込み済みのCoreContext(taskContext.coreContext)を
  // そのまま渡す。
  context: CoreContext;

  provider?: Provider;

  model?: string;

  attachmentEvidence?: AttachmentEvidence[];

  workspaceEvidence?: LocalWorkspaceEvidence[];

  // Phase90由来。research以外のCapabilityは無視してよい。
  tableSchema?: {
    columns: string[];
    requestedRowCount?: number;
  };

}

// TaskExecutionSummary(task.ts)が既に持つ語彙をそのまま再利用する
// (絶対条件: Researchの結果フィールド名・型は一切変えない。新しい
// フィールド名を増やさない)。taskId/status/capability/durationMs/
// retried/provider/modelはexecutor.ts自身が決定する制御情報のため
// 対象外とする。
export type CapabilityInvocationResult = Partial<
  Pick<
    TaskExecutionSummary,
    | "memoryUsed"
    | "researchExecutionMode"
    | "evidenceCount"
    | "evidence"
    | "keyFindings"
    | "answerConfidence"
    | "uncertaintyNote"
    | "presentations"
    | "presentationWarnings"
    | "presentationRequested"
    | "frameworkArtifacts"
    | "frameworkArtifactRequested"
    | "analysisArtifactPlan"
    | "cortexArtifactPlanRequested"
  >
> & {

  success: boolean;

  output?: string;

  errorMessage?: string;

};

// =========================
// Orchestration Result
// =========================
//
// 設計時の指示例ではagents: AgentExecutionSummary[]だったが、
// 本Orchestratorの中核方針(「AgentがTaskを持つのではなく、Taskに
// 対してAgentを割り当てる」、Phase 2参照)に合わせ、実行結果の単位も
// Task中心にする。各TaskExecutionSummaryが「どのAgent/Provider/Model
// が割り当てられたか」を保持するため、Agent単位の情報が失われる
// わけではない。
// Phase 15: ambiguityDetector.tsが「対象が完全に不明」と判定した場合に
// 返す、最小限のClarification要求。Task失敗(failed/cancelled)とは
// 明確に区別する(絶対条件5: Clarificationは「Taskの失敗」ではない)。
// 既存の戻り値型(TaskExecutionSummary等)では自然に表現できない
// 新しい概念(「そもそも実行前で停止した」)であるため、最小限の新型
// として定義する(絶対条件: 将来のためだけの抽象化はしない、
// questionの1フィールドのみ)。
export interface ClarificationRequest {

  question: string;

}

export interface OrchestrationResult {

  answer: string;

  executionId: string;

  tasks: TaskExecutionSummary[];

  memoryUsed: MemoryReference[];

  toolsUsed: ToolExecutionSummary[];

  verification?: VerificationSummary;

  // Phase 15: 設定されている場合、Task分解・実行は一切行われて
  // いない(tasks=[]・memoryUsed=[]・memoryWrites=[]のまま)。answerには
  // question文字列をそのまま複製する(既存のresult.answerだけを見る
  // 呼び出し元が更新無しでも自然に質問を表示できるようにするため、
  // 後方互換性を優先した設計)。
  clarification?: ClarificationRequest;

  // Phase 5: Task結果から生成・評価・(採用された場合)実際に書き込んだ
  // Memory Candidateの一覧。書き込みに失敗しても本体のtasks[].status
  // には一切影響しない(絶対条件、commander.tsの呼び出し順序でも
  // 構造的に保証している)。Candidateが1件も生成されなかった場合は
  // 空配列(undefinedにはしない、「何も対象が無かった」ことを明示する)。
  memoryWrites: MemoryWriteOutcome[];

  // Phase 28: Phase27のevaluateTaskExecution()(evaluation.ts)を
  // tasks[]の各要素へ適用した結果。commander.tsが実行結果を確定させた
  // 直後にmap()するだけの、単純な派生値(絶対条件: DB永続化しない、
  // 新しいEvaluationオブジェクトを作らない)。tasksと同じ順序・同じ
  // 長さを保つ(既存のtasks/summariesの対応関係と同じ規約)。
  // Clarification経路(tasks=[]のまま)では、Task単位のSignalモデルが
  // 適用できないため、["clarification_required"]という1要素配列を
  // 特別に設定する(Phase15の既存設計上、Clarification自体は
  // TaskExecutionSummaryを1件も生成しないため、tasks.map()では
  // 自然には導出できない、絶対条件: Clarificationのためだけに大規模な
  // 型変更をしない、という制約の範囲内での最小対応)。
  //
  // 重要: この配列はruntimeで観測可能にするためだけの値であり、
  // Commander/Executor/Model Router/Retry/Memory Retrieval/Memory
  // Write/Aggregationのいずれの判断にも一切使用しない(絶対条件、
  // Reflection/Learning Policyは今回実装しない)。
  learningSignals: LearningSignal[];

  metadata: {

    // "single-llm" | "parallel-tasks" | "sequential-tasks" 等。固定enumに
    // せず自由文字列とする(core/tact-core/execution/types.tsの
    // CoreExecution.capabilityと同じ理由: 実行モードの分類自体が
    // まだ確定していないため)。
    executionMode: string;

    provider?: Provider;

    model?: string;

    usage?: LLMUsage;

    cost?: LLMCost;

    durationMs?: number;

  };

}
