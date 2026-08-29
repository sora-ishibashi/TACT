// =========================
// TACT Agent — Domain Types(Agent Handoff基盤)
// =========================
//
// 目的: 複数の開発Agent(Claude Code、Codex、将来の他Agent)が同一
// プロジェクトを継続して開発するための、状態管理・引き継ぎの
// 最小Domain Model。
//
// 依存方向の確認(既存のcore/tact-*系列と同じ一方向依存の方針):
// このファイル、およびcore/tact-agent/配下のどのファイルも、
// core/workflow・core/agents・core/planner(Legacy Workflow Engine)を
// 一切importしない。core/codeAgent/(STEP142〜、単一CodeTaskの
// 実行・Git安全弁)とも独立しており、core/codeAgent側を変更しない
// (Repository Evidence: core/codeAgent/types.tsのCodingAgentAdapter・
// core/codeAgent/adapterRegistry.tsのgetCodingAgentAdapter()は既に
// 「交換可能な実行エンジン境界」を提供済みで、adapterRegistry.tsの
// コメントには"codex" → 将来と明記されている。ここではその既存
// 拡張点をそのまま尊重し、core/codeAgent自体は変更しない)。
//
// 既存core/tact-orchestrator/task.tsのTask/TaskStatus(1回の
// Orchestration実行内の短命なSub-task)とは意図的に別の概念として
// 分離する。DevelopmentTaskは「Phase単位で複数のAgentセッションに
// またがる、長命な開発作業」を表す、より上位の概念であり、
// Orchestratorの実行単位を再利用しない(責務が異なるため)。
//
// Provider名(Claude Code / Codex等)をDomain Logicにハードコードし
// ない: AgentId/Provider/Capabilityはいずれも自由文字列とする
// (core/tact-core/capabilities/registry.tsのregisterCapability()が
// Capability名を閉じたUnion型にせず自由文字列で受け付けているのと
// 同じ設計判断。新しいAgentを追加するたびに型定義を変更する必要が
// ないようにする)。

// =========================
// DevelopmentTask
// =========================
//
// 「誰が、何を、どこまで進めたか」の対象そのもの(Phase単位の
// 開発作業1件)。

export type DevelopmentTaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed";

export type DevelopmentTaskPriority = "low" | "medium" | "high";

export interface DevelopmentTask {

  taskId: string;

  title: string;

  description: string;

  // 例: "Phase101"。TACT Research側のPhase番号と衝突してもよい
  // (別の作業系列であり、意図的に自由文字列とする)。
  phase?: string;

  status: DevelopmentTaskStatus;

  priority?: DevelopmentTaskPriority;

  // 現在の担当Agent(AgentRegistryのAgent.agentId)。未割り当ての
  // 場合はundefined。
  currentAgent?: string;

  startedAt?: string;

  updatedAt: string;

  completedAt?: string;

  createdAt: string;

}

// =========================
// Agent
// =========================
//
// 開発を実行する主体の抽象(Claude Code・Codex等)。Core側は
// Provider固有の実行方法を一切知らない(それはcore/codeAgent/の
// CodingAgentAdapter/CodingAgentProviderIdの責務のまま)。

export type AgentStatus =
  | "available"
  | "busy"
  | "unavailable"
  | "quota_exceeded";

export interface Agent {

  // 自由文字列。例: "claude-code" / "codex"。core/codeAgent/
  // adapterRegistry.tsのCodingAgentProviderIdと値を揃えられるが、
  // 型として結合はしない(Core側がCoding Agent固有の型に依存しない
  // ようにするため)。
  agentId: string;

  name: string;

  // 例: "anthropic" / "openai"。自由文字列(ハードコード禁止)。
  provider?: string;

  // 例: ["code_edit", "git", "test_execution"]。自由文字列のリスト。
  capabilities: string[];

  status: AgentStatus;

  registeredAt: string;

  updatedAt: string;

}

// =========================
// Git State(Handoffに埋め込む最小Git情報)
// =========================
//
// 実際のGit操作(status取得)はcore/codeAgent/gitProvider.tsの
// GitProvider.status()を再利用する(core/tact-agent/gitState.ts参照)。
// ここでは「どのcommitを基準に、どの変更状態で引き継いだか」を
// 記録するための最小の値の型のみを定義する(TACT Core自身が
// commit/pushを行う機能は今回作らない)。

export type WorkingTreeStatus = "clean" | "dirty";

export interface HandoffGitState {

  branch: string;

  lastCommit: string;

  workingTreeStatus: WorkingTreeStatus;

  // dirtyな場合の変更ファイル数(ファイル内容そのものは保持しない、
  // Handoff State肥大化を避けるため)。
  dirtyFileCount?: number;

  capturedAt: string;

}

// =========================
// Verification Status
// =========================
//
// 次のAgentが「何を確認済みなのか」を読める状態にする。

export type VerificationCheckName = "tsc" | "eslint" | "test" | "build";

