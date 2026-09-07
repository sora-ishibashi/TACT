// =========================
// TACT Orchestrator — Task Abstraction (Phase 2)
// =========================
//
// 中核方針: 「AgentがTaskを持つのではなく、Taskに対してAgentを割り当てる」。
// Legacy Workflow(core/workflow/*)はAgent(core/agents/*、9種の固定
// Agent定義)を中心にWorkflowのstepを組み立てる構造だが、
// Orchestratorでは逆に、まずTask(やるべきことの単位)を中心に置き、
// 各Taskへ「どのAgent的役割で・どのProvider/Modelで・どのCapabilityで
// 実行するか」を後から割り当てる。これにより、Task分解の結果に応じて
// 動的にAgent数・種類を変えられる(固定9 Agentへ縛られない)。
//
// 既存の名前衝突についての事実確認(コード変更はしない、報告のみ):
//   - core/orchestrator.ts・core/planner.ts・core/executor.ts・
//     types/task.ts・types/workflow.ts・types/agent.ts・types/result.ts
//     という一群のファイルが既に存在するが、grep調査の結果
//     (app/・components/・core/のいずれからも一切importされていない)、
//     どこからも参照されない未使用の初期プロトタイプだと判明した
//     (types/task.tsのTaskStatusは"waiting"|"planning"|"running"|
//     "completed"で、本ファイルのTaskStatusとは値も別)。
//     CLAUDE.mdの既存方針により、これらを「バグ」として削除・修正
//     はしない。名前の衝突を避けるため、Orchestrator関連の新規実装は
//     既存の`core/tact-*`命名規則を踏襲した`core/tact-orchestrator/`
//     配下に置く(core/orchestrator.tsは一切変更しない)。

import type { Provider } from "../agent/types";
import type { LLMUsage, LLMCost } from "../llm/types";
import type { MemoryReference, ToolExecutionSummary } from "./types";
import type { AnswerConfidence } from "./confidence";
import type { ResearchEvidenceItem } from "../tact-research/types";
import type { ResearchPresentation } from "../tact-analysis/presentation/types";
import type { ResearchFrameworkArtifact } from "../tact-analysis/framework/types";
import type { AnalysisArtifactPlan } from "../tact-analysis/composition";

// =========================
// Task
// =========================

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {

  id: string;

  description: string;

  parentTaskId?: string;

  status: TaskStatus;

  // このTaskが完了する前に完了していなければならない、他Taskのid。
  // Phase 5(並列実行)で依存関係グラフを構築する材料になる
  // (STEP絶対条件10: critical path最小化が目的であり、Agent数の
  // 最大化ではない)。
  dependencies?: string[];

  // Taskごとに必要な最小限のContext(STEP絶対条件6: 全Agentに全
  // Conversation/全Memoryを渡さない)。Phase 1-2時点では構造だけを
  // 持ち、実際のMemory retrieval絞り込みロジックは実装しない。
  context?: unknown;

  // どのCapability(core/tact-core/capabilities/registry.tsに
  // registerCapability済みの名前、例: "research"/"design")で
  // このTaskを実行するか。省略時はOrchestrator内蔵のChat Handler的な
  // 単発LLM実行(core/tact-intent/chatHandler.tsと同じ位置づけ)を
  // 想定する。既存のCapability Registryをそのまま再利用し、
  // Orchestrator独自の新しいCapability分岐機構は作らない。
  assignedCapability?: string;

  assignedModel?: string;

  assignedProvider?: Provider;

  // Phase90: decomposeTask()がOrchestrationRequest.tableSchemaから
  // 引き継ぐ(assignedCapability==="research"のTaskにのみ設定)。
  // executor.tsがResearchOptions.tableSchemaへそのまま橋渡しする。
  tableSchema?: {
    columns: string[];
    requestedRowCount?: number;
  };

}

// =========================
// Task Execution Summary
// =========================
//
// core/tact-orchestrator/types.tsのOrchestrationResult.tasksに載る、
// 1Task分の実行結果の要約。Taskそのもの(計画時点の情報)とは別に、
// 「実際に何が起きたか」を保持する(Task型に実行結果フィールドを
// 混在させない。core/context/types.tsのExecutionRecordが「実行前の
// 計画」と「実行後の記録」を1つの型に混在させ肥大化した反省を踏まえた
// 意図的な分離)。
export interface TaskExecutionSummary {

