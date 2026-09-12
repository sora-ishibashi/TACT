// =========================
// TACT Referent — Candidate Evidence Regression (REF-P1c)
// =========================
//
// 対象: core/tact-referent/candidates.ts。PART18(Evidenceに関する
// 必須test)を実装する。Slack/Gmail/Composio/Supabase/LLMのいずれにも
// 接続しない純粋関数のみのtest。

import {
  bestTier,
  compareSubjects,
  extractCandidateEvidence,
  tierBFamilies,
} from "../../../core/tact-referent/candidates";
import { candidate } from "./fixtures";
import { check, summarize, type CheckResult } from "../lib/check";
import type { ReferentEvidence, ReferentSignal } from "../../../core/tact-referent/types";

function directSignal(kind: ReferentSignal["kind"], value: string): ReferentSignal {
  return { kind, value, directness: "direct", provenance: { kind: "current_trigger" } };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // 1. 1つのcandidate subjectはcandidate.subject entryを高々1件しか
  // 生まない(exact matchとcontains matchの両方を誘発しうる複数signal
  // を与えても、familyは1件に収束する)。
  {
    const m1 = candidate({ messageId: "m1", normalizedSubject: "更新案件の追加確認", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1],
      signals: [
        directSignal("subject", "更新案件の追加確認"), // exact
        directSignal("subject", "更新案件"), // contains(部分一致)
      ],
    });
    const subjectEntries = (evidence.get("m1") ?? []).filter((e) => e.family === "candidate.subject");

    results.push(
      check(
        "[REF-P1c candidates] 1. 複数signalが同じcandidate.subjectへexact/containsの両方で一致しても、familyは1件だけ残る(最強tierのみ保持)",
        subjectEntries.length === 1 && subjectEntries[0].tier === "A"
      )
    );
  }

  // 2. 同一subjectから複数の一致パターン(exact/containsに相当)が
  // 生じても、families自体が水増しされない(1で検証済みのtier優先
  // 収束に加え、familyの「種類数」も1のままであることを確認)。
  {
    const m1 = candidate({ messageId: "m1", normalizedSubject: "TACTテスト商事 更新案件の追加確認", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1],
      signals: [
        directSignal("subject", "更新案件"),
        directSignal("subject", "追加確認"),
        directSignal("subject", "TACTテスト商事"),
      ],
    });
    const families = new Set((evidence.get("m1") ?? []).map((e) => e.family));

    results.push(
      check(
        "[REF-P1c candidates] 2. 同じcandidate subjectに対する複数の部分一致signalは、familyの種類数を1(candidate.subject)のまま保つ(§18 Correlated Evidence)",
        families.size === 1 && families.has("candidate.subject")
      )
    );
  }

  // 3. Work company/topic overlapはwork.subjectという1つのfamilyへ収束する
  {
    const m1 = candidate({ messageId: "m1", normalizedSubject: "更新のご相談について", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1],
      signals: [],
      workSubject: "更新のご相談",
    });
    const workEntries = (evidence.get("m1") ?? []).filter((e) => e.family === "work.subject");

    results.push(
      check(
        "[REF-P1c candidates] 3. Work.subjectとの一致はwork.subjectという1つのfamilyのみを生む",
        workEntries.length === 1
      )
    );
  }

  // 4. sender一致は1つのfamily
  {
    const m1 = candidate({ messageId: "m1", sender: "tanaka@example.com", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1],
      signals: [directSignal("sender", "tanaka@example.com")],
    });
    const senderEntries = (evidence.get("m1") ?? []).filter((e) => e.family === "candidate.sender");

    results.push(
      check(
        "[REF-P1c candidates] 4. 明示的なemail sender signalの一致はcandidate.senderという1つのfamilyのみを生み、常にTier B(Aにはならない、frozen rule#4)",
        senderEntries.length === 1 && senderEntries[0].tier === "B"
      )
    );
  }

  // 5. subject + senderは互いに独立した2つの事実として扱われる
  {
    const m1 = candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const m2 = candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1, m2],
      signals: [directSignal("subject", "契約更新について"), directSignal("sender", "tanaka@example.com")],
    });
    const families = new Set((evidence.get("m1") ?? []).map((e) => e.family));

    results.push(
      check(
        "[REF-P1c candidates] 5. subject一致とsender一致は別々のfamily(candidate.subject / candidate.sender)として、それぞれ独立に記録される",
        families.has("candidate.subject") && families.has("candidate.sender") && families.size === 2
      )
    );
  }

  // 6. 明示的な引用subjectは、候補内で一意な場合のみTier A
  {
    const uniqueMatch = extractCandidateEvidence({
      candidates: [candidate({ messageId: "m1", normalizedSubject: "更新案件について", direction: "inbound" })],
      signals: [directSignal("subject", "更新案件について")],
    });

    results.push(
      check(
        "[REF-P1c candidates] 6. 候補内で一意に一致する引用subjectはTier Aになる",
        (uniqueMatch.get("m1") ?? []).some((e) => e.tier === "A" && e.family === "candidate.subject")
      )
    );
  }

  // 7. 重複する引用subjectはTier Aから降格する
  {
    const duplicateMatch = extractCandidateEvidence({
      candidates: [
        candidate({ messageId: "m1", normalizedSubject: "更新案件について", direction: "inbound" }),
        candidate({ messageId: "m2", normalizedSubject: "更新案件について", direction: "inbound" }),
      ],
      signals: [directSignal("subject", "更新案件について")],
    });

    const m1Evidence = duplicateMatch.get("m1") ?? [];
    const m2Evidence = duplicateMatch.get("m2") ?? [];

    results.push(
      check(
        "[REF-P1c candidates] 7. 2件が同じ引用subjectに一致する場合、いずれもTier Aにならず、Tier B(subject_exact_duplicate)に降格する",
        !m1Evidence.some((e) => e.tier === "A") &&
          !m2Evidence.some((e) => e.tier === "A") &&
          m1Evidence.some((e) => e.tier === "B" && e.reasonCode === "subject_exact_duplicate") &&
          m2Evidence.some((e) => e.tier === "B" && e.reasonCode === "subject_exact_duplicate")
      )
    );
  }

  // 8. Tier CはWRITE適格性(tierBFamilies)に一切カウントされない
  {
    const evidence: ReferentEvidence[] = [
      { tier: "C", family: "candidate.subject", role: "supporting", provenance: { kind: "current_trigger" }, reasonCode: "subject_partial_match", candidateRef: "m1" },
    ];

    results.push(
      check(
        "[REF-P1c candidates] 8. Tier Cのevidenceはtier B family集合に含まれない(WRITE適格性判定から構造的に除外される)",
        tierBFamilies(evidence).size === 0 && bestTier(evidence) === "C"
      )
    );
  }

  // 9. 10件のTier C signalでもWRITEには不十分(tier B family集合が空のまま)
  {
    const families: readonly import("../../../core/tact-referent/types").EvidenceFamily[] = [
      "candidate.subject", "candidate.sender", "candidate.thread", "candidate.time", "candidate.direction",
      "slack.explicit_subject", "slack.explicit_sender", "work.subject", "clarification.selection", "prior_pinned_referent",
    ];
    const tenTierCEntries: ReferentEvidence[] = families.map((family) => ({
      tier: "C",
      family,
      role: "supporting",
      provenance: { kind: "current_trigger" },
      reasonCode: "weak_supporting_context",
      candidateRef: "m1",
    }));

    results.push(
      check(
        "[REF-P1c candidates] 9. 10件のTier C evidence(10種類のfamilyすべて)を与えても、tier B family集合は空のままであり、WRITE適格性(2 Tier-B family)を一切満たさない",
        tierBFamilies(tenTierCEntries).size === 0
      )
    );
  }

  // 10. candidate側は本文/snippetを一切持たないため、historical/
  // 非authoritativeなcontentがTier Aの根拠になることは構造的に無い。
  {
    const m1 = candidate({ messageId: "m1", normalizedSubject: "更新案件について", direction: "inbound" });

    results.push(
      check(
        "[REF-P1c candidates] 10. CommunicationCandidateの型にbody/snippet相当のfieldが無く、evidence抽出もそれらを一切読まない(historical contentがTier Aの根拠になり得ない、構造的に保証)",
        !("body" in m1) && !("snippet" in m1) && !("bodyText" in m1)
      )
    );
  }

  // 補助: compareSubjectsが意味のある差異を潰さないこと
  {
    results.push(
      check(
        "[REF-P1c candidates] 補助: 「更新案件について」と「更新案件の追加確認」は同一視されない",
        compareSubjects("更新案件について", "更新案件の追加確認") === "none"
      )
    );
  }

  return summarize("referent/candidates", results);

}