export type VerificationCheckResult = "passed" | "failed" | "not_run";

export interface VerificationStatus {

  checks: Partial<Record<VerificationCheckName, VerificationCheckResult>>;

  // 自由記述(例: "609 tests passed, 0 failed")。
  detail?: string;

}

// =========================
// HandoffState
// =========================
//
// Agent交代1回分の記録。次のAgentが「何をやったか/何をやっていない
// か/何を確認済みか/どこから再開すればいいか」を読める状態にする
// (絶対条件、指示Step2)。

export type HandoffStatus = "pending" | "completed";

export interface HandoffState {

  handoffId: string;

  taskId: string;

  fromAgent: string;

  toAgent: string;

  reason: string;

  completedWork: string[];

  pendingWork: string[];

  verificationStatus: VerificationStatus;

  gitStatus: HandoffGitState;

  nextAction: string;

  status: HandoffStatus;

  createdAt: string;

  completedAt?: string;

}

// =========================
// Development State(集約View、Step4)
// =========================
//
// 「誰がどこまで進めたか」の正本。DevelopmentTask storeと
// HandoffState storeを合成して1回の呼び出しで取得できる、派生的な
// 読み取り専用View(それ自体を独立して永続化しない。3つ目の
// 状態ストアを新設しない)。

export interface DevelopmentState {

  currentTask: DevelopmentTask | undefined;

  currentPhase: string | undefined;

  currentAgent: string | undefined;

  completedWork: string[];

  pendingWork: string[];

  verificationStatus: VerificationStatus | undefined;

  gitStatus: HandoffGitState | undefined;

  lastCommit: string | undefined;

  nextAction: string | undefined;

  // Development Stateの元になった直近のHandoff(存在する場合)。
  latestHandoff: HandoffState | undefined;

}

// =========================
// Agent Usage / Quota(Step6、拡張点のみ)
// =========================
//
// 今回は実データ取得を実装しない(絶対条件)。将来、実際の
// Usage/Quota取得APIと接続するための型のみを用意する。

export interface AgentUsage {

  agentId: string;

  provider?: string;

  usage?: number;

  limit?: number;

  remaining?: number;

  resetAt?: string;

  cost?: number;

  recordedAt: string;

}

// =========================
// Agent Candidate(Phase111: Agent selection層の入力、拡張点のみ)
// =========================
//
// core/tact-agent/agentSelection.tsのselectCodingAgent()が判断材料と
// して受け取る、1つのCoding Agentの「今この瞬間の状態」。
//
// availabilityのみが今回実際に使われる(実測できる値)。cost/quota/
// performanceは将来selectCodingAgent()が評価できるようにするための
// 型のみの拡張点であり、Phase111では実データを取得しない
// (絶対条件: 実測できないものを推測値で埋めない)。selectCodingAgent()
// 自体もこれらのフィールドを今回は一切参照しない。
export interface AgentCandidate {

  agentId: string;

  // CodingAgentAdapter.isAvailable()(core/codeAgent/types.ts)が返す
  // 形とそのまま同じ形。CodeTask型全体は取り込まず、構造的に必要な
  // 最小限だけを受け取る(handoffTrigger.tsのAgentExecutionOutcomeと
  // 同じ設計判断、型としての強い結合を避ける)。
  availability: { available: boolean; detail: string };

  // 将来のCost評価用の拡張点(未実装、Phase111では常にundefined)。
  cost?: { estimatedCostPerTask?: number; currency?: string };

  // 将来のQuota評価用の拡張点(未実装、Phase111では常にundefined)。
  quota?: AgentUsage;

  // 将来のPerformance/failure history評価用の拡張点
  // (未実装、Phase111では常にundefined)。
  performance?: { recentSuccessRate?: number; recentFailureCount?: number };

}

// =========================
// Agent Handoff Store(永続化の交換可能な境界)
// =========================
//
// core/tact-core/types.tsのCoreCapability(loadContext等をDIで
// 差し替え可能にする既存パターン)と同じ設計判断。本番は
// Supabase実装(supabaseStore.ts)、Unit Testはin-memory実装
// (inMemoryStore.ts)を注入する。npm testから実DB(Supabaseの
// tact_memory、RLS Stage 0でanonキーから書き込み可能)へ誤って
// 書き込まないようにするための必須の境界。

export interface AgentHandoffStore {

  readonly id: string;

  saveTask(task: DevelopmentTask): Promise<void>;

  getTask(taskId: string): Promise<DevelopmentTask | undefined>;

  listTasks(limit?: number): Promise<DevelopmentTask[]>;

  saveHandoff(handoff: HandoffState): Promise<void>;

  getHandoff(handoffId: string): Promise<HandoffState | undefined>;

  // 指定Taskに紐づくHandoffをcreatedAt降順で返す(先頭が最新)。
  listHandoffsForTask(taskId: string): Promise<HandoffState[]>;

}
