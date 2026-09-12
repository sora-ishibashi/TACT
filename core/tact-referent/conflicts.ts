// =========================
// TACT Referent — Conflict Detection (REF-P1c)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit §9で確定したFatal/Material/Weak
// conflict modelを実装する。ここで実装するのは「現在のP1c入力から
// 実際に判定できるルールだけ」であり、direction("outbound")のように
// 現行データで判定不可能な事実は絶対に偽装しない(このphaseの明示的
// 指示、PART6)。

import { compareSenders, compareSubjects, tierBFamilies } from "./candidates";
import type { PinnedProvenance } from "./candidates";
import type { CommunicationCandidate, ReferentConflict, ReferentEvidence } from "./types";

// =========================
// Fatal
// =========================
//
// 現在のP1c入力で安全に判定できる、唯一のFatal rule: pinned referent
// (clarification選択済み/過去の承認済みpin)が指すcandidateとは別の
// candidateを、一意な明示的subject一致(Tier A)が指している場合
// ——2つの権威ある情報源が矛盾している。
//
// direction("outbound"自動判定)のような、現行dataでは安全に判定
// できないFatal ruleは実装しない(偽装検出の禁止、PART6)。
export function detectFatalConflicts(
  candidates: readonly CommunicationCandidate[],
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>,
  pinnedCandidateRef: string | undefined
): readonly ReferentConflict[] {

  if (!pinnedCandidateRef) {
    return [];
  }

  const conflicts: ReferentConflict[] = [];

  for (const candidate of candidates) {

    if (candidate.messageId === pinnedCandidateRef) {
      continue;
    }

    const evidence = evidenceByCandidate.get(candidate.messageId) ?? [];
    const hasContradictingTierA = evidence.some(
      (e) => e.tier === "A" && e.family === "candidate.subject"
    );

    if (hasContradictingTierA) {
      conflicts.push({
        severity: "fatal",
        reasonCode: "pinned_referent_contradicted_by_unique_subject_match",
        candidateRefs: [pinnedCandidateRef, candidate.messageId],
      });
    }

  }

  return conflicts;

}

// =========================
// Material
// =========================

export interface TwinConflictResult {
  conflicts: readonly ReferentConflict[];
  // subject+senderの2familyのみで、他candidateと組が識別不能な
  // (=第3の差別化要因を持たない)candidateのmessageId集合。
  blockedCandidateRefs: ReadonlySet<string>;
}

/**
 * frozen rule #7: 2件以上のcandidateが「同一normalized subject +
 * 同一normalized sender」を共有し、かつそのcandidateがTier-B
 * familyとして{candidate.subject, candidate.sender}以外を一切
 * 持たない場合、そのcandidate群はsubject+senderだけでは解決できない
 * (第3の独立したfamily——thread/time/pin等——を持つcandidateは
 * この制約から除外される、PART5/PART9)。
 */