  taskId: string;

  status: TaskStatus;

  provider?: Provider;

  model?: string;

  capability?: string;

  usage?: LLMUsage;

  cost?: LLMCost;

  memoryUsed?: MemoryReference[];

  toolsUsed?: ToolExecutionSummary[];

  durationMs?: number;

  // STEP絶対条件13: 1 Agentが失敗しても、独立した他Agentまで失敗
  // 扱いにしない。errorはこのTask単体の失敗理由であり、他Taskの
  // TaskExecutionSummaryには影響しない。
  error?: string;

  // Phase 3で判明した不足フィールド: Phase 1-2設計時点では
  // TaskExecutionSummaryに「実際に生成された内容」を持たせていな
  // かったが、Aggregator(複数Taskの結果を1つのOrchestrationResult.answer
  // へ統合する責務)が各Taskの出力そのものを読めないと集約できない
  // ことが実装時に判明したため追加した。失敗/未実行(cancelled)の
  // 場合はundefinedのまま。
  output?: string;

  // Phase 19: chat/その他Capability実行がLLMProviderErrorの一時的な
  // 理由(quota_exceeded/rate_limited/network_error)で失敗し、
  // Executorが最大1回まで自動的に再試行して成功した場合のみtrueに
  // なる。永続的な失敗判定・DB永続化のためのフィールドではなく、
  // 「この成功はretryを経たものである」ことを呼び出し元(ログ・UI)が
  // 追跡できるようにするための最小限の観測用フィールド。retryが
  // 発生しなかった場合(通常の成功・失敗いずれも)はundefinedのまま
  // (絶対条件: 新しい永続schemaを作らない、既存の成功/失敗の意味を
  // 変えない)。
  retried?: boolean;

  // Phase 5で判明した不足フィールド: Memory Candidate Builder
  // (memoryCandidateBuilder.ts)が「このResearch結果はCoreに既に
  // あった情報の再掲か、Web検索で得た新しい情報か」を区別する必要が
  // あるが、TaskExecutionSummaryにはResearchMetadata.executionMode
  // (core/tact-research/types.ts、"core-only"|"web-research")が
  // 反映されていなかった。research以外のTask、またはresult取得前は
  // undefinedのまま。
  researchExecutionMode?: "core-only" | "web-research";

  // 同じくPhase 5で追加。Research結果に紐づくEvidence件数
  // (ResearchResult.evidence.length)。根拠が無いAgent発言をMemoryへ
  // 昇格させない(絶対条件9)ための判定材料として使う。research以外の
  // Taskではundefinedのまま。
  evidenceCount?: number;

  // Phase76(Repository Evidence): ResearchResult.evidence自体
  // (id/claim/source/confidence/snippet)。これまでevidenceCount
  // (件数のみ)へ潰されて実データが破棄されていたことが判明した
  // (core/tact-orchestrator/executor.tsのexecuteTask())。TACT Artifact
  // (core/tact-artifact/*)のEvidence Block構築に使う。research以外の
  // Task、またはTask失敗時はundefinedのまま。
  evidence?: ResearchEvidenceItem[];

  // Phase76: ResearchResult.keyFindings(web-research経路でのみ、
  // LLMが既に生成済みの重要事実リスト)をそのまま透過する。新しいLLM
  // 呼び出しは発生しない。research以外のTask、core-only経路、
  // Task失敗時はundefinedのまま。
  keyFindings?: string[];

  // Phase 21: confidence.tsのderiveAnswerConfidence()が
  // ResearchResultから決定論的に算出した、この回答がEvidence全体に
  // よってどの程度裏付けられているかの離散Signal。研究Taskが失敗した
  // 場合(status !== "completed")、またはresearch以外のTaskでは
  // undefinedのまま(絶対条件5: Task実行成否(status)や個々のEvidence
  // confidenceと混同しない、独立したフィールドとして扱う)。
  answerConfidence?: AnswerConfidence;

  // Phase 21: ResearchResult.uncertainty(Research LLMが既に生成して
  // いた、確認できなかった点の自然文申告)をそのまま透過する。新しい
  // LLM呼び出しではない。web-research経路でLLMがuncertaintyを申告した
  // 場合のみ設定され、それ以外はundefinedのまま。
  uncertaintyNote?: string;

  /** Dataset-derived presentation candidates from canonical Research only. */
  presentations?: ResearchPresentation[];

