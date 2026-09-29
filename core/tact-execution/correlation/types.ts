// =========================
// TACT Canonical Execution — Work Correlation Types (SOR-52)
// =========================
//
// Core Principle(SOR-52指示、最重要): Executionは「実際に起きた事実」、
// Work Correlationは「その事実がどのWorkに属するかの判断」——この2つを
// 混ぜない。SOR-51のPermission Decisionと同じ構造的分離をここでも
// 適用する(core/tact-execution/permission/types.ts参照)。

import type { JsonValue } from "../../tact-work/approvalIntegrity";
import type { ExecutionActorKind, ExecutionProvider } from "../types";

// "pending"は../types.tsのExecutionCorrelationStatus(要約列、4値)に
// のみ存在する不在の状態。ここ(実際に永続化されるdecision)は3値のみ。
export type WorkCorrelationStatus = "matched" | "ambiguous" | "unresolved";

export const WORK_CORRELATION_STATUSES: readonly WorkCorrelationStatus[] = [
  "matched",
  "ambiguous",
  "unresolved",
];

// SOR-52 Closeout Hardening: "manual_override"を追加(Part3、Manual
// Override/Reclassification Boundary)。auto pipelineの4段階
// (explicit/structural/temporal_participant/ai_assisted)とは明確に
// 区別される、人間による明示的な修正の記録専用。
export type WorkCorrelationMethod =
  | "explicit"
  | "structural"
  | "temporal_participant"
  | "ai_assisted"
  | "manual_override";

export const WORK_CORRELATION_METHODS: readonly WorkCorrelationMethod[] = [
  "explicit",
  "structural",
  "temporal_participant",
  "ai_assisted",
  "manual_override",
];

export interface CorrelationContext {

  userId: string;

  provider: ExecutionProvider;

  observedAt: string;

  // Provider固有の構造的signal。将来Provider追加時はここへ新しい
  // optional fieldを足すだけで済む想定(Adapter Boundaryと同じ
  // extensibility方針、上位Correlator pipelineのロジックは書き換え
  // ない)。
  //
  // SOR-52 Closeout Hardening Part8(Slack Resource Identity):
  // teamId(Slack workspace識別子)を追加する——channel IDはSlack platform
  // 全体で一意という前提に依存しすぎず、resource identityとしてより
  // 明示的な区別を持たせる(同じYolna userが複数workspaceを接続する
  // 場合の将来的な衝突を避ける)。
  slack?: {
    teamId: string;
    channel: string;
    threadTs?: string;
  };

  // SOR-53(Notion Structural Correlator)。resourceRefはCanonicalExecution.
  // resourceIdentifier(既にsanitize済みのNotion page id、raw page body
  // ではない、core/tact-execution/adapters/notion/normalizeNotionMcpExecution.ts
  // 参照)そのもの——このcontext自体もprivacy boundaryを維持する。
  notion?: {
    resourceRef: string;
  };

}

export interface WorkCorrelationDecision {

  executionId: string;

  status: WorkCorrelationStatus;

  // matchedの場合のみ非null(絶対条件、Never Guess Rule)。
  workId: string | null;

  method: WorkCorrelationMethod;

  confidence: number | null;

  reasonCode: string;

  correlatorVersion: string;

  candidateWorkIds: readonly string[] | null;

  metadata?: JsonValue | null;

  correlatedAt: string;

  // SOR-52 Closeout Hardening Part3(Manual Override): method=
  // "manual_override"の場合のみ意味を持つ。auto pipeline(explicit/
  // structural/temporal_participant/ai_assisted)の結果には常にnull。
  previousWorkId?: string | null;

  changedByActorKind?: ExecutionActorKind | null;

  changedByActorId?: string | null;

}
