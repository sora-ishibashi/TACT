// =========================
// TACT Referent — Resolution State Machine (REF-P1c)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit §10/§20/§21で確定した、frozen
// WRITE ruleとresolution state machineを実装する。純粋関数のみ
// (fetch/DB/Supabase/env/Date.now()/Slack/Gmail API/Composio/LLMの
// いずれも使わない、PART23)。
//
// 絶対条件: この関数はfixtureのground truth(expected)を一切受け取らない
// ——ResolveReferentInputにそのようなfieldは存在しない(PART13)。
// この関数はApproval/Policy/execution/Workの状態を一切変更・所有しない
// (PART15)——"resolved"は「対象が十分に識別できた」ことのみを意味し、
// 「実行が許可された」ことは一切意味しない。

import { bestTier, extractCandidateEvidence, tierBFamilies } from "./candidates";
import type { ExtractCandidateEvidenceInput, KnownThreadRefInput, PinnedReferentInput } from "./candidates";
import {
  detectDiscourseWorkMismatch,
  detectFatalConflicts,
  detectSubjectSenderTwinConflicts,
  detectTimeContradictions,
  detectWeakConflicts,
} from "./conflicts";
import type {
  CommunicationCandidate,
  ReferentConflict,
  ReferentEvidence,
  ReferentResolution,
  ReferentSignal,
  SearchCompletenessAssessment,
  SourceReferentSnapshot,
} from "./types";

export interface StaleReferentInput {
  reasonCode: string;
  priorReferent?: SourceReferentSnapshot;
}

export interface ResolveReferentInput {

  candidates: readonly CommunicationCandidate[];

  signals: readonly ReferentSignal[];

  // core/tact-referent/types.tsのassessSearchCompleteness()で構築
  // 済みのものをそのまま渡す——この関数自身は完全性判定を再実装
  // しない(PART7、「isWriteSearchComplete()をresolverが上書きしない」
  // という frozen 絶対条件)。
  searchCompleteness: SearchCompletenessAssessment;

  // 既存canonical WorkRequestType(core/tact-work/types.ts)をそのまま
  // 文字列として受け取る——第2のintent modelを作らない。
  requestType: string;

  workSubject?: string;

  discourseFocusTop?: string;

  // PART12: これらは常にauto-resolutionより優先される。
  sourceAvailability?: "available" | "unavailable";

  staleReferent?: StaleReferentInput;

  // PART9/PART12: Clarification/Approval本体はまだwireされていない
  // ——これらは将来の本番inputを模した、resolver自身が生成しない
  // 明示的なexternal preconditionとしてのみ受け取る。
  pinnedReferent?: PinnedReferentInput;

  knownThreadRef?: KnownThreadRefInput;

}

// requestType === "inspect"のみがREADの緩い(loose)ルールを使う。
// "prepare"は、candidate-specific draft内容の等価性をbody/snippet無しで
// 安全に証明できないため、このphaseでは保守的にWRITEと同じ厳格な
// ルールに従う(PART11、明示的に許容された保守的選択——設計の失敗
// ではない)。"monitor"/"unknown"も同様に安全側(厳格)にfall backする。
function isStrictRequestType(requestType: string): boolean {
  return requestType !== "inspect";
}

function qualifiesStrict(
  candidateId: string,
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>,
  twinBlocked: ReadonlySet<string>
): boolean {

  const evidence = evidenceByCandidate.get(candidateId) ?? [];

  if (evidence.some((e) => e.tier === "A")) {
    return true;
  }

  if (twinBlocked.has(candidateId)) {
    return false;
  }

  return tierBFamilies(evidence).size >= 2;

}

export function resolveReferent(input: ResolveReferentInput): ReferentResolution {

  // ---- PART12: providerの可用性/staleは常に最優先。ここより下の
  // auto-resolutionロジックへは一切進まない。 ----
  if (input.sourceAvailability === "unavailable") {
    return { state: "unavailable", reasonCode: "provider_unavailable" };
  }

  if (input.staleReferent) {
    return {
      state: "stale",
      reasonCode: input.staleReferent.reasonCode,
      ...(input.staleReferent.priorReferent ? { priorReferent: input.staleReferent.priorReferent } : {}),
    };
  }

  const evidenceInput: ExtractCandidateEvidenceInput = {
    candidates: input.candidates,
    signals: input.signals,
    workSubject: input.workSubject,
    pinnedReferent: input.pinnedReferent,
    knownThreadRef: input.knownThreadRef,
  };

  const evidenceByCandidate = extractCandidateEvidence(evidenceInput);

  // ---- Fatal: 矛盾するcandidateは両方とも以後の考慮から除外する ----
  const fatalConflicts = detectFatalConflicts(input.candidates, evidenceByCandidate, input.pinnedReferent?.candidateRef);
  const fatallyExcluded = new Set(fatalConflicts.flatMap((c) => c.candidateRefs));
  const eligible = input.candidates.filter((c) => !fatallyExcluded.has(c.messageId));

  const weakConflicts = detectWeakConflicts(eligible);
  const discourseConflicts = detectDiscourseWorkMismatch(input.discourseFocusTop, input.workSubject);

  if (!isStrictRequestType(input.requestType)) {
    return resolveRead(eligible, evidenceByCandidate, [...fatalConflicts, ...weakConflicts, ...discourseConflicts]);
  }

  return resolveStrict(
    eligible,
    evidenceByCandidate,
    input.searchCompleteness,
    [...fatalConflicts, ...weakConflicts, ...discourseConflicts]
  );

}

