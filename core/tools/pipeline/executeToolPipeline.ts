import { executeEvidencePipeline } from "./evidence";
import { runTool } from "../runTool";
import { TactToolRequest } from "../types";

export async function executeToolPipeline(
  request: TactToolRequest,
  userInput: string
) {

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

  if (!result.success) {
    return result;
  }

  // Web検索ならEvidence化
  if (request.tool === "web-search") {

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

  return result;

}