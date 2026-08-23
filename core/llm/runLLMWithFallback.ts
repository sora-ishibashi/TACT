// =========================
// runLLMWithFallback (STEP168)
// =========================
//
// core/tools/search/searchWithFallback.ts(STEP151、Tavily→Braveの
// Provider横断フォールバック)と同じ思想をLLM層へ適用する。ただし
// 検索Fallback(複数Provider・順序リスト・0件判定を含む一般化された
// 設計)をそのまま流用せず、LLM層の既存型(LLMRequest/LLMResponse/
// LLMProviderError)に合わせて最小限の形で実装する。
//
// 責務分離(STEP168絶対条件9):
//   core/llm/index.ts の runLLM()
//     → 指定されたProviderを1回実行するだけの低レベルAPI(変更なし)
//   このファイルの runLLMWithFallback()
//     → Primaryを実行し、必要な場合のみSecondaryへ1回だけFallbackする
//
// STEP168の目的は「Brainが賢くProviderを選ぶ」ことではなく、
// 「OpenAIが一時的に利用不能でもWorkflowを止めない」ことである。
// そのため、Primary/SecondaryはSTEP168では固定(OpenAI→Claude)とし、
// effectiveModelTier・Brain・executionStrategy.tsのTier→Provider対応表は
// 一切変更しない。呼び出し元(core/workflow/runAgent.ts)が
// resolveExecutionStrategy()から得たrequestをそのままこの関数へ渡すだけ。

import type { Provider } from "../agent/types";
import {
  LLMRequest,
  LLMResponse,
  LLMProviderError,
  LLMProviderFailureReason,
} from "./types";
import { runLLM } from "./index";

// STEP168: Secondary ProviderはOpenAI→Claude固定。STEP166で実在・
// 利用可否を確認済みのモデルのみを使う(推測でモデル名を追加しない)。
const SECONDARY_PROVIDER: Provider = "claude";

const SECONDARY_MODEL = "claude-haiku-4-5-20251001";

// Fallback対象のエラー理由。一時的なProvider障害とみなせるものだけを
// 対象とする(STEP168絶対条件4)。認証失敗・不正リクエストは
// Secondaryへ送っても解決しないため対象外。
const FALLBACK_REASONS: readonly LLMProviderFailureReason[] = [
  "quota_exceeded",
  "rate_limited",
  "network_error",
];

// unit testから直接検証できるようexportする(副作用のない純粋関数)。
export function shouldFallback(
  error: unknown
): boolean {

  if (!(error instanceof LLMProviderError)) {
    return false;
  }

  return FALLBACK_REASONS.includes(error.reason);

}

export interface LLMFallbackResult {

  response: LLMResponse;

  // 実際に応答を返したProvider/Model。Fallbackが発生しなかった場合は
  // requestに渡されたprovider/modelとそのまま一致する。
  actualProvider: Provider;

  actualModel: string;

  // Fallbackが実際に発生したかどうか(呼び出し元のログ・診断用途)。
  usedFallback: boolean;

}

// Primaryを実行し、FALLBACK_REASONSに該当するLLMProviderErrorが
// 発生した場合のみ、Secondary(Claude Haiku 4.5)へ1回だけ切り替える。
// Secondaryも失敗した場合はその例外をそのまま投げる(無限リトライ
// 禁止。STEP168絶対条件)。Fallback対象外のエラーは即座にそのまま
// 投げ、Secondaryへは切り替えない。
export async function runLLMWithFallback(
  request: LLMRequest,
  // unit testからPrimary/Secondaryの成否をモックできるようにするための
  // 依存性注入(省略時は実際のrunLLM()を使う。挙動は変わらない)。
  // TypeScriptコンパイル後のCJS出力ではmodule.exportsのプロパティが
  // getterのみで再代入できないため、モジュール差し替えによる
  // モックが行えない。この最小限の追加パラメータで対応する。
  runLLMImpl: typeof runLLM = runLLM
): Promise<LLMFallbackResult> {

  try {

    const response =
      await runLLMImpl(request);

    return {

      response,

      actualProvider: request.provider,

      // request.modelが省略された場合(Task Reconstruction等、
      // Execution Strategyを経由しない一部の既存呼び出し元)、
      // 実際に使われたモデル名はProvider実装側の既定値だが、ここでは
      // 呼び出し元が渡したrequest.model自体を「意図したモデル」として
      // 返す(既存のLLMResponseはmodel名を含まないため、それ以上の
      // 特定はできない。core/workflow/runAgent.tsの全呼び出しは
      // 既にresolveExecutionStrategy()経由で必ず具体的なmodel文字列を
      // 渡しているため、この経路では発生しない)。
      actualModel: request.model ?? "unknown",

      usedFallback: false,

    };

  } catch (error) {

    if (!shouldFallback(error)) {
      throw error;
    }

    const reason =
      error instanceof LLMProviderError
        ? error.reason
        : "unknown_error";

    console.warn(
      `[LLM Fallback] ${request.provider} failed (reason=${reason}). ` +
      `Falling back to ${SECONDARY_PROVIDER}/${SECONDARY_MODEL}.`
    );

    const fallbackRequest: LLMRequest = {

      ...request,

      provider: SECONDARY_PROVIDER,

      model: SECONDARY_MODEL,

    };

    // Secondaryも失敗した場合はここで例外がそのまま投げられる
    // (呼び出し元へ伝播する。OpenAIへ戻したりClaudeを再試行したり
    // しない。STEP168絶対条件5)。
    const response =
      await runLLMImpl(fallbackRequest);

    return {

      response,

      actualProvider: SECONDARY_PROVIDER,

      actualModel: SECONDARY_MODEL,

      usedFallback: true,

    };

  }

}