  presentationWarnings?: import("../tact-analysis/types").ValidationIssue[];

  presentationRequested?: boolean;
  frameworkArtifacts?: ResearchFrameworkArtifact[];
  frameworkArtifactRequested?: boolean;
  analysisArtifactPlan?: AnalysisArtifactPlan;
  cortexArtifactPlanRequested?: boolean;

  // Architecture Migration Phase B3(Approval Execution): Capability
  // (のAdapter)が、このTaskの結果を実際に使う前に人間の承認が必要だと
  // 判断した場合にのみ設定する、Provider非依存の抽象的なsignal。
  // Research固有ではなく、将来どのCapabilityも使いうる汎用フィールド
  // として他のTaskExecutionSummaryフィールドと同じ「pure value
  // object」方式で追加する(絶対条件: OrchestratorへApproval判断
  // ロジックやSupabase依存を持ち込まない——Orchestrator自身はこの
  // フィールドの値をそのまま透過するだけで、意味を解釈しない。実際に
  // Approvalを作りWorkをwaiting_for_approvalへ遷移させるのは
  // core/tact-work/execution.tsの責務)。
  approvalRequirement?: TaskApprovalRequirement;

  // Architecture Migration Phase C2.2(Read/Write Policy): Integration
  // Capability(core/tact-integration/)専用の、canonical integration
  // actionを一度だけ表現するsignal。上のapprovalRequirementは
  // Integration以外の将来Capabilityも使いうる汎用機構のまま維持し
  // (絶対条件: 既存の非Integration用途を壊さない、
  // tests/tact/work/execution.test.tsのkind="external_write_test"参照)、
  // Integration Capabilityはこちらだけを返す——同じcanonical action
  // payloadをapprovalRequirementとintegrationRequirementの両方へ
  // 二重に持たせない(ユーザー指示Correction2、source-of-truthの
  // 二重化を避けるため)。requiresApprovalはCapability自身が
  // core/tact-integration/policy.tsのriskClassから導出済みの値を
  // そのまま運ぶ(Orchestrator自身はpolicy判断を一切行わない)。
  integrationRequirement?: TaskIntegrationRequirement;

}

// Architecture Migration Phase B3: Approval対象となる提案actionの
// 抽象的な記述。Provider固有のフィールド(例: slackChannelId・
// gmailMessageId等)は一切含めない——「何を・なぜ承認してほしいか」を
// 人間が読める形で表すだけの、Provider非依存の最小限の形。
export interface TaskApprovalAction {

  kind: string;

  summary: string;

  metadata?: Record<string, unknown>;

}

export interface TaskApprovalRequirement {

  reason: string;

  action?: TaskApprovalAction;

}

// Architecture Migration Phase C2.2: Integration Capabilityが返す、
// canonical integration actionとpolicy判定結果(requiresApproval)を
// 一度だけ表現する最小shape。actionはTaskApprovalActionをそのまま
// 再利用する(新しいaction表現を増やさない、絶対条件Correction2)。
// requiresApproval===trueの場合のみreasonが意味を持つ(Approval作成
// 時にそのままreasonとして使われる)。

// Architecture Migration ARCH-P1b: core/tact-integration/policy.tsの
// IntegrationRiskClassと同じ3値。core/tact-work/execution.tsが
// core/tact-integration/を一切importできない(逆方向依存を作らない、
// 既存絶対条件)ため、値のunionとして独立に再宣言する——
// core/tact-work/execution.tsのExecuteReadIntegrationActionOutcomeが
// 既に使っている「値だけを再宣言する」既存パターンと同じ。
export type TaskIntegrationRiskClassSnapshot = "read" | "write" | "destructive";

export interface TaskIntegrationRequirement {

  requiresApproval: boolean;

  reason?: string;

  action: TaskApprovalAction;

  // Architecture Migration ARCH-P1b: このrequirementを判定した時点の
  // canonical risk classification(core/tact-integration/policy.tsの
  // resolveIntegrationActionPolicy()が返したriskClassをそのまま運ぶ)。
  // Approval Subject(core/tact-work/approvalIntegrity.ts)の
  // riskClassSnapshotへ渡すためだけの値であり、Policy全体を
  // version-bindするものではない(execution時は引き続き既存Policyを
  // 再評価する、docs/architecture/approval-integrity.md参照)。
  riskClass?: TaskIntegrationRiskClassSnapshot;

}
