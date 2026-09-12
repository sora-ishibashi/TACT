// =========================
// TACT Referent — Candidate Normalization + Evidence Extraction (REF-P1c)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit §7/§8/§17/§18で確定した、
// evidence family/tier modelを実装する。Gmailを一切呼ばない
// (CommunicationCandidateは既に正規化済み/syntheticな入力として
// 受け取るだけ)。
//
// 絶対条件(このphaseの明示的指示、frozen):
//   - 1つの根本的な事実(例: 1つのcandidate subject文字列)から
//     複数のfamily entryを水増ししない(§18 Correlated Evidence)。
//   - sender/company/Work.subject単体は絶対にTier Aにならない
//     (frozen rule #4/#5/#6)。
//   - 明示的に引用されたsubjectは、現在のeligible candidate universe内で
//     一意に一致する場合のみTier A(frozen rule #3、PART4)。
//   - contact解決・email address推測は一切行わない
//     (「田中さん」のような人名signalはcandidate.senderと比較不能
//     ——email addressしか持たないcandidate.senderとは別概念であり、
//     안전に比較できないため、このphaseでは意図的にevidenceを
//     生成しない。これは正直な既知の制限であり、バグではない)。

import type {
  CommunicationCandidate,
  EvidenceFamily,
  ReferentEvidence,
  ReferentSignal,
  ReferentSignalProvenance,
} from "./types";

// =========================
// Subject normalization (PART1/frozen)
// =========================
//
// Re:/RE:/re:/Fwd:/FW:/fw:/返信:/転送:の繰り返しprefixを保守的に除去
// する。意味のある差異(「更新案件について」 vs 「更新案件の追加確認」)
// は一切潰さない——除去対象は既知のprefix語彙のみで、本文中の任意の
// 語句/ticket ID/括弧を推測で削らない。
const SUBJECT_PREFIX_PATTERN = /^(?:re|fw|fwd)\s*[:：]\s*|^(?:返信|転送)\s*[:：]\s*/iu;

export function normalizeSubjectForComparison(rawSubject: string | undefined): string | undefined {

  if (!rawSubject) {
    return undefined;
  }

  // NFKC: 全角英数字→半角等の安全なUnicode正規化のみ(意味の異なる
  // 文字を同一視しない、既存repoのboundedText()等と同じ保守方針)。
  let normalized = rawSubject.normalize("NFKC").trim();

  let strippedSomething = true;
  while (strippedSomething) {
    const before = normalized;
    normalized = normalized.replace(SUBJECT_PREFIX_PATTERN, "").trim();
    strippedSomething = normalized !== before && normalized.length > 0;
  }

  normalized = normalized.replace(/\s+/gu, " ").trim();

  return normalized || undefined;

}

// 「shorter文字列が短すぎる偶然の部分一致」を避けるための最小長。
// CJK文字は1文字の情報量が大きいため、Latin文字ほど長い閾値を要求
// しない(「更新」「見積」のような2文字の実質的な語を許容しつつ、
// 1文字だけの偶然一致は除外する)。
const MIN_CONTAINS_LENGTH = 2;

export type SubjectComparisonResult = "exact" | "contains" | "none";

export function compareSubjects(
  a: string | undefined,
  b: string | undefined
): SubjectComparisonResult {

  const na = normalizeSubjectForComparison(a);
  const nb = normalizeSubjectForComparison(b);

  if (!na || !nb) {
    return "none";
  }

  if (na === nb) {
    return "exact";
  }

  if (na.length >= MIN_CONTAINS_LENGTH && nb.length >= MIN_CONTAINS_LENGTH) {
    if (na.includes(nb) || nb.includes(na)) {
      return "contains";
    }
  }

  return "none";

}

// =========================
// Sender normalization (PART1/frozen)
// =========================
//
// trim + (email形式に見える場合のみ)lowercase以外は一切行わない。
// display name解決・contact解決・企業名からのemail推測はしない。
const EMAIL_LIKE_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/u;

export function normalizeSenderForComparison(rawSender: string | undefined): string | undefined {

  if (!rawSender) {
    return undefined;
  }

  const trimmed = rawSender.trim();

  if (!trimmed) {
    return undefined;
  }

  return EMAIL_LIKE_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;

}

export function compareSenders(a: string | undefined, b: string | undefined): boolean {

  const na = normalizeSenderForComparison(a);
  const nb = normalizeSenderForComparison(b);

  return !!na && !!nb && na === nb;

}

// =========================
// Pinned / thread-anchor precondition input (PART9/PART12、frozen型を
// そのまま再利用するだけの補助shape)
// =========================
//
// P1cはClarification/Approval本体をまだwireしない
// (Design Freezeの明示的scope)。これらは「将来の本番inputを模した、
// resolver自身が生成しない外部precondition」として受け取るだけに
// とどめる。frozen ReferentSignalProvenanceをそのまま再利用し、
// 新しい並行語彙を作らない。

