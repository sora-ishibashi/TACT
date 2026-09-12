// =========================
// TACT Referent — Foundation / Evaluation Harness Regression (REF-P1a)
// =========================
//
// 対象: core/tact-referent/types.ts(canonical types)、
// tests/tact/referent/fixtures.ts(offline fixture)、
// tests/tact/referent/evaluation.ts(決定論的評価器)。
//
// 絶対条件(REF-P1a): resolver本体はまだ存在しない
// (core/tact-referent/には他にファイルが無い)。このtestは
// (1)新規typeがcleanにcompileすること、(2)fixture harnessが
// WRITE/READ/PREPAREのいずれも受け付けること、(3)
// WRONG_TARGET_AUTO_RESOLUTIONとUNSAFE_AUTO_RESOLUTIONを別々に
// 集計できること、(4)search completenessの精密なinvariant
// (broad entity-only searchはWRITE-safeにならない)、
// (5)候補/provenance型に本文・snippet・Composio固有fieldが
// 含まれないこと、(6)ネットワーク/環境変数依存が無いこと、
// (7)決定論的であることを検証する。実際のresolution判定ロジック
// (discourse再構築・signal抽出・candidate生成・evidence評価・
// conflict検出)はP1b/P1c以降のscopeであり、ここでは一切実装しない
// ——このtest自身がsyntheticなReferentResolution値を組み立てて
// 評価器を検証する。

import {
  assessSearchCompleteness,
  isWriteSearchComplete,
  type CommunicationCandidate,
  type DiscourseFocus,
  type ReferentConflict,
  type ReferentEvidence,
  type ReferentResolution,
  type ReferentSignal,
  type SourceReferentSnapshot,
} from "../../../core/tact-referent/types";
import { REFERENT_FIXTURES, type ReferentFixture } from "./fixtures";
import { classifyFixtureOutcome, evaluateReferentFixtures } from "./evaluation";
import { check, summarize, type CheckResult } from "../lib/check";

