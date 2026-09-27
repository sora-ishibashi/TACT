// =========================
// TACT Canonical Execution — Adapter Boundary (SOR-50)
// =========================
//
// Provider Event → Provider Adapter → Canonical Execution Input →
// Validation → Persistence、という境界(SOR-50 Objective「Adapter
// Boundary」)。Adapterはprovider固有の生payloadを直接
// core/tact-executionのdomain type/store層へ流し込まず、必ず
// CaptureExecutionInputへ正規化してから渡す。
//
// AdapterContextはAdapter自身が持たない、呼び出し元(webhook handler
// 等のtrust boundary)が既に解決済みの値(identity resolver等)を渡す
// ためのもの——core/tact-bot/execution/trustedConversationTurn.tsと
// 同じ「外部からの主張をAdapterが直接信用しない」原則。

import type { CaptureExecutionInput } from "../types";

export interface ExecutionAdapterContext {

  userId: string;

  organizationId?: string | null;

  workspaceId?: string | null;

  workId?: string | null;

  connectionId?: string | null;

  // 省略時はAdapter呼び出し時点(now())を使う。
  observedAt?: string;

}

// normalize()はpure関数として実装する(DBアクセス・副作用無し)——
// captureExecution()の呼び出しはAdapterの外側(呼び出し元)の責務。
// providerが対応しないevent種別・必須値欠落等はnullを返す
// (normalizeSlackAppMentionEvent()と同じ「対象外は安全にignore」
// 規律)。
export type ExecutionAdapterNormalizeResult =
  | { ok: true; input: CaptureExecutionInput }
  | { ok: false; reason: string };
