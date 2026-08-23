// =========================
// runEvaluation (STEP170)
// =========================
//
// 評価専用の実行経路。本番Workflow(core/workflow/runAgent.ts)とは
// 完全に分離する。
//
//   Production routing:
//     TaskProfile → Brain → effectiveModelTier → ExecutionStrategy
//       → Provider/Model → runLLMWithFallback() → runLLM()
//
//   Evaluation routing:
//     EvaluationCase → 明示的なProvider/Model(ModelCandidate)
//       → runLLM() → EvaluationResult
//
// 重要: 評価系はcore/llm/runLLMWithFallback.tsを意図的に使わない。
// Fallbackが発火すると、評価対象として指定したProvider/Model
// (例: openai/gpt-4o)とは別のModelの結果が紛れ込み、「どのModelを
// 評価したか」が不正確になる(STEP170絶対条件3の趣旨に反する)。
// 評価中に対象Providerが失敗した場合は、素直にsuccess:falseとして
// 記録する(Fallbackで隠さない)。
//
// Brain・effectiveModelTier・TaskProfile・ExecutionStrategy・
// 本番ExecutionRecordはこのファイルから一切参照・変更しない。

import { randomUUID } from "crypto";
import { runLLM } from "../index";
import { EvaluationCase, ModelCandidate, EvaluationResult } from "./types";

// STEP170: evaluationIdは「1回の比較セッション」を表すIDであり、
// 個々のAPI呼び出し1回ごとのユニークIDではない。同じEvaluationCaseを
// 複数のModelCandidateへ投げて比較する場合、それら全ての結果が
// 同じevaluationIdを共有することで、後から「どの結果同士が同じ
// 比較対象だったか」を突き合わせられるようにする(単独で
// runEvaluation()を呼ぶ場合は、省略時に新規のIDが1件だけ発行される)。
export async function runEvaluation(
  evalCase: EvaluationCase,
  candidate: ModelCandidate,
  evaluationId: string = randomUUID(),
  // STEP168のrunLLMWithFallback()と同じ理由(TypeScriptコンパイル後の
  // CJS出力ではmodule.exportsのプロパティがgetterのみで再代入できず、
  // モジュール差し替えによるモックが行えない)で、unit testからの
  // 依存性注入を最小限のパラメータとして用意する(省略時は実際の
  // runLLM()を使う。挙動は変わらない)。
  runLLMImpl: typeof runLLM = runLLM
): Promise<EvaluationResult> {

  const startedAt = Date.now();

  try {

    const response =
      await runLLMImpl({
        provider: candidate.provider,
        model: candidate.model,
        systemPrompt: evalCase.systemPrompt,
        userPrompt: evalCase.userPrompt,
        responseFormat: evalCase.responseFormat,
      });

    const latencyMs =
      Date.now() - startedAt;

    return {

      evaluationId,

      caseId: evalCase.id,

      taskCategory: evalCase.category,

      provider: candidate.provider,

      model: candidate.model,

      success: true,

      response: response.content,

      inputTokens: response.usage?.inputTokens,

      outputTokens: response.usage?.outputTokens,

      totalTokens: response.usage?.totalTokens,

      estimatedUSD: response.cost?.estimatedUSD,

      latencyMs,

      createdAt: new Date().toISOString(),

    };

  } catch (error) {

    const latencyMs =
      Date.now() - startedAt;

    return {

      evaluationId,

      caseId: evalCase.id,

      taskCategory: evalCase.category,

      provider: candidate.provider,

      model: candidate.model,

      success: false,

      errorMessage:
        error instanceof Error
          ? error.message
          : String(error),

      latencyMs,

      createdAt: new Date().toISOString(),

    };

  }

}

// 同一のEvaluationCaseを複数のModelCandidateへ順番に投げ、結果配列を
// 返す。全結果に同じevaluationId(1回の比較セッションを表すID)を
// 発行することで、後から「このevaluationIdの結果群は互いに比較
// 可能」と判別できるようにする。
//
// 並列実行はコスト管理・レート制限の観点からあえて行わない
// (STEP170は評価基盤の設計・実装が目的であり、大量ベンチマークの
// 高速化は対象外)。1つのModelが失敗しても他のModelの評価は継続する
// (runEvaluation()自体が例外を投げずEvaluationResult.success:false
// を返すため、この関数でtry/catchする必要はない)。
export async function runEvaluationSuite(
  evalCase: EvaluationCase,
  candidates: ModelCandidate[],
  runLLMImpl: typeof runLLM = runLLM
): Promise<EvaluationResult[]> {

  const evaluationId = randomUUID();

  const results: EvaluationResult[] = [];

  for (const candidate of candidates) {

    results.push(
      await runEvaluation(evalCase, candidate, evaluationId, runLLMImpl)
    );

  }

  return results;

}
