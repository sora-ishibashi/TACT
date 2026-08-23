import { LLMRequest, LLMResponse } from "./types";
import { runOpenAI } from "./providers/openai";
import { runClaude } from "./providers/claude";

// =========================
// runLLM (STEP157)
// =========================
//
// STEP157以前は、request.providerの値に関わらず無条件にrunOpenAI()を
// 呼んでいた(Provider型は存在するが実行時には一切参照されていない
// 状態だった)。ここでrequest.providerを実際に参照するswitchへ変更する。
//
// STEP166: "claude"はcore/llm/providers/claude.tsとして実装し、
// .envにANTHROPIC_API_KEYが設定されたことを確認した上で接続した。
// "gemini"は引き続き対応する実装が存在せず、.envにも対応するAPI Keyが
// 設定されていないため、ダミー実装を追加せず、明示的に「未実装」で
// あることが分かるエラーを返す(core/tools/search/tavilyProvider.ts等の
// 既存Provider Registryパターンと同じ、「存在しないProviderは動く
// ふりをしない」という設計方針を踏襲する)。
//
// 重要: 現時点でrequest.providerが実際に"claude"になる呼び出し元は
// 存在しない(全Agent定義・全直接呼び出し元・executionStrategy.tsの
// 既定マッピングは引き続き"openai"固定のため、STEP166は既存の
// OpenAIモデル選択・Brain・effectiveModelTierの挙動を一切変更して
// いない)。このswitchは「Providerを選択できるアーキテクチャ」を
// 成立させ、Claude Provider自体を実際に呼び出し可能にするためのもの。
export async function runLLM(
  request: LLMRequest
): Promise<LLMResponse> {

  switch (request.provider) {

    case "openai":
      return await runOpenAI(request);

    case "claude":
      return await runClaude(request);

    case "gemini":
      throw new Error(
        `LLM provider "${request.provider}" is not yet implemented. ` +
        `Only "openai"/"claude" are currently configured in this environment.`
      );

    default: {

      // TypeScriptのexhaustive checkのため。Provider型に新しい値を
      // 追加した場合、ここでコンパイルエラーになる(対応する実装
      // 漏れを防ぐ)。
      const _exhaustiveCheck: never = request.provider;
      throw new Error(`Unknown LLM provider: ${_exhaustiveCheck}`);

    }

  }

}