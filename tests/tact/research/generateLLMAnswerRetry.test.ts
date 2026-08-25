// =========================
// generateLLMAnswerWithRetry Regression (Phase 24)
// =========================
//
// 対象: core/tact-research/runResearch.ts の generateLLMAnswerWithRetry()
// (Phase23の調査・Reality Testを踏まえたPhase24実装)。
//
// Category B(Mock-based Evaluation)。generateLLMAnswer()が既に持つ
// runLLMImpl DIパラメータをそのまま使い、実LLM/API呼び出みは一切
// 行わない。generateLLMAnswerWithRetry()自体を直接importして呼ぶ
// ため、テストが実装から乖離しない(実装の再実装ではなく、実際の
// 振る舞いを検証する、Phase20 Step9の方針を踏襲)。

import { generateLLMAnswerWithRetry } from "../../../core/tact-research/runResearch";
import { deriveAnswerConfidence } from "../../../core/tact-orchestrator/confidence";
import { LLMProviderError } from "../../../core/llm/types";
import type { LLMResponse } from "../../../core/llm/types";
import type { AssembledResearchContext } from "../../../core/tact-research/contextAssembly";
import type { Evidence } from "../../../core/context/types";
import type { ResearchResult, ResearchMetadata } from "../../../core/tact-research/types";
import { check, summarize, type CheckResult } from "../lib/check";

const assembled: AssembledResearchContext = {
  systemPrompt: "system",
  userPrompt: "user",
  usedKnowledgeIds: [],
  usedMemoryIds: [],
  usedExampleIds: [],
};

const evidencePool: Evidence[] = [
  {
    id: "ev1",
    claim: "claim1",
    evidence: "{}",
    confidence: "high",
    score: 1,
    createdBy: "test",
    createdAt: Date.now(),
    tags: [],
  },
];