export type PinnedProvenance = Extract<
  ReferentSignalProvenance,
  { kind: "clarification_selection" } | { kind: "previous_pinned_referent" }
>;

export interface PinnedReferentInput {
  candidateRef: string;
  provenance: PinnedProvenance;
}

export interface KnownThreadRefInput {
  threadRef: string;
  provenance: PinnedProvenance;
}

function familyForPinnedProvenance(provenance: PinnedProvenance): "clarification.selection" | "prior_pinned_referent" {
  return provenance.kind === "clarification_selection" ? "clarification.selection" : "prior_pinned_referent";
}

// =========================
// Evidence extraction
// =========================

export interface ExtractCandidateEvidenceInput {
  candidates: readonly CommunicationCandidate[];
  signals: readonly ReferentSignal[];
  workSubject?: string;
  pinnedReferent?: PinnedReferentInput;
  knownThreadRef?: KnownThreadRefInput;
}

// 1つの(candidate, family)組み合わせにつき、最終的に残すevidenceは
// 常に最強のtierのものだけにする(§18 Correlated Evidence)。
// 同じfamilyへ複数回書き込まれた場合、より強いtierのみを保持する
// (A > B > C)。
const TIER_RANK: Record<ReferentEvidence["tier"], number> = { A: 3, B: 2, C: 1 };

function upsertStrongest(
  perFamily: Map<EvidenceFamily, ReferentEvidence>,
  candidateEvidence: ReferentEvidence
): void {

  const existing = perFamily.get(candidateEvidence.family);

  if (!existing || TIER_RANK[candidateEvidence.tier] > TIER_RANK[existing.tier]) {
    perFamily.set(candidateEvidence.family, candidateEvidence);
  }

}

function explicitSubjectSignals(signals: readonly ReferentSignal[]): readonly ReferentSignal[] {
  return signals.filter((signal) => signal.kind === "subject" && signal.provenance.kind !== "work_subject");
}

function explicitSenderSignals(signals: readonly ReferentSignal[]): readonly ReferentSignal[] {
  // 「田中さん」のような人名signalはcandidate.sender(email address)と
  // 安全に比較できないため、ここでは除外する(意図的な既知の制限、
  // ファイル冒頭コメント参照)。email形式のsignalのみを対象にする。
  return signals.filter(
    (signal) => signal.kind === "sender" && signal.provenance.kind !== "work_subject" && EMAIL_LIKE_PATTERN.test(signal.value)
  );
}

function inferredDateSignals(signals: readonly ReferentSignal[]): readonly ReferentSignal[] {
  return signals.filter((signal) => signal.kind === "time" && signal.directness === "inferred");
}

