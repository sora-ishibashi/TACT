import { executeEvidencePipeline } from "./evidence";
import { runTool } from "../runTool";
import { TactToolRequest } from "../types";
import { resolveSearchStrategy } from "../search/searchStrategy";
import { SearchIntensity } from "../../workflow/taskProfile";

export async function executeToolPipeline(
  request: TactToolRequest,
  userInput: string,
  // STEP158: context.taskProfile.searchIntensityをそのまま受け取る。
  // 呼び出し元(executeToolCalls.ts)がcontextから解決して渡すだけで、
  // ここでは新しい判定を行わない。省略時(taskProfile未接続の
  // 呼び出し元)はresolveSearchStrategy()側が既存動作と同じ
  // fallbackを返す。
  searchIntensity?: SearchIntensity
) {

  // ===============================
  // web-search: Search Strategyの適用
  // ===============================
  //
  // 他のTool(markdown/figma/github/npm等)には一切影響しない、
  // web-search専用の分岐(既存のEvidence化分岐と同じ位置)。
  if (request.tool === "web-search") {

    const strategy = resolveSearchStrategy(searchIntensity);

    if (!strategy.enabled) {

      // searchIntensity === "none"。Search Providerを一切呼び出さず、
      // web-search成功時と同じdata形状(raw/evidence/provider)で
      // 空の結果を返す(呼び出し元のEvidence集約処理を分岐なしで
      // 通せるようにするため)。
      console.log(
        `[SearchStrategy] searchIntensity=none: skipping web-search provider call.`
      );

      return {

        success: true,

        data: {

          raw: [],

          evidence: [],

          provider: undefined,

        },

        skipped: true,

      };

    }

    const input = {
      ...(request.arguments ?? { input: userInput }),
      maxResults: strategy.maxResults,
      searchDepth: strategy.searchDepth,
    };

    const result =
      await runTool(
        request.tool,
        input
      );

    if (!result.success) {
      return result;
    }

    const evidence =
      executeEvidencePipeline(
        Array.isArray(result.data)
          ? result.data
          : []
      );

    console.log("");
    console.log("====================================");
    console.log("EVIDENCE PIPELINE");
    console.log(evidence);
    console.log("====================================");

    return {

      success: true,

      data: {

        raw: result.data,

        evidence,

        // STEP151: どのSearch Provider(tavily/brave)が実際に
        // 結果を返したかを、診断・ログ用途として引き継ぐ。
        // Evidence型自体のスキーマは変更していない。
        provider: result.provider,

      },

    };

  }

  // ===============================
  // web-search以外の既存経路(変更なし)
  // ===============================

  const input =
    request.arguments ??
    {
      input: userInput,
    };

  const result =
    await runTool(
      request.tool,
      input
    );

  return result;

}