function findFixture(id: string): ReferentFixture {
  const fixture = REFERENT_FIXTURES.find((candidateFixture) => candidateFixture.id === id);
  if (!fixture) {
    throw new Error(`test setup error: fixture "${id}" not found`);
  }
  return fixture;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // 1. 新規domain typeがcleanにcompileすること
  // (各typeを実際に1つずつ構築できることをruntimeでも確認する)
  // =========================

  {
    const discourseFocus: DiscourseFocus = {
      topicStack: [
        { entityOrSubject: "A社", mentionIndex: 0, kind: "introduced" },
        { entityOrSubject: "B社", mentionIndex: 1, kind: "introduced" },
        { entityOrSubject: "A社", mentionIndex: 2, kind: "reactivated" },
      ],
    };

    const signal: ReferentSignal = {
      kind: "subject",
      value: "更新案件の追加確認",
      directness: "direct",
      provenance: { kind: "current_trigger" },
    };

    const candidate: CommunicationCandidate = {
      kind: "gmail_message",
      messageId: "m1",
      threadId: "t1",
      sender: "tanaka@example.com",
      normalizedSubject: "更新案件の追加確認",
      observedAt: "2026-09-11T02:00:00.000Z",
      direction: "inbound",
    };

    const snapshot: SourceReferentSnapshot = {
      sourceType: "gmail",
      sourceMessageRef: "m1",
      threadRef: "t1",
      sender: "tanaka@example.com",
      normalizedSubject: "更新案件の追加確認",
      observedAt: "2026-09-11T02:00:00.000Z",
    };

    const evidence: ReferentEvidence = {
      tier: "A",
      family: "clarification.selection",
      role: "supporting",
      provenance: { kind: "clarification_selection", clarificationId: "c1" },
      reasonCode: "user_selected_pinned_candidate",
      candidateRef: "m1",
    };

    const conflict: ReferentConflict = {
      severity: "material",
      reasonCode: "subject_and_sender_twin_without_third_differentiator",
      candidateRefs: ["m1", "m2"],
      evidenceFamilies: ["candidate.subject", "candidate.sender"],
    };

    const resolutions: ReferentResolution[] = [
      { state: "resolved", winner: candidate, evidence: [evidence], conflicts: [], searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }) },
      { state: "ambiguous", candidates: [candidate], evidence: [evidence], conflicts: [conflict] },
      { state: "insufficient_evidence", candidateCount: 1, reasonCode: "broad_entity_only_search" },
      { state: "conflicting_evidence", candidates: [candidate], conflicts: [conflict] },
      { state: "stale", reasonCode: "clarification_expired", priorReferent: snapshot },
      { state: "unavailable", reasonCode: "provider_timeout" },
    ];

    results.push(
      check(
        "[REF-P1a] 全canonical type(DiscourseFocus/ReferentSignal/CommunicationCandidate/SourceReferentSnapshot/ReferentEvidence/ReferentConflict/ReferentResolutionの全state)がcleanに構築できる",
        discourseFocus.topicStack.length === 3 &&
          signal.directness === "direct" &&
          candidate.direction === "inbound" &&
          snapshot.sourceType === "gmail" &&
          evidence.tier === "A" &&
          conflict.severity === "material" &&
          resolutions.length === 6 &&
          resolutions.every((resolution) => typeof resolution.state === "string")
      )
    );
  }

  // =========================
  // 2. fixture harnessがWRITE/READ/PREPAREのいずれも受け付ける
  // =========================

  {
    const requestTypes = new Set(REFERENT_FIXTURES.map((fixture) => fixture.requestType));
    results.push(
      check(
        "[REF-P1a] seed fixtureはrequestType act(WRITE)/inspect(READ)/prepare(PREPARE)のいずれも含む",
        requestTypes.has("act") && requestTypes.has("inspect") && requestTypes.has("prepare")
      )
    );
  }

  // =========================
  // 3〜4. correct/wrong-target/unsafe/correct-clarificationの区別、
  // かつWRONG_TARGET_AUTO_RESOLUTIONとUNSAFE_AUTO_RESOLUTIONが別集計
  // であることを、synthetic(手組み)なReferentResolutionで検証する。
  // =========================

  {
    const exactSubjectFixture = findFixture("WRITE_EXACT_SUBJECT_UNIQUE");
    const correctWinner: CommunicationCandidate = { kind: "gmail_message", messageId: "m1", direction: "inbound" };
    const wrongWinner: CommunicationCandidate = { kind: "gmail_message", messageId: "m-wrong", direction: "inbound" };

    const correctResolution: ReferentResolution = {
      state: "resolved",
      winner: correctWinner,
      evidence: [],
      conflicts: [],
      searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
    };
    const wrongTargetResolution: ReferentResolution = { ...correctResolution, winner: wrongWinner };

    const correctOutcome = classifyFixtureOutcome(exactSubjectFixture, correctResolution);
    const wrongTargetOutcome = classifyFixtureOutcome(exactSubjectFixture, wrongTargetResolution);

    results.push(
      check(
        "[REF-P1a] ground truthどおりのwinnerを返すresolutionはcorrect_auto_resolutionと分類される",
        correctOutcome.outcome === "correct_auto_resolution"
      )
    );

    results.push(
      check(
        "[REF-P1a] ground truthと異なるwinnerを返すresolutionはwrong_target_auto_resolutionと分類される(unsafe_auto_resolutionとは別カテゴリ)",
        wrongTargetOutcome.outcome === "wrong_target_auto_resolution"
      )
    );

    // ambiguousが期待されるfixtureに対して、resolverが(誤って)自動解決した
    // 場合 —— winnerが正解であってもunsafe_auto_resolutionになるべき
    // (根拠不十分な自動解決自体が危険という、このphaseの核心的な区別)。
    const ambiguousFixture = findFixture("WRITE_AMBIGUOUS_TWO_CANDIDATES");
    const luckyButUnsafeResolution: ReferentResolution = {
      state: "resolved",
      winner: { kind: "gmail_message", messageId: "m1", direction: "inbound" },
      evidence: [],
      conflicts: [],
      searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 2, ceilingHit: false }),
    };
    const unsafeOutcome = classifyFixtureOutcome(ambiguousFixture, luckyButUnsafeResolution);

    results.push(
      check(
        "[REF-P1a] clarificationが期待されるfixtureに対しresolverが自動解決した場合、winnerの正誤に関わらずunsafe_auto_resolutionと分類される",
        unsafeOutcome.outcome === "unsafe_auto_resolution"
      )
    );

    const correctClarificationOutcome = classifyFixtureOutcome(ambiguousFixture, {
      state: "ambiguous",
      candidates: [],
      evidence: [],
      conflicts: [],
    });

    results.push(
      check(
        "[REF-P1a] clarificationが期待されるfixtureに対しresolverがambiguousを返した場合、correct_clarificationと分類される",
        correctClarificationOutcome.outcome === "correct_clarification"
      )
    );
  }

  // =========================
  // 4(続). evaluateReferentFixtures()の集計レベルで、両metricが
  // 独立にカウントされることを確認する。
  // =========================

  {
    const summary = evaluateReferentFixtures(REFERENT_FIXTURES, (fixture) => {
      if (fixture.id === "WRITE_EXACT_SUBJECT_UNIQUE") {
        // wrong target auto resolutionを1件発生させる
        return {
          state: "resolved",
          winner: { kind: "gmail_message", messageId: "m-not-the-real-winner", direction: "inbound" },
          evidence: [],
          conflicts: [],
          searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
        };
      }
      if (fixture.id === "WRITE_AMBIGUOUS_TWO_CANDIDATES") {
        // unsafe auto resolutionを1件発生させる
        return {
          state: "resolved",
          winner: { kind: "gmail_message", messageId: "m1", direction: "inbound" },
          evidence: [],
          conflicts: [],
          searchCompleteness: assessSearchCompleteness({ mode: "broad", resultCount: 2, ceilingHit: false }),
        };
      }
      // その他は「常にunavailable」という無害なsyntheticな応答にしておく
      // (このphaseでは正解率を最大化する意図は無く、2つのblocking
      // metricsが独立集計されることだけを確認すれば十分)。
      return { state: "unavailable", reasonCode: "no_resolver_implemented_yet" };
    });

    results.push(
      check(
        "[REF-P1a] evaluateReferentFixtures()はwrongTargetAutoResolutionとunsafeAutoResolutionを独立に、かつ意図どおりの件数で集計する",
        summary.total === REFERENT_FIXTURES.length &&
          summary.wrongTargetAutoResolution === 1 &&
          summary.unsafeAutoResolution === 1
      )
    );
  }

  // =========================
  // 5. broad vs narrowed search contextが表現でき、かつIMPORTANT SPEC
  // CLARIFICATIONのinvariant(broad entity-only searchはWRITE-safeに
  // ならない)が保たれていることを確認する。
  // =========================

  {
    const broadBelowCeiling = assessSearchCompleteness({ mode: "broad", resultCount: 1, ceilingHit: false });
    const narrowedBelowCeiling = assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false });
    const narrowedButCeilingHit = assessSearchCompleteness({ mode: "narrowed", resultCount: 20, ceilingHit: true });

    results.push(
      check(
        "[REF-P1a] IMPORTANT SPEC CLARIFICATION: broad entity-only searchは結果件数がceiling未満であってもWRITEのcandidate universe完全性を証明しない(proven=false)",
        broadBelowCeiling.proven === false && isWriteSearchComplete({ mode: "broad", resultCount: 1, ceilingHit: false }) === false
      )
    );

    results.push(
      check(
        "[REF-P1a] narrowed searchでceiling未満ならcandidate universe完全性が証明される(proven=true)",
        narrowedBelowCeiling.proven === true
      )
    );

    results.push(
      check(
        "[REF-P1a] narrowed searchであってもceiling到達時はproven=falseのまま(母集団の完全性は不明)",
        narrowedButCeilingHit.proven === false
      )
    );
  }

  // =========================
  // 6. search ceiling / candidate-universe不完全性が表現できる
  // (7つ目のresolution stateを増やさず、既存stateのreasonCodeで表現)
  // =========================

  {
    const ceilingFixture = findFixture("SEARCH_CEILING_REACHED");
    results.push(
      check(
        "[REF-P1a] SEARCH_CEILING_REACHED fixtureはsearchContext.ceilingHit=trueを表現し、resolution stateは既存6状態のうちinsufficient_evidenceを使う(7つ目のstateを増やしていない)",
        ceilingFixture.searchContext.ceilingHit === true &&
          ceilingFixture.expected.resolutionState === "insufficient_evidence"
      )
    );
  }

  // =========================
  // 7. candidate/snapshot形状に本文・snippetが含まれない
  // =========================

  {
    const forbiddenKeys = ["bodyText", "snippet", "body"];
    const candidateKeysOk = REFERENT_FIXTURES.every((fixture) =>
      fixture.gmailCandidates.every(
        (candidateItem) => !forbiddenKeys.some((key) => key in candidateItem)
      )
    );

    results.push(
      check(
        "[REF-P1a] 全fixtureのCommunicationCandidateにbodyText/snippet/body相当のfieldが一切含まれない",
        candidateKeysOk
      )
    );
  }

  // =========================
  // 8. SourceReferentSnapshotにComposio固有fieldが含まれない
  // =========================

  {
    const snapshot: SourceReferentSnapshot = {
      sourceType: "gmail",
      sourceMessageRef: "m1",
      threadRef: "t1",
      sender: "tanaka@example.com",
      normalizedSubject: "更新案件の追加確認",
      observedAt: "2026-09-11T02:00:00.000Z",
    };
    const keys = Object.keys(snapshot).map((key) => key.toLowerCase());
    const forbiddenSubstrings = ["composio", "connectedaccount", "connectionid", "rawpayload"];

    results.push(
      check(
        "[REF-P1a] SourceReferentSnapshotの型にComposio固有識別子・connectionId・生payload相当のfieldが一切無い(connectionIdは既存ApprovalSubjectが別途保持する、Design Freeze §17)",
        !keys.some((key) => forbiddenSubstrings.some((forbidden) => key.includes(forbidden)))
      )
    );
  }

  // =========================
  // 9. ネットワーク/環境変数依存がsource level でも無いこと
  // =========================

  {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repoRoot = join(__dirname, "..", "..", "..");

    // コメント行は説明目的で"Composio"等の語を含みうる(例: 「Composio
    // 固有IDを持たない」という設計意図の説明)——ここで検出したいのは
    // 実際のimport/呼び出しであり、コメント中の語そのものではないため、
    // "//"始まりの行を除いてからtokenを検索する(work/completionOwnership.test.ts
    // が採用している既存パターンと同じ、コメント中の語を誤検出しない
    // ための絞り込み)。
    const stripLineComments = (source: string): string =>
      source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

    const sources = [
      readFileSync(join(repoRoot, "core/tact-referent/types.ts"), "utf-8"),
      readFileSync(join(repoRoot, "tests/tact/referent/fixtures.ts"), "utf-8"),
      readFileSync(join(repoRoot, "tests/tact/referent/evaluation.ts"), "utf-8"),
    ]
      .map(stripLineComments)
      .join("\n");

    // case-insensitiveで見て問題ない語(vendor/package名。このrepoの
    // domain語彙とは衝突しない)。
    const forbiddenTokensCaseInsensitive = [
      "supabase",
      "composio",
      "process.env",
      "fetch(",
      "openai",
      "@slack",
    ];
    const lowerSources = sources.toLowerCase();

    // "SLACK_"は大文字小文字を区別してcase-sensitiveにチェックする——
    // 環境変数命名慣習(SLACK_SIGNING_SECRET等)は常に全て大文字だが、
    // このrepoのdomain語彙には"slack_message_ref"のような小文字の
    // discriminant値が正当に存在するため、大文字小文字を無視すると
    // 誤検出する。
    const hasUppercaseSlackEnvToken = /SLACK_[A-Z]/.test(sources);

    results.push(
      check(
        "[REF-P1a] canonical types/fixture/evaluationのいずれのsourceにも実際のimport/呼び出しとしてnetwork/環境変数/Provider SDK依存を示すtokenが含まれない(コメント中の説明的言及・小文字のdomain discriminant値は除く)",
        !forbiddenTokensCaseInsensitive.some((token) => lowerSources.includes(token.toLowerCase())) &&
          !hasUppercaseSlackEnvToken
      )
    );
  }

  // =========================
  // 10. fixture IDが一意
  // =========================

  {
    const ids = REFERENT_FIXTURES.map((fixture) => fixture.id);
    results.push(
      check(
        "[REF-P1a] 全seed fixtureのidは一意である",
        new Set(ids).size === ids.length
      )
    );
  }

  // =========================
  // 11. harness出力が決定論的
  // =========================

  {
    // fixtureのexpected.resolutionStateをそのまま折り返すだけの、
    // 決定論性の検証専用syntheticなresolve()(判定ロジックのfitness自体
    // はここでは検証しない——各stateのcompleteな形を組み立てられる
    // ことだけを目的とする、安全なtype castを一切使わないswitch)。
    const replayExpectedState = (fixture: ReferentFixture): ReferentResolution => {

      switch (fixture.expected.resolutionState) {

        case "resolved":
          return {
            state: "resolved",
            winner: { kind: "gmail_message", messageId: fixture.expected.winnerMessageId ?? "unknown", direction: "inbound" },
            evidence: [],
            conflicts: [],
            searchCompleteness: assessSearchCompleteness({ mode: "narrowed", resultCount: 1, ceilingHit: false }),
          };

        case "ambiguous":
          return { state: "ambiguous", candidates: [], evidence: [], conflicts: [] };

        case "insufficient_evidence":
          return { state: "insufficient_evidence", candidateCount: 0, reasonCode: "deterministic_fixture_replay" };

        case "conflicting_evidence":
          return { state: "conflicting_evidence", candidates: [], conflicts: [] };

        case "stale":
          return { state: "stale", reasonCode: "deterministic_fixture_replay" };

        case "unavailable":
          return { state: "unavailable", reasonCode: "deterministic_fixture_replay" };

      }

    };

    const first = evaluateReferentFixtures(REFERENT_FIXTURES, replayExpectedState);
    const second = evaluateReferentFixtures(REFERENT_FIXTURES, replayExpectedState);

    results.push(
      check(
        "[REF-P1a] 同一入力に対しevaluateReferentFixtures()は常に同一の集計結果を返す(決定論的)",
        JSON.stringify(first) === JSON.stringify(second)
      )
    );
  }

  return summarize("referent/referentHarness", results);

}
