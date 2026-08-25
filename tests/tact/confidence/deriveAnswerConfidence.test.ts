// =========================
// deriveAnswerConfidence Regression (Phase 21)
// =========================
//
// 対象: core/tact-orchestrator/confidence.ts の deriveAnswerConfidence()。
// 純粋関数(ResearchResultの値だけから決定論的に算出)のため、
// Category A(Deterministic Evaluation)、実LLM/API呼び出み0件。
//
// Case A/Bは、Phase21 Step3で実際に実行したReality Test
// (「最新のiPhoneモデルについて調べて」「中京大学工学部の2025年度
// 入学者数について調べて」)の実測データをそのまま再現した回帰ケース。

import { deriveAnswerConfidence } from "../../../core/tact-orchestrator/confidence";
import type { ResearchResult, ResearchEvidenceItem, ResearchMetadata } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMetadata(overrides: Partial<ResearchMetadata> = {}): ResearchMetadata {
  return {
    executionMode: "web-research",
    llmAttempts: 1,
    llmSuccesses: 1,
    llmFailures: 0,
    searchQueryCount: 1,
    searchRequestCount: 1,
    searchAttempts: [],
    retrievedKnowledgeCount: 0,
    retrievedMemoryCount: 0,
    retrievedExampleCount: 0,
    usedKnowledgeCount: 0,
    usedMemoryCount: 0,
    usedExampleCount: 0,
    usedKnowledgeIds: [],
    usedMemoryIds: [],
    usedExampleIds: [],
    durationMs: 1000,
    mocked: false,
    requirementCount: 1,
    coveredRequirementCount: 0,
    partialRequirementCount: 0,
    missingRequirementCount: 1,
    gapQueries: [],
    safetyDowngradeCount: 0,
    ...overrides,
  };
}

function makeEvidence(confidence: "low" | "medium" | "high", id: string): ResearchEvidenceItem {
  return { id, claim: `claim-${id}`, confidence, source: `https://example.com/${id}` };
}

function makeResult(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    success: true,
    answer: "テスト回答",
    evidence: [],
    metadata: makeMetadata(),
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Phase21 Reality Test Case A実測再現: 「最新のiPhoneモデルに
  // ついて調べて」evidence 2件(high 1件+low 1件) -> partially_supported
  // (実測で確認したfalse certaintyケース: 従来はsuccess:trueとしか
  // 分からず、low confidence evidenceの存在が一切表現されなかった) ----
  {
    const result = makeResult({
      evidence: [makeEvidence("high", "e1"), makeEvidence("low", "e2")],
    });
    results.push(
      check(
        "[Phase21-CaseA] evidence(high+low混在) -> partially_supported",
        deriveAnswerConfidence(result) === "partially_supported"
      )
    );
  }

  // ---- Phase21 Reality Test Case B実測再現: 「中京大学工学部の2025
  // 年度入学者数について調べて」evidence 0件、success:true ->
  // insufficient_evidence(従来はsuccess:trueとしか分からなかった) ----
  {
    const result = makeResult({ evidence: [] });
    results.push(
      check(
        "[Phase21-CaseB] evidence 0件、success:true -> insufficient_evidence",
        deriveAnswerConfidence(result) === "insufficient_evidence"
      )
    );
  }

  // ---- 全EvidenceがhighまたはMedium -> supported ----
  {
    const result = makeResult({
      evidence: [makeEvidence("high", "e1"), makeEvidence("medium", "e2")],
    });
    results.push(
      check(
        "[Phase21] evidence全てhigh/medium -> supported",
        deriveAnswerConfidence(result) === "supported"
      )
    );
  }

  // ---- 単一evidenceがhigh -> supported ----
  {
    const result = makeResult({ evidence: [makeEvidence("high", "e1")] });
    results.push(
      check(
        "[Phase21] evidence 1件(high) -> supported",
        deriveAnswerConfidence(result) === "supported"
      )
    );
  }

  // ---- 絶対条件5: Task失敗(success:false)はAnswer Confidence対象外
  // (Execution confidenceと混同しない、undefinedを返す) ----
  {
    const result = makeResult({
      success: false,
      answer: "",
      evidence: [],
      errorMessage: "mock failure",
    });
    results.push(
      check(
        "[Phase21] success:false -> undefined(Execution confidenceと混同しない)",
        deriveAnswerConfidence(result) === undefined
      )
    );
  }

  // ---- core-only経路(evidence有り、全てhigh)でも同じロジックが働く ----
  {
    const result = makeResult({
      metadata: makeMetadata({ executionMode: "core-only" }),
      evidence: [makeEvidence("high", "e1")],
    });
    results.push(
      check(
        "[Phase21] core-only経路でもevidence基準で一貫して判定される",
        deriveAnswerConfidence(result) === "supported"
      )
    );
  }

  return summarize("deriveAnswerConfidence", results);

}
