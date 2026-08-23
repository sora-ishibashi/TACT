// =========================
// llmAnswer (STEP180/184)
// =========================
//
// ⑤LLM 1回。Research Pipeline全体でLLMを呼び出す唯一の場所。
// core/llm/index.tsのrunLLM()(Provider横断の低レベル単発実行関数、
// STEP157/166で確立済み)を直接呼び出す。core/llm/runLLMWithFallback.ts
// (Legacy Workflowのフォールバック専用に設計された層)は使わない
// (STEP180絶対条件: TACT Researchは独立した経路として
// Core→CODE/SEARCH→LLMを持つ。core/llm/evaluation/runEvaluation.ts
// (STEP170)が同じ理由でrunLLM()を直接呼び、runLLMWithFallback()を
// 使わないのと同じ判断)。
//
// modelTier/ExecutionStrategyには依存しない。requestのmodelを省略し、
// 各Provider実装側の既定モデル(例: core/llm/providers/openai.tsの
// "gpt-4o-mini")をそのまま使う(Brain/TaskProfileを一切経由しない)。
//
// STEP184: 「LLM呼び出しを実際に試行したか」をrunResearch()側が
// catchで事後的に推測する設計をやめ(STEP181/182で「応答は受信した
// がJSON parseに失敗した場合もllmCalls=0になる」問題が実際に
// 発生・確認された)、この関数自身が「試行が起きたことは確定してい
// るが、結果が成功か失敗か」を判別可能な戻り値(LLMAnswerOutcome、
// 判別可能Union)として返すよう再設計した。
//
// 重要: この関数はもはや例外を投げない(想定される失敗経路
// (Provider呼び出し失敗/空応答/JSON parse失敗)はすべて
// success:falseの戻り値として表現する)。呼び出し元
// (runResearch.ts)は、この関数を呼び出した時点で
// 「llmAttemptsは必ず1」と判断してよく、成功/失敗はreturn値の
// successフィールドだけで判別できる。
//
// DI(runLLMImpl)について: 既存のruLLMWithFallback()・
// runEvaluation()と同じ確立済みパターン。TypeScriptコンパイル後の
// CJS exportはgetter-onlyで直接差し替えられないため、テストで
// モックを注入できるようデフォルト引数として受け取る。本番呼び出し元
// (runResearch.ts)はこの引数を省略するため、挙動は変わらない。

import { runLLM } from "../llm";
import { LLMProviderError } from "../llm/types";
import { validateEvidenceIds } from "../evidence/validateEvidenceIds";
import type { Evidence } from "../context/types";
import type { AssembledResearchContext } from "./contextAssembly";
import type { ResearchLLMFailureReason } from "./types";
// STEP193: core/llmが既に使っているProvider型をそのまま再利用する
// (types.tsのResearchOptions.llmProviderと同じ型)。新しいProvider
// 抽象は作らない。
import type { Provider } from "../agent/types";

export interface LLMAnswerSuccess {

  success: true;

  answer: string;

  keyFindings: string[];

  evidenceIds: string[];

  uncertainty?: string;

}

export interface LLMAnswerFailure {

  success: false;

  failureReason: ResearchLLMFailureReason;

  errorMessage: string;

}

export type LLMAnswerOutcome = LLMAnswerSuccess | LLMAnswerFailure;

function cleanJSON(text: string): string {

  return text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

}

