// =========================
// TACT Referent — Resolution State Machine Regression (REF-P1c)
// =========================
//
// 対象: core/tact-referent/resolve.ts。PART20(Search Completeness)・
// PART21(Resolution)の必須testを、resolveReferent()への直接呼び出しで
// 検証する(fixture harness経由の統合検証はreferentHarness.test.tsが
// 別途行う)。

import { assessSearchCompleteness } from "../../../core/tact-referent/types";
import { resolveReferent, type ResolveReferentInput } from "../../../core/tact-referent/resolve";
import { candidate } from "./fixtures";
import { check, summarize, type CheckResult } from "../lib/check";
import type { ReferentSignal } from "../../../core/tact-referent/types";

function directSignal(kind: ReferentSignal["kind"], value: string): ReferentSignal {
  return { kind, value, directness: "direct", provenance: { kind: "current_trigger" } };
}

function baseInput(overrides: Partial<ResolveReferentInput>): ResolveReferentInput {
  return {
    candidates: [],
    signals: [],
    searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 0, ceilingHit: false }),
    requestType: "act",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const m1 = candidate({ messageId: "m1", normalizedSubject: "更新案件について", direction: "inbound" });

  // =========================
  // PART20 — Search Completeness
  // =========================

  // 1. broad, resultCount=1, ceiling=false -> WRITEは解決しない
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 1, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART20-1. broad, resultCount=1, ceiling=false -> resolvedにならない", result.state !== "resolved"));
  }

  // 2. broad, resultCount=19 -> WRITEは解決しない
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 19, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART20-2. broad, resultCount=19 -> resolvedにならない", result.state !== "resolved"));
  }

  // 3. broad, ceiling hit -> WRITEは解決しない
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 20, ceilingHit: true }),
    }));
    results.push(check("[REF-P1c resolve] PART20-3. broad, ceiling hit -> resolvedにならない", result.state !== "resolved"));
  }

  // 4. narrowed, below ceiling, strong unique evidence -> resolveできる
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART20-4. narrowed, below ceiling, 一意なTier A -> resolvedになる", result.state === "resolved"));
  }

  // 5. narrowed, ceiling hit -> resolveできない
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 20, ceilingHit: true }),
    }));
    results.push(check("[REF-P1c resolve] PART20-5. narrowed, ceiling hit -> resolvedにならない", result.state !== "resolved"));
  }

  // 6. provider unavailable -> narrow queryの結果に関わらずunavailable、
  // より弱いevidenceへのfallbackは無い
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
      sourceAvailability: "unavailable",
    }));
    results.push(
      check(
        "[REF-P1c resolve] PART20-6. sourceAvailability=unavailableは、たとえ強いevidenceがあってもunavailableを返す(fallback無し)",
        result.state === "unavailable"
      )
    );
  }

  // =========================
  // PART21 — Resolution
  // =========================

  const m2 = candidate({ messageId: "m2", normalizedSubject: "契約条件の確認", direction: "inbound" });

  // 1. exact unique Tier A + narrowed complete -> resolved
  {
    const result = resolveReferent(baseInput({
      candidates: [m1],
      signals: [directSignal("subject", "更新案件について")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART21-1. 一意なTier A + narrowed complete -> resolved", result.state === "resolved" && result.state === "resolved" && result.winner.messageId === "m1"));
  }

  // 2. Tier A + 2つ目の独立した適格candidate -> ambiguous
  {
    const result = resolveReferent(baseInput({
      candidates: [m1, m2],
      signals: [directSignal("subject", "更新案件について"), directSignal("subject", "契約条件の確認")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 2, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART21-2. Tier A + 2つ目の独立した適格candidate -> ambiguous(スコアでtiebreakしない)", result.state === "ambiguous"));
  }

  // 3. 2つの独立したTier B + narrowed complete -> 一意なら resolved
  {
    const withSenderAndTime = candidate({ messageId: "m3", sender: "tanaka@example.com", observedAt: "2026-09-10T00:00:00.000Z", direction: "inbound" });
    const other = candidate({ messageId: "m4", sender: "sato@example.com", observedAt: "2026-01-01T00:00:00.000Z", direction: "inbound" });
    const result = resolveReferent(baseInput({
      candidates: [withSenderAndTime, other],
      signals: [
        directSignal("sender", "tanaka@example.com"),
        { kind: "time", value: "2026-09-10", directness: "inferred", provenance: { kind: "current_trigger" } },
      ],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 2, ceilingHit: false }),
    }));
    results.push(
      check(
        "[REF-P1c resolve] PART21-3. 独立した2つのTier B(sender+time) + narrowed complete -> 一意なら resolved",
        result.state === "resolved" && result.state === "resolved" && result.winner.messageId === "m3"
      )
    );
  }

  // 4. subject+sender twinのみ -> resolveされない
  {
    const twinA = candidate({ messageId: "m-a", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const twinB = candidate({ messageId: "m-b", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const result = resolveReferent(baseInput({
      candidates: [twinA, twinB],
      signals: [directSignal("subject", "契約更新について"), directSignal("sender", "tanaka@example.com")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 2, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART21-4. subject+sender twinのみ -> resolvedにならない(conflicting_evidence)", result.state === "conflicting_evidence"));
  }

  // 5. twin + 第3の差別化要因 -> 一意なcandidateがresolveされうる
  {
    const twinA = candidate({ messageId: "m-a", threadId: "t1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const twinB = candidate({ messageId: "m-b", threadId: "t2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const result = resolveReferent(baseInput({
      candidates: [twinA, twinB],
      signals: [directSignal("subject", "契約更新について"), directSignal("sender", "tanaka@example.com")],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 2, ceilingHit: false }),
      knownThreadRef: { threadRef: "t2", provenance: { kind: "previous_pinned_referent", workId: "w1", slot: "primary" } },
    }));
    results.push(
      check(
        "[REF-P1c resolve] PART21-5. subject+sender twin + 第3の差別化要因(thread) -> 一意なcandidateがresolveされる",
        result.state === "resolved" && result.state === "resolved" && result.winner.messageId === "m-b"
      )
    );
  }

  // 6. 十分なevidenceが無い -> insufficient_evidence
  {
    const result = resolveReferent(baseInput({
      candidates: [candidate({ messageId: "m-lonely", direction: "inbound" })],
      signals: [],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART21-6. 十分なevidenceが無い -> insufficient_evidence", result.state === "insufficient_evidence"));
  }

  // 7. 実質的に矛盾するevidence -> conflicting_evidence
  {
    const leading = candidate({ messageId: "m-leading", normalizedSubject: "更新案件について", direction: "inbound" });
    const dateMatch = candidate({ messageId: "m-date", observedAt: "2026-09-10T00:00:00.000Z", direction: "inbound" });
    const result = resolveReferent(baseInput({
      candidates: [leading, dateMatch],
      signals: [
        directSignal("subject", "更新案件について"),
        { kind: "time", value: "2026-09-10", directness: "inferred", provenance: { kind: "current_trigger" } },
      ],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 2, ceilingHit: false }),
    }));
    results.push(check("[REF-P1c resolve] PART21-7. 明示的time hintが最有力candidateと矛盾する -> conflicting_evidence", result.state === "conflicting_evidence"));
  }

  // 8. provider unavailable -> unavailable
  {
    const result = resolveReferent(baseInput({ sourceAvailability: "unavailable" }));
    results.push(check("[REF-P1c resolve] PART21-8. provider unavailable -> unavailable", result.state === "unavailable"));
  }

  // 9. pinされたstale synthetic input -> stale
  {
    const result = resolveReferent(baseInput({ staleReferent: { reasonCode: "clarification_expired" } }));
    results.push(check("[REF-P1c resolve] PART21-9. staleReferent指定 -> stale", result.state === "stale"));
  }

  // 10. READで複数candidate -> ambiguous(安全でない自動解決ではない)
  {
    const readM1 = candidate({ messageId: "m1", normalizedSubject: "更新案件について", direction: "inbound" });
    const readM2 = candidate({ messageId: "m2", normalizedSubject: "更新案件の追加確認", direction: "inbound" });
    const result = resolveReferent(baseInput({
      candidates: [readM1, readM2],
      signals: [directSignal("subject", "更新案件")],
      requestType: "inspect",
      searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 2, ceilingHit: false }),
    }));
    results.push(
      check(
        "[REF-P1c resolve] PART21-10. READで複数candidateが同程度に一致する場合はambiguous(unsafeなresolvedにならない)",
        result.state === "ambiguous"
      )
    );
  }

  return summarize("referent/resolve", results);

}
