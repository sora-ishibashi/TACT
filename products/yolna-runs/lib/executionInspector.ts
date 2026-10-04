import {
  actionLabel,
  executionResultLabel,
  principalLabel,
  targetSystemLabel,
} from "@tact/runs-core/tact-runs-view";
import type {
  CanonicalExecution,
  DownstreamPermissionEvidence,
  PermissionDecision,
} from "@tact/runs-core/tact-execution";

export type ExecutionInspectorViewModel = {
  executionId: string;
  summary: {
    actionSentence: string;
    actor: string;
    ai: string | null;
    principal: string;
    provider: string;
    action: string;
    resource: string | null;
    occurredAt: string | null;
    observedAt: string;
    result: string;
    outcome: string | null;
    workId: string | null;
  };
  permission: {
    evaluation: string;
    reasonCode: string | null;
    decisions: Array<{ ruleId: string | null; revision: number | null }>;
    downstream: Array<{ state: string; authority: string; observedAt: string }>;
  };
  technical: {
    observationMode: string | null;
    sourceType: string;
    invocationId: string | null;
    traceId: string | null;
    spanId: string | null;
    rawObservationReference: string | null;
  };
};

const actorKindLabel: Record<CanonicalExecution["actorKind"], string> = {
  human: "\u4eba",
  ai_agent: "AI",
  service: "\u30b5\u30fc\u30d3\u30b9",
  connector: "\u63a5\u7d9a\u6a5f\u80fd",
  system: "\u30b7\u30b9\u30c6\u30e0",
};
const permissionLabel: Record<CanonicalExecution["permissionStatus"], string> = {
  allowed: "\u8a31\u53ef",
  denied: "\u4e0d\u8a31\u53ef",
  approval_required: "\u627f\u8a8d\u304c\u5fc5\u8981",
  unknown: "\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093",
  pending: "\u672a\u8a55\u4fa1",
};
const downstreamStateLabel: Record<DownstreamPermissionEvidence["permissionState"], string> = {
  allowed: "\u8a31\u53ef",
  denied: "\u4e0d\u8a31\u53ef",
  unknown: "\u4e0d\u660e",
};
const authorityLabel: Record<DownstreamPermissionEvidence["authorityLevel"], string> = {
  AUTHORITATIVE: "\u6b63\u672c",
  NON_AUTHORITATIVE: "\u53c2\u8003",
  UNKNOWN: "\u6a29\u9650\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093",
};

/** A read-only presentation projection. It never evaluates permissions or correlations. */
export function toExecutionInspectorViewModel(
  execution: CanonicalExecution,
  decisions: readonly PermissionDecision[],
  downstream: readonly DownstreamPermissionEvidence[],
): ExecutionInspectorViewModel {
  const target = targetSystemLabel(execution.provider, execution.targetProvider, execution.adapterVersion);
  const action = actionLabel(execution.operation, execution.provider, execution.targetProvider);
  const actor = `${actorKindLabel[execution.actorKind]}${execution.actorId ? `\uff08${execution.actorId}\uff09` : ""}`;
  const ai = execution.agentId ? `AI\uff08${execution.agentId}\uff09` : null;
  const principal = principalLabel(execution.actorId);
  const resource = execution.resourceIdentifier ?? execution.resourceType;
  const source = execution.sourceMetadata && typeof execution.sourceMetadata === "object" && !Array.isArray(execution.sourceMetadata)
    ? execution.sourceMetadata as Record<string, unknown>
    : null;
  const stringMetadata = (key: string) => typeof source?.[key] === "string" ? source[key] as string : null;

  return {
    executionId: execution.id,
    summary: {
      actionSentence: `${actor} \u304c ${target.label} \u3067 ${action}${resource ? `\uff08${resource}\uff09` : ""}\u3092\u5b9f\u884c\u3057\u307e\u3057\u305f\u3002`,
      actor,
      ai,
      principal,
      provider: target.subLabel ? `${target.label}\uff08${target.subLabel}\uff09` : target.label,
      action,
      resource,
      occurredAt: execution.providerOccurredAt,
      observedAt: execution.observedAt,
      result: executionResultLabel(execution.status),
      outcome: execution.outcomeStatus === "asserted" && execution.outcomeKind ? execution.outcomeKind : null,
      workId: execution.workId,
    },
    permission: {
      evaluation: permissionLabel[execution.permissionStatus],
      reasonCode: execution.permissionReasonCode,
      decisions: decisions.map((decision) => ({ ruleId: decision.registryRuleId ?? null, revision: decision.registryRuleRevision ?? null })),
      downstream: downstream.map((evidence) => ({ state: downstreamStateLabel[evidence.permissionState], authority: authorityLabel[evidence.authorityLevel], observedAt: evidence.observedAt })),
    },
    technical: {
      observationMode: execution.observationMode,
      sourceType: execution.sourceType,
      invocationId: stringMetadata("invocationId"),
      traceId: stringMetadata("traceId"),
      spanId: stringMetadata("spanId"),
      rawObservationReference: execution.rawPayloadRef,
    },
  };
}