export async function generateLLMAnswer(
  assembled: AssembledResearchContext,
  evidencePool: Evidence[],
  // STEP193: 呼び出し元(runResearch.ts)がResearchOptions.llmProviderを
  // 渡す。省略時(既存の全呼び出し・既存挙動)は従来どおりOpenAIを使う。
  // Research層はここでもProvider固有の分岐を書かず、値をそのまま
  // runLLM()へ渡すだけ(絶対条件3)。
  provider: Provider = "openai",
  // Phase 7: ResearchOptions.llmModelと同じ位置づけ。省略時
  // (undefined)はrunLLM()→各Provider実装側の既定モデルへそのまま
  // フォールバックする(既存のmodel省略時の挙動と完全に同じ)。
  model?: string,
  runLLMImpl: typeof runLLM = runLLM
): Promise<LLMAnswerOutcome> {

  let response;

  try {

    response = await runLLMImpl({

      provider,

      model,

      systemPrompt: assembled.systemPrompt,

      userPrompt: assembled.userPrompt,

      responseFormat: "json",

    });

  } catch (error) {

    // STEP184: APIリクエスト自体は試行された(呼び出し元は
    // llmAttempts=1として扱ってよい)が、Provider側で失敗した
    // ケース。core/llm/types.tsのLLMProviderError.reasonを
    // そのまま再利用する(新しいエラー体系を二重に作らない、
    // というSTEP184絶対条件)。
    const failureReason: ResearchLLMFailureReason =
      error instanceof LLMProviderError
        ? error.reason
        : "unknown_error";

    return {

      success: false,

      failureReason,

      errorMessage:
        error instanceof Error ? error.message : String(error),

    };

  }

  const cleaned = cleanJSON(response.content ?? "");

  if (!cleaned) {

    // STEP184: APIリクエストには成功したが、応答の中身が空だった
    // ケース。Provider errorとは区別する。
    return {

      success: false,

      failureReason: "empty_response",

      errorMessage: "TACT Research LLM returned an empty response.",

    };

  }

  let parsed: {

    answer?: unknown;

    keyFindings?: unknown;

    evidenceIds?: unknown;

    uncertainty?: unknown;

  };

  try {

    parsed = JSON.parse(cleaned);

  } catch (error) {

    // STEP184最重要ケース: LLM呼び出し自体(APIリクエスト)は成功し、
    // 応答も受信したが、JSONとして解析できなかった場合。
    // STEP181/182で「この場合もllmCalls=0になり、実際には1回分の
    // API消費が発生しているのに0回と記録される」問題が確認された。
    // ここでresponse_parse_errorという専用理由を返すことで、
    // 呼び出し元は「llmAttempts=1・llmFailures=1」として正しく
    // 記録できるようになる。
    return {

      success: false,

      failureReason: "response_parse_error",

      errorMessage:
        error instanceof Error ? error.message : String(error),

    };

  }

  const rawEvidenceIds =
    Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds : [];

  // 既存のcore/evidence/validateEvidenceIds()をそのまま再利用する
  // (STEP180絶対条件9: LLMが返したevidenceIdsの実在性検証はCODEの
  // 仕事であり、LLMに再確認させない)。validateEvidenceIds()は
  // 「フィールド名 → 配列 → 各要素がevidenceIdsを持つ」という
  // Analyst/Writer向けの形を前提とするため、Research LLMのフラットな
  // evidenceIds配列を単一要素配列でラップして渡す(新しいID検証
  // ロジックは実装しない)。
  const { cleaned: validated } = validateEvidenceIds(
    { result: [{ evidenceIds: rawEvidenceIds }] },
    evidencePool,
    ["result"]
  );

  const validatedResult =
    validated.result as { evidenceIds?: unknown }[] | undefined;

  const validEvidenceIds = validatedResult?.[0]?.evidenceIds;

  return {

    success: true,

    answer:
      typeof parsed.answer === "string" ? parsed.answer : "",

    keyFindings:
      Array.isArray(parsed.keyFindings)
        ? parsed.keyFindings.filter(
            (item): item is string => typeof item === "string"
          )
        : [],

    evidenceIds:
      Array.isArray(validEvidenceIds)
        ? validEvidenceIds.filter(
            (item): item is string => typeof item === "string"
          )
        : [],

    uncertainty:
      typeof parsed.uncertainty === "string" ? parsed.uncertainty : undefined,

  };

}
