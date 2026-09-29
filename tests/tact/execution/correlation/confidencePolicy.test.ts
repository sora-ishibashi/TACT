// =========================
// TACT Canonical Execution — SOR-76 Correlation Confidence Policy
// =========================
//
// SOR-76 (CORRELATION-SCORE-P1) is a documentation/consolidation change, not
// a new scoring engine: the existing 4-stage correlator (SOR-52/53) already
// implements a deterministic, precision-first policy equivalent to Linear's
// AUTO_ASSIGNED/SUGGESTED/UNASSIGNED. This file locks two things so that
// policy cannot silently drift apart from the actual stage behavior:
//
//   1. Each stage's real decision confidence equals the named constant in
//      core/tact-execution/correlation/confidencePolicy.ts (a threshold
//      change becomes visible/testable here, per SOR-76's "threshold must
//      be configurable/versioned" requirement).
//   2. The SOR-76 vocabulary (AUTO_ASSIGNED/SUGGESTED/UNASSIGNED) maps
//      1:1 onto the existing WorkCorrelationStatus/CanonicalCorrelationResult
//      values, with no fourth/parallel status introduced.

import { runExplicitCorrelation } from "../../../../core/tact-execution/correlation/stages/explicit";
import { runStructuralCorrelation, type StructuralCorrelationDeps } from "../../../../core/tact-execution/correlation/stages/structural";
import { runAiAssistedCorrelation } from "../../../../core/tact-execution/correlation/stages/aiAssisted";
import { resolveCorrelationContext } from "../../../../core/tact-execution/correlation/context";
import {
  EXPLICIT_CONFIDENCE,
  STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE,
  STRUCTURAL_AMBIGUOUS_CONFIDENCE,
  AI_ASSISTED_AMBIGUOUS_CONFIDENCE,
} from "../../../../core/tact-execution/correlation/confidencePolicy";
import { toCanonicalCorrelationResult } from "../../../../core/tact-execution/correlation/canonicalResult";
import type { CanonicalExecution } from "../../../../core/tact-execution/types";
import type { Work } from "../../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../../lib/check";

function makeExecution(overrides: Partial<CanonicalExecution> = {}): CanonicalExecution {
  return {
    id: "exec-1",
    userId: "user-1",
    organizationId: null,
    workspaceId: null,
    workId: null,
    correlationStatus: "pending",
    connectionId: null,
    actorKind: "human",
    actorId: "U123",
    agentId: null,
    onBehalfOfActorKind: null,
    onBehalfOfActorId: null,
    provider: "slack",
    sourceType: "webhook",
    externalEventId: "Ev1",
    adapterVersion: "v1",
    sourceMetadata: { teamId: "T1", channel: "C1", threadTs: "100.001" },
    rawPayloadRef: null,
    actionCategory: "create",
    operation: "app_mention",
    resourceType: "slack_message",
    resourceIdentifier: null,
    targetProvider: "slack",
    status: "succeeded",
    errorCode: null,
    errorMessage: null,
    permissionStatus: "pending",
    permissionReasonCode: null,
    permissionEvaluatedAt: null,
    providerOccurredAt: null,
    observedAt: "2026-09-20T12:00:00.000Z",
    persistedAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- SOR-76 vocabulary maps 1:1 onto the existing domain vocabulary
  // (no fourth/parallel status introduced) ----
  results.push(check(
    "[SOR-76] AUTO_ASSIGNED == matched -> CORRELATED",
    toCanonicalCorrelationResult("matched") === "CORRELATED"
  ));
  results.push(check(
    "[SOR-76] SUGGESTED == ambiguous -> AMBIGUOUS",
    toCanonicalCorrelationResult("ambiguous") === "AMBIGUOUS"
  ));
  results.push(check(
    "[SOR-76] UNASSIGNED == unresolved -> UNASSIGNED",
    toCanonicalCorrelationResult("unresolved") === "UNASSIGNED"
  ));

  // ---- Explicit stage confidence matches the documented policy constant ----
  {
    const decision = runExplicitCorrelation(makeExecution({ workId: "work-explicit-1" }));
    results.push(check(
      "[SOR-76] explicit stage confidence === EXPLICIT_CONFIDENCE (AUTO_ASSIGNED, definitional certainty)",
      decision?.confidence === EXPLICIT_CONFIDENCE
    ));
  }

  // ---- Structural stage: single candidate (AUTO_ASSIGNED tier) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async () => "conv-1",
      listWorksForConversation: async () => [makeWork({ id: "work-structural-1" })],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };
    const execution = makeExecution();
    const decision = await runStructuralCorrelation(execution, resolveCorrelationContext(execution), deps);

    results.push(check(
      "[SOR-76] structural single-candidate confidence === STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE (AUTO_ASSIGNED only when unambiguous)",
      decision?.status === "matched" && decision.confidence === STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE
    ));
  }

  // ---- Structural stage: multiple candidates (SUGGESTED tier, tied strong
  // evidence does not auto-assign) ----
  {
    const deps: StructuralCorrelationDeps = {
      findConversationLink: async () => "conv-multi-1",
      listWorksForConversation: async () => [makeWork({ id: "work-a" }), makeWork({ id: "work-b" })],
      listWorksForNotionResource: async () => [],
      getServiceRoleKey: () => "service-role-key",
    };
    const execution = makeExecution();
    const decision = await runStructuralCorrelation(execution, resolveCorrelationContext(execution), deps);

    results.push(check(
      "[SOR-76] structural ambiguous confidence === STRUCTURAL_AMBIGUOUS_CONFIDENCE; tied strong candidates -> SUGGESTED, never AUTO_ASSIGNED",
      decision?.status === "ambiguous" && decision.workId === null &&
        decision.confidence === STRUCTURAL_AMBIGUOUS_CONFIDENCE
    ));
  }

  // ---- AI-assisted stage: multiple candidates (SUGGESTED tier) ----
  {
    const decision = runAiAssistedCorrelation(
      [makeWork({ id: "work-x" }), makeWork({ id: "work-y" })],
      makeExecution()
    );
    results.push(check(
      "[SOR-76] ai_assisted ambiguous confidence === AI_ASSISTED_AMBIGUOUS_CONFIDENCE",
      decision?.status === "ambiguous" && decision.confidence === AI_ASSISTED_AMBIGUOUS_CONFIDENCE
    ));
  }

  // ---- AI-assisted stage: temporal proximity alone (single candidate) must
  // remain UNASSIGNED, not SUGGESTED (Linear's own SOR-76 example policy) ----
  {
    const decision = runAiAssistedCorrelation([makeWork({ id: "work-recent-1" })], makeExecution());
    results.push(check(
      "[SOR-76] a single temporal-only candidate stays null/UNASSIGNED (never promoted to SUGGESTED on recency alone)",
      decision === null
    ));
  }

  return summarize("TACT Canonical Execution — SOR-76 Correlation Confidence Policy", results);

}