export function detectSubjectSenderTwinConflicts(
  candidates: readonly CommunicationCandidate[],
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>
): TwinConflictResult {

  const SUBJECT_SENDER_ONLY = new Set(["candidate.subject", "candidate.sender"]);

  // normalizedSubject+normalizedSenderの組み合わせでgroup化する
  // (candidateの生dataそのものを比較する——evidenceの有無とは独立)。
  const groups = new Map<string, CommunicationCandidate[]>();

  for (const candidate of candidates) {
    const subject = candidate.normalizedSubject?.trim();
    const sender = candidate.sender?.trim();
    if (!subject || !sender) continue;
    const key = `${subject.toLowerCase()}::${sender.toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const conflicts: ReferentConflict[] = [];
  const blocked = new Set<string>();

  for (const group of groups.values()) {

    if (group.length < 2) continue;

    // 各memberのTier-B family集合が、ちょうど{subject, sender}のみか
    // どうかを個別に確認する。絶対条件(このphase実装時に発見・修正した
    // 不具合): あるmember自身の判定は、"同じgroup内の他のmemberが
    // 差別化されているかどうか"に依存させてはならない——m1の証拠は
    // 依然として「subject+senderのみ」であり、m2が第3のfamilyを
    // 獲得したという事実はm1自身の識別力を一切高めない
    // (m1は今なおm2と区別不能なまま)。そのためgroup全体のサイズが
    // 2以上であれば、"第3のfamilyを持たないmember"は(残りのmemberの
    // 状態に関わらず)個別にblockする。
    const membersLackingDifferentiator = group.filter((candidate) => {
      const families = tierBFamilies(evidenceByCandidate.get(candidate.messageId) ?? []);
      if (families.size === 0) return false;
      for (const family of families) {
        if (!SUBJECT_SENDER_ONLY.has(family)) return false;
      }
      return true;
    });

    if (membersLackingDifferentiator.length > 0) {
      conflicts.push({
        severity: "material",
        reasonCode: "same_subject_sender_twin_without_differentiator",
        candidateRefs: group.map((c) => c.messageId),
        evidenceFamilies: ["candidate.subject", "candidate.sender"],
      });
      for (const candidate of membersLackingDifferentiator) {
        blocked.add(candidate.messageId);
      }
    }

  }

  return { conflicts, blockedCandidateRefs: blocked };

}

// =========================
// 明示的time hintが、最有力候補(leading candidate)と矛盾し、かつ
// 別のcandidateがその日付と一致する場合(PART6 Material #2)。
// =========================

export interface TimeContradictionResult {
  conflicts: readonly ReferentConflict[];
  vetoedCandidateRefs: ReadonlySet<string>;
}

export function detectTimeContradictions(
  candidates: readonly CommunicationCandidate[],
  evidenceByCandidate: ReadonlyMap<string, readonly ReferentEvidence[]>,
  leadingCandidateRefs: readonly string[]
): TimeContradictionResult {

  const conflicts: ReferentConflict[] = [];
  const vetoed = new Set<string>();

  for (const leadingRef of leadingCandidateRefs) {

    const leadingEvidence = evidenceByCandidate.get(leadingRef) ?? [];
    const leadingHasTimeMatch = leadingEvidence.some((e) => e.family === "candidate.time");

    if (leadingHasTimeMatch) {
      // leading candidate自身が既にtime evidenceを持っている場合、
      // 矛盾は無い(このcandidateがまさにその日付と一致している)。
      continue;
    }

    const otherWithTimeMatch = candidates.find(
      (c) => c.messageId !== leadingRef && (evidenceByCandidate.get(c.messageId) ?? []).some((e) => e.family === "candidate.time")
    );

    if (otherWithTimeMatch) {
      conflicts.push({
        severity: "material",
        reasonCode: "explicit_time_hint_contradicts_leading_candidate",
        candidateRefs: [leadingRef, otherWithTimeMatch.messageId],
        evidenceFamilies: ["candidate.time"],
      });
      vetoed.add(leadingRef);
    }

  }

  return { conflicts, vetoedCandidateRefs: vetoed };

}

// =========================
// Weak
// =========================
//
// missing threadId・unknown directionは、記録はするが単独では絶対に
// resolutionをblockしない(frozen、PART6 WEAK CONFLICTS)。
export function detectWeakConflicts(candidates: readonly CommunicationCandidate[]): readonly ReferentConflict[] {

  const conflicts: ReferentConflict[] = [];

  for (const candidate of candidates) {

    if (!candidate.threadId) {
      conflicts.push({
        severity: "weak",
        reasonCode: "thread_unknown",
        candidateRefs: [candidate.messageId],
      });
    }

    if (candidate.direction === "unknown") {
      conflicts.push({
        severity: "weak",
        reasonCode: "direction_unknown",
        candidateRefs: [candidate.messageId],
      });
    }

  }

  return conflicts;

}

// =========================
// DiscourseFocus vs Work mismatch (PART6 Material #3)
// =========================
//
// 絶対条件: Work解決ロジックを重複させない。ここでは
// 「discourseFocusTopがWork.subjectの部分文字列関係に無い」という
// 単純な構造チェックのみを行う——複雑な意味理解は一切行わない。
export function detectDiscourseWorkMismatch(
  discourseFocusTop: string | undefined,
  workSubject: string | undefined
): readonly ReferentConflict[] {

  if (!discourseFocusTop || !workSubject) {
    return [];
  }

  const comparison = compareSubjects(discourseFocusTop, workSubject);

  if (comparison !== "none") {
    return [];
  }

  return [
    {
      severity: "material",
      reasonCode: "discourse_focus_work_subject_mismatch",
      candidateRefs: [],
    },
  ];

}

export type { PinnedProvenance };
export { compareSenders, compareSubjects };
