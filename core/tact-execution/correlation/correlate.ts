// =========================
// TACT Canonical Execution — Correlator Orchestration (SOR-52)
// =========================
//
// Canonical Execution → Correlation Context Resolver → Candidate Work
// Resolver → Deterministic Correlator → Contextual Correlator →
// (optional) AI Correlator → Correlation Decision、というpipeline全体を
// 束ねる。各stageは独立したfileに分離済み(explicit.ts/structural.ts/
// temporalParticipant.ts/aiAssisted.ts)——この関数はそれらを順序どおり
// 呼ぶだけで、判定ロジック自体は持たない(絶対条件: 巨大な1関数に
// まとめない)。

import { runExplicitCorrelation } from "./stages/explicit";
import {
  runStructuralCorrelation,
  defaultStructuralCorrelationDeps,
  type StructuralCorrelationDeps,
} from "./stages/structural";
import {
  resolveTemporalParticipantCandidates,
  defaultTemporalParticipantCandidateDeps,
  type TemporalParticipantCandidateDeps,
} from "./stages/temporalParticipant";
import { runAiAssistedCorrelation } from "./stages/aiAssisted";
import { resolveCorrelationContext } from "./context";
import { CORRELATOR_VERSION } from "./version";
import type { CanonicalExecution } from "../types";
import type { WorkCorrelationDecision } from "./types";

export type CorrelateExecutionDeps = StructuralCorrelationDeps & TemporalParticipantCandidateDeps;

export const defaultCorrelateExecutionDeps: CorrelateExecutionDeps = {
  ...defaultStructuralCorrelationDeps,
  ...defaultTemporalParticipantCandidateDeps,
};

function buildUnresolvedDecision(execution: CanonicalExecution): WorkCorrelationDecision {

  return {
    executionId: execution.id,
    status: "unresolved",
    workId: null,
    // 絶対条件(最終fallbackのmethod): どのstageも候補を出せなかった
    // ことを示す、専用のmethod値は増やさない(WORK_CORRELATION_METHODS
    // を4値に保つ、過剰taxonomy回避)——最後に試みたstage
    // (temporal_participant、AI-assistedはこのstageの候補集合を
    // 受け取って動くだけの後段であるため)として記録する。
    method: "temporal_participant",
    confidence: null,
    reasonCode: "no_candidates_from_any_stage",
    correlatorVersion: CORRELATOR_VERSION,
    candidateWorkIds: null,
    correlatedAt: new Date().toISOString(),
  };

}

export async function correlateExecution(
  execution: CanonicalExecution,
  deps: CorrelateExecutionDeps = defaultCorrelateExecutionDeps
): Promise<WorkCorrelationDecision> {

  const explicit = runExplicitCorrelation(execution);

  if (explicit) {
    return explicit;
  }

  const context = resolveCorrelationContext(execution);

  const structural = await runStructuralCorrelation(execution, context, deps);

  if (structural) {
    return structural;
  }

  const temporalCandidates = await resolveTemporalParticipantCandidates(context, deps);

  const aiAssisted = runAiAssistedCorrelation(temporalCandidates, execution);

  if (aiAssisted) {
    return aiAssisted;
  }

  // 絶対条件(Never Guess Rule、最重要): どのstageも確信を持てなかった
  // 場合、推測でWorkへ紐付けるより、未分類(unresolved)を優先する。
  return buildUnresolvedDecision(execution);

}
