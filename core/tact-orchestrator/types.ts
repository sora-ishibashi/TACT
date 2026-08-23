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
export interface OrchestrationResult {

  answer: string;

  executionId: string;

  tasks: TaskExecutionSummary[];

  memoryUsed: MemoryReference[];

  toolsUsed: ToolExecutionSummary[];

  verification?: VerificationSummary;

  // Phase 5: Task結果から生成・評価・(採用された場合)実際に書き込んだ
  // Memory Candidateの一覧。書き込みに失敗しても本体のtasks[].status
  // には一切影響しない(絶対条件、commander.tsの呼び出し順序でも
  // 構造的に保証している)。Candidateが1件も生成されなかった場合は
  // 空配列(undefinedにはしない、「何も対象が無かった」ことを明示する)。
  memoryWrites: MemoryWriteOutcome[];

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
