import {
  actionLabel,
  executionResultLabel,
  permissionResultLabel,
  principalLabel,
  targetSystemLabel,
  toCanonicalPermissionResultFromExecutionStatus,
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
    ai: string;
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
    registered: string;
    evaluation: string;
    reason: string | null;
    decisions: Array<{ policyId: string | null; ruleId: string | null; revision: number | null; reason: string; evaluatedAt: string }>;
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

/** A read-only presentation projection. It never evaluates permissions or correlations. */
export function toExecutionInspectorViewModel(
  execution: CanonicalExecution,
  decisions: readonly PermissionDecision[],
  downstream: readonly DownstreamPermissionEvidence[],
): ExecutionInspectorViewModel {
  const target = targetSystemLabel(execution.provider, execution.targetProvider, execution.adapterVersion);
  const action = actionLabel(execution.operation, execution.provider, execution.targetProvider);
  const ai = execution.agentId ?? "AI\u60c5\u5831\u306a\u3057";
  const principal = principalLabel(execution.actorId);
  const resource = execution.resourceIdentifier ?? execution.resourceType;
  const source = execution.sourceMetadata && typeof execution.sourceMetadata === "object" && !Array.isArray(execution.sourceMetadata)
    ? execution.sourceMetadata as Record<string, unknown>
    : null;
  const stringMetadata = (key: string) => typeof source?.[key] === "string" ? source[key] as string : null;

  return {
    executionId: execution.id,
    summary: {
      actionSentence: `${ai} \u304c ${target.label} \u3067 ${action}${resource ? `\uff08${resource}\uff09` : ""}\u3092\u5b9f\u884c\u3057\u307e\u3057\u305f\u3002`,
      actor: execution.actorKind,
      ai,
      principal,
      provider: target.subLabel ? `${target.label}\uff08${target.subLabel}\uff09` : target.label,
      action,
      resource,
      occurredAt: execution.providerOccurredAt,
      observedAt: execution.observedAt,
      result: executionResultLabel(execution.status),
      outcome: execution.outcomeStatus ? `${execution.outcomeStatus}${execution.outcomeKind ? ` / ${execution.outcomeKind}` : ""}` : null,
      workId: execution.workId,
    },
    permission: {
      registered: permissionResultLabel(toCanonicalPermissionResultFromExecutionStatus(execution.permissionStatus)),
      evaluation: execution.permissionStatus,
      reason: execution.permissionReasonCode,
      decisions: decisions.map((decision) => ({ policyId: decision.policyId, ruleId: decision.registryRuleId ?? null, revision: decision.registryRuleRevision ?? null, reason: decision.reasonCode, evaluatedAt: decision.evaluatedAt })),
      downstream: downstream.map((evidence) => ({ state: evidence.permissionState, authority: evidence.authorityLevel, observedAt: evidence.observedAt })),
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
