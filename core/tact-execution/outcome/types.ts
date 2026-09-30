// =========================
// TACT Canonical Execution — Outcome Domain Types (SOR-119)
// =========================
//
// 絶対条件(SOR-119指示、最重要): Execution.status(技術的に処理が
// 成功/失敗したか)とOutcome(現実・業務・対象の状態がどう変わったか)は
// 絶対に混同しない。status="succeeded"であってもOutcomeがunknownの
// ままであることは正常な状態である(Never Guess Rule)。
//
// core/tact-execution/correlation/types.tsと同じ設計:
// summary(親tact_canonical_executions.outcome_status/outcome_kind)+
// append-only履歴(tact_execution_outcomes)。

import { EXECUTION_OUTCOME_STATUSES, type ExecutionActorKind, type ExecutionOutcomeStatus } from "../types";
import type { JsonValue } from "../../tact-work/approvalIntegrity";

// ExecutionOutcomeStatus("unknown"|"asserted")は../types.tsで定義される
// (CanonicalExecution.outcomeStatusと同じ型を共有する、
// core/tact-execution/correlation/types.tsがExecutionCorrelationStatusを
// ../types.tsから再利用するのと同じ規約)。tact_execution_work_
// correlationsの"pending"(履歴行を持たない)とは異なり、Outcomeの
// "unknown"履歴行(「確認を試みたが判断できなかった」)は正当な履歴
// エントリになりうるため、summary列と履歴rowの両方で同じ2値をそのまま
// 使う(narrowingした別型は不要)。
export { EXECUTION_OUTCOME_STATUSES, type ExecutionOutcomeStatus };

// tact_execution_work_correlations.methodと同じ設計思想: 誰が/何が
// この事実を主張したかを区別する。"adapter_asserted"はAdapterが自身の
// 確立した知識から明示的に主張した事実(例: Notion MCP adapterが
// UPDATE_PAGE操作の成功を確認した場合)。"manual_override"は人間による
// 訂正(human correction可能性を最初から塞がない、絶対条件)。
export type ExecutionOutcomeMethod = "adapter_asserted" | "manual_override";

export const EXECUTION_OUTCOME_METHODS: readonly ExecutionOutcomeMethod[] = [
  "adapter_asserted",
  "manual_override",
];

// =========================
// ExecutionOutcome (persisted domain type, tact_execution_outcomesの1行)
// =========================

export interface ExecutionOutcome {

  id: string;

  executionId: string;

  status: ExecutionOutcomeStatus;

  // status="asserted"の場合のみ非null(絶対条件、Never Guess Rule)。
  // provider/operationごとに際限なく増える自由記述語彙(例:
  // "email_sent"、"page_updated"、"pull_request_created")——CHECK制約
  // 付きenumにしない(provider固有知識をCore schemaへ持ち込まない)。
  outcomeKind: string | null;

  // 人間向けの短い要約のみ(絶対条件: raw provider payload本文を新たに
  // 常時保存しない、500文字上限)。
  summary: string | null;

  // このOutcomeが実際に(TACTが生成した)core/tact-artifactのArtifactと
  // 対応する場合のみ非null。既存Artifactモデルをそのまま再利用する
  // (新しい成果物構造は作らない)。
  artifactId: string | null;

  method: ExecutionOutcomeMethod;

  reasonCode: string | null;

  assertedByActorKind: ExecutionActorKind | null;

  assertedByActorId: string | null;

  metadata: JsonValue | null;

  assertedAt: string;

}

// =========================
// AssertExecutionOutcomeInput (Adapter/Human correction → Validation →
// Persistenceの境界を越える、検証済み入力DTO)
// =========================

export interface AssertExecutionOutcomeInput {

  executionId: string;

  status: ExecutionOutcomeStatus;

  // status="asserted"なら必須、status="unknown"なら省略(検証層が
  // 強制する、DB CHECK制約と同じ規律)。
  outcomeKind?: string | null;

  summary?: string | null;

  artifactId?: string | null;

  method: ExecutionOutcomeMethod;

  reasonCode?: string | null;

  assertedByActorKind?: ExecutionActorKind | null;

  assertedByActorId?: string | null;

  metadata?: JsonValue | null;

}

export type { JsonValue };
