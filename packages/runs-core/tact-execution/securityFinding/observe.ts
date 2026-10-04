// =========================
// TACT Canonical Execution — Security Finding Observation (SOR-178 / SEC-8D)
// =========================
//
// Orchestration-only entrypoints: derive (pure) -> persist (store.ts) ->
// ensure/link Attention episode (../permission/attentionStore.ts's
// ensureSecurityFindingAttentionLink(), a single RPC transaction). No
// exception is thrown by the happy/sad paths below — every branch returns
// a structured outcome so the caller (../permission/observe.ts) can report
// a precise failure stage without guessing (section14/section15 Failure
// isolation: a Finding, once persisted, is never rolled back just because
// the Attention link step failed).
//
// section15: this file exposes observeDownstreamPermissionSecurityFindings()
// as the product-neutral Runs Core entrypoint a future downstream-evidence
// arrival caller can invoke — no provider fetch, no public HTTP route, no
// SaaS credential. Nothing in this repository calls it yet (SOR-8C has no
// provider ACL arrival orchestration); it exists so one can be wired in
// later without inventing new Core primitives at that time.

import { randomUUID } from "node:crypto";
import type { CanonicalExecution } from "../types";
import type { PermissionDecision } from "../permission/types";
import { ensureSecurityFindingAttentionLink } from "../permission/attentionStore";
import type { DownstreamPermissionComparisonResult } from "../downstreamPermission/compare";
import type { DownstreamPermissionEvidence } from "../downstreamPermission/types";
import {
  deriveDownstreamPermissionSecurityFindingCandidates,
  deriveRunsPermissionSecurityFindingCandidate,
} from "./derive";
import { recordSecurityFinding } from "./store";
import {
  DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES,
  SECURITY_FINDING_EVALUATOR_VERSION,
  type ConfiguredUnknownAlertRule,
  type SecurityFindingCandidate,
} from "./types";

export type ObserveSecurityFindingOutcome =
  | { status: "not_eligible" }
  | { status: "linked"; findingId: string; attentionId: string; episodeCreated: boolean }
  | { status: "finding_persistence_failed"; reason: string }
  | { status: "attention_link_failed"; findingId: string; reason: string };

export interface ObserveSecurityFindingDeps {

  randomUUID: () => string;

  recordSecurityFinding: typeof recordSecurityFinding;

  ensureSecurityFindingAttentionLink: typeof ensureSecurityFindingAttentionLink;

}

const defaultDeps: ObserveSecurityFindingDeps = {
  randomUUID,
  recordSecurityFinding,
  ensureSecurityFindingAttentionLink,
};

// candidateを実際に永続化し、Attention episodeへensure/linkする共通処理
// (section14/section6のどちらの入口からも使う)。candidateにidは無い
// (derive.tsは常にpure/idなし、section7の"caller-generated UUID"は
// ここで初めて割り当てる)。
async function persistAndLinkCandidate(
  candidate: SecurityFindingCandidate,
  deps: ObserveSecurityFindingDeps
): Promise<ObserveSecurityFindingOutcome> {

  const id = deps.randomUUID();

  const findingOutcome = await deps.recordSecurityFinding({ id, ...candidate });

  if (findingOutcome.status !== "created" && findingOutcome.status !== "already_exists") {

    const reason =
      findingOutcome.status === "invalid"
        ? `invalid: ${findingOutcome.errors.join("; ")}`
        : findingOutcome.status;

    return { status: "finding_persistence_failed", reason };

  }

  const findingId = findingOutcome.finding.id;

  const linkOutcome = await deps.ensureSecurityFindingAttentionLink(findingId, candidate.userId);

  if (linkOutcome.status === "linked") {
    return { status: "linked", findingId, attentionId: linkOutcome.attentionId, episodeCreated: linkOutcome.episodeCreated };
  }

  if (linkOutcome.status === "already_linked") {
    return { status: "linked", findingId, attentionId: linkOutcome.attentionId, episodeCreated: false };
  }

  return { status: "attention_link_failed", findingId, reason: linkOutcome.status === "error" ? linkOutcome.message : linkOutcome.status };

}

// =========================
// section14: PermissionDecision (denied/unknown) -> Finding -> Attention
// =========================

export async function observeRunsPermissionSecurityFinding(
  execution: CanonicalExecution,
  decision: PermissionDecision,
  permissionDecisionId: string,
  configuredUnknownRules: readonly ConfiguredUnknownAlertRule[] = DEFAULT_CONFIGURED_UNKNOWN_ALERT_RULES,
  deps: ObserveSecurityFindingDeps = defaultDeps
): Promise<ObserveSecurityFindingOutcome> {

  const candidate = deriveRunsPermissionSecurityFindingCandidate(
    execution,
    decision,
    permissionDecisionId,
    configuredUnknownRules,
    SECURITY_FINDING_EVALUATOR_VERSION
  );

  if (!candidate) {
    return { status: "not_eligible" };
  }

  return persistAndLinkCandidate(candidate, deps);

}

// =========================
// section15: Downstream comparison -> Finding(s) -> Attention
// =========================
//
// section6絶対条件: conflictEvidenceIdsを1つのFindingへ畳み込まない。
// 各candidateは独立にpersist/linkされ、どれかが失敗しても他のcandidateの
// 処理を止めない(1件の失敗が他の正当なFindingの記録を妨げない)。
export interface ObserveDownstreamPermissionSecurityFindingsResult {

  findingOutcomes: ObserveSecurityFindingOutcome[];

}

export async function observeDownstreamPermissionSecurityFindings(
  execution: CanonicalExecution,
  permissionDecisionId: string,
  comparison: DownstreamPermissionComparisonResult,
  downstreamEvidence: readonly DownstreamPermissionEvidence[],
  deps: ObserveSecurityFindingDeps = defaultDeps
): Promise<ObserveDownstreamPermissionSecurityFindingsResult> {

  const candidates = deriveDownstreamPermissionSecurityFindingCandidates(
    execution,
    permissionDecisionId,
    comparison,
    downstreamEvidence,
    SECURITY_FINDING_EVALUATOR_VERSION
  );

  const findingOutcomes: ObserveSecurityFindingOutcome[] = [];

  for (const candidate of candidates) {
    findingOutcomes.push(await persistAndLinkCandidate(candidate, deps));
  }

  return { findingOutcomes };

}
