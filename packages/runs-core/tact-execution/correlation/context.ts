// =========================
// TACT Canonical Execution — Correlation Context Resolver (SOR-52)
// =========================
//
// Canonical Execution → Correlation Context Resolver → Candidate Work
// Resolver → ... というpipelineの最初の境界(pure関数、DBアクセス無し)。
// Executionが既に持つfield(provider/sourceMetadata等)から、Correlator
// が使う構造的signalだけを抽出する。

import type { JsonValue } from "@tact/execution-contract";
import type { CanonicalExecution } from "../types";
import type { CorrelationContext } from "./types";

function extractSlackSignal(execution: CanonicalExecution): CorrelationContext["slack"] {

  if (execution.provider !== "slack") {
    return undefined;
  }

  const metadata = execution.sourceMetadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const record = metadata as Record<string, JsonValue>;
  const teamId = record.teamId;
  const channel = record.channel;
  const threadTs = record.threadTs;

  // SOR-52 Closeout Hardening Part8(Slack Resource Identity): teamId
  // (workspace識別子)が無い構造的signalは、Structural Correlatorへ
  // 渡さない——workspace scopeが不明なままchannel IDだけで相関する
  // ことを避ける(絶対条件)。
  if (typeof teamId !== "string" || teamId.length === 0) {
    return undefined;
  }

  if (typeof channel !== "string" || channel.length === 0) {
    return undefined;
  }

  return {
    teamId,
    channel,
    threadTs: typeof threadTs === "string" && threadTs.length > 0 ? threadTs : undefined,
  };

}

// SOR-53: MCP経由のNotion実行はprovider="mcp"・targetProvider="notion"
// となる(SOR-51のtargetProvider fixと同じ理由、
// core/tact-execution/permission/policy.tsのtargetProviderコメント
// 参照)ため、providerではなくtargetProviderで判定する。resourceRefは
// 既にsanitize済みのresourceIdentifierのみを使い、raw page body等は
// 一切参照しない(privacy boundary)。
function extractNotionSignal(execution: CanonicalExecution): CorrelationContext["notion"] {

  if (execution.targetProvider !== "notion") {
    return undefined;
  }

  if (!execution.resourceIdentifier) {
    // CREATE_PAGE等、結果が返るまでresource refが未知の操作は構造的
    // signalを持たない(SOR-51のCREATE_PAGE resource=null設計と同じ
    // 「unknownを推測しない」原則)。
    return undefined;
  }

  return { resourceRef: execution.resourceIdentifier };

}

export function resolveCorrelationContext(execution: CanonicalExecution): CorrelationContext {

  return {
    userId: execution.userId,
    provider: execution.provider,
    observedAt: execution.observedAt,
    slack: extractSlackSignal(execution),
    notion: extractNotionSignal(execution),
  };

}