function evidenceFor(
  candidates: readonly CommunicationCandidate[],
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>
): readonly ReferentEvidence[] {
  return candidates.flatMap((c) => evidenceByCandidate.get(c.messageId) ?? []);
}

function resolveRead(
  eligible: readonly CommunicationCandidate[],
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>,
  priorConflicts: readonly ReferentConflict[]
): ReferentResolution {

  const TIER_ORDER = ["A", "B", "C"] as const;

  for (const tier of TIER_ORDER) {

    const atTier = eligible.filter((c) => bestTier(evidenceByCandidate.get(c.messageId) ?? []) === tier);

    if (atTier.length === 1) {
      const [winner] = atTier;
      return {
        state: "resolved",
        winner,
        evidence: evidenceByCandidate.get(winner.messageId) ?? [],
        conflicts: priorConflicts,
        // READはsearch completenessを要求しない(frozen: READ may
        // tolerate uncertainty)。ここでは「未証明」として素直に
        // 記録するだけで、resolutionをblockしない。
        searchCompleteness: { mode: "broad", resultCount: eligible.length, ceilingHit: false, proven: false },
      };
    }

    if (atTier.length >= 2) {
      return {
        state: "ambiguous",
        candidates: atTier,
        evidence: evidenceFor(atTier, evidenceByCandidate),
        conflicts: priorConflicts,
      };
    }

  }

  return { state: "insufficient_evidence", candidateCount: eligible.length, reasonCode: "no_matching_evidence" };

}

function resolveStrict(
  eligible: readonly CommunicationCandidate[],
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>,
  searchCompleteness: SearchCompletenessAssessment,
  priorConflicts: readonly ReferentConflict[]
): ReferentResolution {

  const twin = detectSubjectSenderTwinConflicts(eligible, evidenceByCandidate);

  const leadingRefs = eligible
    .filter((c) => qualifiesStrict(c.messageId, evidenceByCandidate, twin.blockedCandidateRefs))
    .map((c) => c.messageId);

  const timeContradiction = detectTimeContradictions(eligible, evidenceByCandidate, leadingRefs);

  const qualifyingRefs = new Set(leadingRefs.filter((ref) => !timeContradiction.vetoedCandidateRefs.has(ref)));
  const qualifying = eligible.filter((c) => qualifyingRefs.has(c.messageId));

  const allConflicts = [...priorConflicts, ...twin.conflicts, ...timeContradiction.conflicts];

  const hasBlockingMaterialConflict = twin.conflicts.length > 0 || timeContradiction.conflicts.length > 0;

  if (qualifying.length === 0) {

    if (hasBlockingMaterialConflict) {
      const involved = eligible.filter(
        (c) => twin.blockedCandidateRefs.has(c.messageId) || timeContradiction.vetoedCandidateRefs.has(c.messageId)
      );
      return { state: "conflicting_evidence", candidates: involved, conflicts: allConflicts };
    }

    const evidencedCount = eligible.filter((c) => bestTier(evidenceByCandidate.get(c.messageId) ?? []) !== undefined).length;

    if (evidencedCount >= 2) {
      const evidenced = eligible.filter((c) => bestTier(evidenceByCandidate.get(c.messageId) ?? []) !== undefined);
      return {
        state: "ambiguous",
        candidates: evidenced,
        evidence: evidenceFor(evidenced, evidenceByCandidate),
        conflicts: allConflicts,
      };
    }

    return {
      state: "insufficient_evidence",
      candidateCount: eligible.length,
      reasonCode: eligible.length === 0 ? "no_candidates" : "no_sufficient_evidence",
    };

  }

  if (qualifying.length >= 2) {
    return {
      state: "ambiguous",
      candidates: qualifying,
      evidence: evidenceFor(qualifying, evidenceByCandidate),
      conflicts: allConflicts,
    };
  }

  const [winner] = qualifying;

  // frozen invariant(このphaseのIMPORTANT SPEC CLARIFICATION): broad
  // entity-only searchは、結果件数に関わらずWRITEのcandidate universe
  // 完全性を証明しない。ここではisWriteSearchComplete()の出力
  // (searchCompleteness.proven)をそのまま信頼するだけで、この関数
  // 自身が完全性を再判定することは一切しない。
  if (!searchCompleteness.proven) {
    return {
      state: "insufficient_evidence",
      candidateCount: eligible.length,
      reasonCode: "search_completeness_unproven",
    };
  }

  return {
    state: "resolved",
    winner,
    evidence: evidenceByCandidate.get(winner.messageId) ?? [],
    conflicts: allConflicts,
    searchCompleteness,
  };

}