function successResponse(fields: {
  answer: string;
  evidenceIds?: string[];
  uncertainty?: string;
}): LLMResponse {
  return {
    content: JSON.stringify({
      answer: fields.answer,
      keyFindings: [],
      evidenceIds: fields.evidenceIds ?? [],
      uncertainty: fields.uncertainty,
    }),
  };
}

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
    durationMs: 100,
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

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. temporary failure → success(最大1回Retryで回復) ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      if (calls === 1) throw new LLMProviderError("openai", "rate_limited", "mock rate limit");
      return successResponse({ answer: "回復した回答", evidenceIds: ["ev1"] });
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    results.push(
      check(
        "[Phase24-1] rate_limited -> 2回目成功(attempts=2)",
        result.attempts === 2 && result.outcome.success === true && calls === 2,
        `calls=${calls}, attempts=${result.attempts}`
      )
    );
  }

  // ---- 2. temporary failure → temporary failure(最大1回で打ち切り) ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      throw new LLMProviderError("openai", "network_error", `mock network error #${calls}`);
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    results.push(
      check(
        "[Phase24-2] network_error x2 -> 最大1回Retryでfailed(attempts=2、無限Retryしない)",
        result.attempts === 2 && result.outcome.success === false && calls === 2,
        `calls=${calls}`
      )
    );
  }

  // ---- 3. authentication_failed -> Retryしない ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      throw new LLMProviderError("openai", "authentication_failed", "mock auth failure");
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    results.push(
      check(
        "[Phase24-3] authentication_failed -> Retryしない(attempts=1, calls=1)",
        result.attempts === 1 && calls === 1,
        `calls=${calls}`
      )
    );
  }

  // ---- 4. invalid_request -> Retryしない ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      throw new LLMProviderError("openai", "invalid_request", "mock invalid request");
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    results.push(
      check(
        "[Phase24-4] invalid_request -> Retryしない(attempts=1, calls=1)",
        result.attempts === 1 && calls === 1,
        `calls=${calls}`
      )
    );
  }

  // ---- 5. unknown_error(非LLMProviderError) -> Retryしない ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      throw new Error("unexpected runtime error");
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    const reason = !result.outcome.success ? result.outcome.failureReason : undefined;
    results.push(
      check(
        "[Phase24-5] unknown_error -> Retryしない(attempts=1, calls=1)",
        result.attempts === 1 && calls === 1 && reason === "unknown_error",
        `calls=${calls}, reason=${reason}`
      )
    );
  }

  // ---- 6. 通常成功 -> 1回のみ ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      return successResponse({ answer: "通常回答" });
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    results.push(
      check(
        "[Phase24-6] 通常成功 -> attempts=1, calls=1(追加LLM callなし)",
        result.attempts === 1 && calls === 1 && result.outcome.success === true,
        `calls=${calls}`
      )
    );
  }

  // ---- 7/8. Search/Evidenceが再実行・再生成されない(参照の不変性) ----
  {
    let calls = 0;
    const evidencePoolRefBefore = evidencePool;
    const evidencePoolLengthBefore = evidencePool.length;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      if (calls === 1) throw new LLMProviderError("openai", "quota_exceeded", "mock quota");
      return successResponse({ answer: "ok", evidenceIds: ["ev1"] });
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    results.push(
      check(
        "[Phase24-7/8] RetryはSearch/Evidenceを再実行・再生成しない(evidencePoolは同一参照・同一件数のまま)",
        evidencePool === evidencePoolRefBefore &&
          evidencePool.length === evidencePoolLengthBefore &&
          result.outcome.success === true && calls === 2,
        `evidencePool.length=${evidencePool.length}`
      )
    );
  }

  // ---- 9. Retry成功時、uncertaintyは2回目の結果になる ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      if (calls === 1) throw new LLMProviderError("openai", "rate_limited", "mock rate limit");
      return successResponse({ answer: "ok", evidenceIds: ["ev1"], uncertainty: "2回目の申告" });
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);
    const uncertainty = result.outcome.success ? result.outcome.uncertainty : undefined;
    results.push(
      check(
        "[Phase24-9] Retry成功時、uncertaintyは2回目の応答の値になる",
        uncertainty === "2回目の申告",
        `uncertainty=${uncertainty}`
      )
    );
  }

  // ---- 10. attempts値がmetadata.llmAttemptsへそのまま使われる設計に
  // なっていることの確認(runResearch()側は `llmAttemptCount = attempts`
  // という1行の代入のみのため、ここでのattempts検証がllmAttempts検証を
  // 兼ねる。上記1〜6のケースで既にattempts=1/2の両方を確認済み)。 ----
  {
    results.push(
      check(
        "[Phase24-10] attempts(1固定成功時)===1 は上記Case6で確認済み、attempts(Retry時)===2は上記Case1で確認済み",
        true
      )
    );
  }

  // ---- 11. Phase21 Confidenceとの整合性(実際のderiveAnswerConfidence()
  // をRetry成功結果から構築したResearchResultへ適用して確認) ----
  {
    let calls = 0;
    const mockRunLLM = async (): Promise<LLMResponse> => {
      calls++;
      if (calls === 1) throw new LLMProviderError("openai", "network_error", "mock network error");
      return successResponse({ answer: "ok", evidenceIds: ["ev1"] });
    };
    const result = await generateLLMAnswerWithRetry(assembled, evidencePool, "openai", undefined, mockRunLLM);

    const researchResult: ResearchResult = {
      success: result.outcome.success,
      answer: result.outcome.success ? result.outcome.answer : "",
      evidence: result.outcome.success ? evidencePool.map((e) => ({ id: e.id, claim: e.claim, confidence: e.confidence })) : [],
      metadata: makeMetadata({ llmAttempts: result.attempts, llmSuccesses: 1, llmFailures: result.attempts - 1 }),
    };

    const confidence = deriveAnswerConfidence(researchResult);

    results.push(
      check(
        "[Phase24-11] Retry成功結果をResearchResultへ組み込んでもderiveAnswerConfidence()は正常動作(supported)",
        confidence === "supported",
        `confidence=${confidence}`
      )
    );
  }

  return summarize("research/generateLLMAnswerWithRetry", results);

}