function observedDateOnly(observedAt: string | undefined): string | undefined {

  if (!observedAt) {
    return undefined;
  }

  const parsed = new Date(observedAt);

  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  // Date.now()は使わない——candidateが持つobservedAtという既存データを
  // そのまま解釈するだけ(決定論的、PART23)。
  const year = parsed.getUTCFullYear();
  const month = `${parsed.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getUTCDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;

}

/**
 * 全candidateに対して、explicit signal・Work.subject・
 * pinnedReferent・knownThreadRefとの照合を行い、candidateごとの
 * ReferentEvidence配列を返す(family/tierを問わず、candidate単位で
 * 最強のtierのみを各familyにつき1件保持する)。
 *
 * 「候補全体を見て一意性を判定する」という要件(PART4)があるため、
 * subject一致は先に全candidateへ対して集計してから、一意/重複を
 * 判定する。
 */
export function extractCandidateEvidence(
  input: ExtractCandidateEvidenceInput
): ReadonlyMap<string, readonly ReferentEvidence[]> {

  const perCandidate = new Map<string, Map<EvidenceFamily, ReferentEvidence>>();

  function familyMapFor(messageId: string): Map<EvidenceFamily, ReferentEvidence> {
    let map = perCandidate.get(messageId);
    if (!map) {
      map = new Map();
      perCandidate.set(messageId, map);
    }
    return map;
  }

  // ---- 1. pinned referent (Tier A, frozen rule: clarification選択/
  // 過去の承認済みpinは一意にcandidateを識別できる) ----
  if (input.pinnedReferent) {
    const target = input.candidates.find((c) => c.messageId === input.pinnedReferent!.candidateRef);
    if (target) {
      upsertStrongest(familyMapFor(target.messageId), {
        tier: "A",
        family: familyForPinnedProvenance(input.pinnedReferent.provenance),
        role: "supporting",
        provenance: input.pinnedReferent.provenance,
        reasonCode:
          input.pinnedReferent.provenance.kind === "clarification_selection"
            ? "clarification_selected"
            : "prior_pinned_match",
        candidateRef: target.messageId,
      });
    }
  }

  // ---- 2. explicit subject signals vs candidate subject ----
  // 一意性判定(PART4)のため、まず「どのsignal valueがどのcandidateと
  // 一致するか」を全件集計してから、一致件数に応じてtierを決める。
  for (const signal of explicitSubjectSignals(input.signals)) {

    const matches = input.candidates
      .map((candidate) => ({ candidate, result: compareSubjects(signal.value, candidate.normalizedSubject) }))
      .filter((entry) => entry.result !== "none");

    const exactMatches = matches.filter((entry) => entry.result === "exact");
    const containsMatches = matches.filter((entry) => entry.result === "contains");

    if (exactMatches.length === 1) {
      const [{ candidate }] = exactMatches;
      upsertStrongest(familyMapFor(candidate.messageId), {
        tier: "A",
        family: "candidate.subject",
        role: "supporting",
        provenance: signal.provenance,
        reasonCode: "subject_exact_unique",
        candidateRef: candidate.messageId,
      });
    } else if (exactMatches.length >= 2) {
      for (const { candidate } of exactMatches) {
        upsertStrongest(familyMapFor(candidate.messageId), {
          tier: "B",
          family: "candidate.subject",
          role: "supporting",
          provenance: signal.provenance,
          reasonCode: "subject_exact_duplicate",
          candidateRef: candidate.messageId,
        });
      }
    }

    for (const { candidate } of containsMatches) {
      upsertStrongest(familyMapFor(candidate.messageId), {
        tier: "C",
        family: "candidate.subject",
        role: "supporting",
        provenance: signal.provenance,
        reasonCode: "subject_partial_match",
        candidateRef: candidate.messageId,
      });
    }

  }

  // ---- 3. explicit email sender signals vs candidate.sender ----
  // frozen rule #4: senderは一意であってもTier Aにはならない。
  for (const signal of explicitSenderSignals(input.signals)) {
    for (const candidate of input.candidates) {
      if (compareSenders(signal.value, candidate.sender)) {
        upsertStrongest(familyMapFor(candidate.messageId), {
          tier: "B",
          family: "candidate.sender",
          role: "supporting",
          provenance: signal.provenance,
          reasonCode: "sender_exact_address",
          candidateRef: candidate.messageId,
        });
      }
    }
  }

  // ---- 4. Work.subject vs candidate subject (frozen rule #6: 常にB以下) ----
  if (input.workSubject) {
    for (const candidate of input.candidates) {
      const result = compareSubjects(input.workSubject, candidate.normalizedSubject);
      if (result === "exact") {
        upsertStrongest(familyMapFor(candidate.messageId), {
          tier: "B",
          family: "work.subject",
          role: "supporting",
          provenance: { kind: "work_subject" },
          reasonCode: "work_subject_overlap_exact",
          candidateRef: candidate.messageId,
        });
      } else if (result === "contains") {
        upsertStrongest(familyMapFor(candidate.messageId), {
          tier: "C",
          family: "work.subject",
          role: "supporting",
          provenance: { kind: "work_subject" },
          reasonCode: "work_subject_overlap_partial",
          candidateRef: candidate.messageId,
        });
      }
    }
  }

  // ---- 5. inferred date signals vs candidate.observedAt ----
  for (const signal of inferredDateSignals(input.signals)) {
    for (const candidate of input.candidates) {
      if (observedDateOnly(candidate.observedAt) === signal.value) {
        upsertStrongest(familyMapFor(candidate.messageId), {
          tier: "B",
          family: "candidate.time",
          role: "supporting",
          provenance: signal.provenance,
          reasonCode: "time_exact_day",
          candidateRef: candidate.messageId,
        });
      }
    }
  }

  // ---- 6. known thread ref (弱いanchor: messageId単位の一意性は無いが、
  // subject+sender twinを区別する第3のfamilyとしては機能する) ----
  if (input.knownThreadRef) {
    for (const candidate of input.candidates) {
      if (candidate.threadId && candidate.threadId === input.knownThreadRef.threadRef) {
        upsertStrongest(familyMapFor(candidate.messageId), {
          tier: "B",
          family: "candidate.thread",
          role: "supporting",
          provenance: input.knownThreadRef.provenance,
          reasonCode: "thread_match",
          candidateRef: candidate.messageId,
        });
      }
    }
  }

  const result = new Map<string, readonly ReferentEvidence[]>();
  for (const candidate of input.candidates) {
    const familyMap = perCandidate.get(candidate.messageId);
    result.set(candidate.messageId, familyMap ? [...familyMap.values()] : []);
  }

  return result;

}

// =========================
// Tier集計ヘルパー(resolve.ts / conflicts.tsが共有する)
// =========================

export function bestTier(evidence: readonly ReferentEvidence[]): "A" | "B" | "C" | undefined {
  if (evidence.some((e) => e.tier === "A")) return "A";
  if (evidence.some((e) => e.tier === "B")) return "B";
  if (evidence.some((e) => e.tier === "C")) return "C";
  return undefined;
}

export function tierBFamilies(evidence: readonly ReferentEvidence[]): ReadonlySet<EvidenceFamily> {
  return new Set(evidence.filter((e) => e.tier === "B").map((e) => e.family));
}
