// =========================
// TACT Referent — Conflict Detection Regression (REF-P1c)
// =========================
//
// 対象: core/tact-referent/conflicts.ts。PART19(Conflictに関する
// 必須test)を実装する。

import { extractCandidateEvidence } from "../../../core/tact-referent/candidates";
import {
  detectDiscourseWorkMismatch,
  detectFatalConflicts,
  detectSubjectSenderTwinConflicts,
  detectTimeContradictions,
  detectWeakConflicts,
} from "../../../core/tact-referent/conflicts";
import { candidate } from "./fixtures";
import { check, summarize, type CheckResult } from "../lib/check";
import type { ReferentSignal } from "../../../core/tact-referent/types";

function directSignal(kind: ReferentSignal["kind"], value: string): ReferentSignal {
  return { kind, value, directness: "direct", provenance: { kind: "current_trigger" } };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // 1. 同一subject+同一senderのtwinはMaterial conflictとしてblockされる
  {
    const m1 = candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const m2 = candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1, m2],
      signals: [directSignal("subject", "契約更新について"), directSignal("sender", "tanaka@example.com")],
    });
    const twin = detectSubjectSenderTwinConflicts([m1, m2], evidence);

    results.push(
      check(
        "[REF-P1c conflicts] 1. 同一subject+同一senderのtwinはMaterial conflictとして検出され、両candidateがblockedになる",
        twin.conflicts.length === 1 &&
          twin.conflicts[0].severity === "material" &&
          twin.blockedCandidateRefs.has("m1") &&
          twin.blockedCandidateRefs.has("m2")
      )
    );
  }

  // 2. twinのうち1件がthread(第3のfamily)を追加で持てば、blockedから
  // 除外される
  {
    const m1 = candidate({ messageId: "m1", threadId: "t1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const m2 = candidate({ messageId: "m2", threadId: "t2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [m1, m2],
      signals: [directSignal("subject", "契約更新について"), directSignal("sender", "tanaka@example.com")],
      knownThreadRef: { threadRef: "t2", provenance: { kind: "previous_pinned_referent", workId: "w1", slot: "primary" } },
    });
    const twin = detectSubjectSenderTwinConflicts([m1, m2], evidence);

    results.push(
      check(
        "[REF-P1c conflicts] 2. 第3の独立したfamily(candidate.thread)を持つcandidateは、subject+sender twinのblock対象から除外される",
        !twin.blockedCandidateRefs.has("m2") && twin.blockedCandidateRefs.has("m1")
      )
    );
  }

  // 3. threadIdが単に欠けているだけ(twin状況ではない)場合はWeak
  {
    const m1 = candidate({ messageId: "m1", direction: "inbound" });
    const weak = detectWeakConflicts([m1]);

    results.push(
      check(
        "[REF-P1c conflicts] 3. threadIdの欠如はWeak conflict(thread_unknown)として記録されるだけで、Materialにはならない",
        weak.some((c) => c.severity === "weak" && c.reasonCode === "thread_unknown") &&
          !weak.some((c) => c.severity === "material" && c.reasonCode.includes("thread"))
      )
    );
  }

  // 4. directionがunknownの場合もWeak(正のevidenceにはならない)
  {
    const m1 = candidate({ messageId: "m1", direction: "unknown" });
    const weak = detectWeakConflicts([m1]);
    const evidence = extractCandidateEvidence({ candidates: [m1], signals: [] });

    results.push(
      check(
        "[REF-P1c conflicts] 4. directionがunknownの場合はWeak conflict(direction_unknown)として記録され、candidate.direction向けの正のevidenceは一切生成されない",
        weak.some((c) => c.severity === "weak" && c.reasonCode === "direction_unknown") &&
          !(evidence.get("m1") ?? []).some((e) => e.family === "candidate.direction")
      )
    );
  }

  // 5. 明示的time hintが最有力candidateと矛盾し、別candidateがその日付
  // と一致する場合、最有力candidateはvetoされる
  {
    const leading = candidate({ messageId: "m-leading", direction: "inbound" });
    const dateMatch = candidate({ messageId: "m-date-match", observedAt: "2026-09-10T00:00:00.000Z", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [leading, dateMatch],
      signals: [{ kind: "time", value: "2026-09-10", directness: "inferred", provenance: { kind: "current_trigger" } }],
    });
    const contradiction = detectTimeContradictions([leading, dateMatch], evidence, ["m-leading"]);

    results.push(
      check(
        "[REF-P1c conflicts] 5. 明示的time hintが最有力candidateと矛盾し、別candidateがその日付と一致する場合、最有力candidateはMaterial conflictでvetoされる",
        contradiction.vetoedCandidateRefs.has("m-leading") && contradiction.conflicts.length === 1
      )
    );
  }

  // 6. 最有力candidate自身がtime一致を持つ場合、矛盾は検出されない
  {
    const leading = candidate({ messageId: "m-leading", observedAt: "2026-09-10T00:00:00.000Z", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [leading],
      signals: [{ kind: "time", value: "2026-09-10", directness: "inferred", provenance: { kind: "current_trigger" } }],
    });
    const contradiction = detectTimeContradictions([leading], evidence, ["m-leading"]);

    results.push(
      check(
        "[REF-P1c conflicts] 6. 最有力candidate自身がtime evidenceを持つ場合はveto対象にならない(誤検出しない)",
        !contradiction.vetoedCandidateRefs.has("m-leading") && contradiction.conflicts.length === 0
      )
    );
  }

  // 7. Fatal: pinされたreferentと矛盾する一意なsubject一致
  {
    const pinned = candidate({ messageId: "m-pinned", direction: "inbound" });
    const contradicting = candidate({ messageId: "m-contradicting", normalizedSubject: "更新案件について", direction: "inbound" });
    const evidence = extractCandidateEvidence({
      candidates: [pinned, contradicting],
      signals: [directSignal("subject", "更新案件について")],
      pinnedReferent: { candidateRef: "m-pinned", provenance: { kind: "clarification_selection", clarificationId: "c1" } },
    });
    const fatal = detectFatalConflicts([pinned, contradicting], evidence, "m-pinned");

    results.push(
      check(
        "[REF-P1c conflicts] 7. pinされたreferentと矛盾する一意なsubject一致はFatal conflictとして検出される(現行入力から安全に判定できる唯一のFatal rule)",
        fatal.length === 1 && fatal[0].severity === "fatal"
      )
    );
  }

  // 8. DiscourseFocusとWork.subjectの構造的な不一致はMaterialとして
  // 記録される(Work解決ロジックは重複させない、単純な部分文字列判定のみ)
  {
    const mismatch = detectDiscourseWorkMismatch("A社", "B社の更新案件");
    const noMismatch = detectDiscourseWorkMismatch("A社", "A社の更新案件");

    results.push(
      check(
        "[REF-P1c conflicts] 8. DiscourseFocusの現在topicとWork.subjectが構造的に無関係な場合はMaterial conflictとして記録され、部分文字列関係にある場合は記録されない",
        mismatch.length === 1 && mismatch[0].severity === "material" && noMismatch.length === 0
      )
    );
  }

  return summarize("referent/conflicts", results);

}
