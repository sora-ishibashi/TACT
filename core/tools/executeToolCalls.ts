import { TactToolRequest } from "./types";
import { executeToolPipeline } from "./pipeline/executeToolPipeline";
import { SearchIntensity } from "../workflow/taskProfile";

export async function executeToolCalls(
  toolRequests: TactToolRequest[],
  userInput: string,
  // STEP158: context.taskProfile.searchIntensityをそのまま受け取り、
  // executeToolPipeline()へ引き継ぐだけ。呼び出し元(runAgent.ts)が
  // taskProfileを持たない場合はundefinedのまま渡り、既存動作を
  // 維持するfallbackへ委ねる。
  searchIntensity?: SearchIntensity
) {
  const results: Record<string, unknown[]> = {};

  for (const request of toolRequests) {
    try {
      const result = await executeToolPipeline(
        request,
        userInput,
        searchIntensity
      );

      if (!results[request.tool]) {
        results[request.tool] = [];
      }

      results[request.tool].push(result);

      // STEP149: executeToolPipeline()は例外を投げなくても
      // success:falseを返すことがある(runTool()内部でtool.execute()が
      // {success:false, ...}を返した場合。webSearch.tsのクエリ空文字
      // チェック等)。この場合、これまで何もログに残らず、Evidenceが
      // 0件になった原因(検索していない vs 検索したが失敗した)を
      // ログから区別できなかった(STEP148のE2E監査で発覚)。
      if (
        result &&
        typeof result === "object" &&
        (result as { success?: unknown }).success === false
      ) {

        console.warn(
          `[Tool] ${request.tool} failed:`,
          (result as { error?: unknown }).error ?? result
        );

      }

    } catch (error) {

      if (!results[request.tool]) {
        results[request.tool] = [];
      }

      results[request.tool].push({
        success: false,
        error: String(error),
      });

      // STEP149: 従来ここでcatchした例外(Tavily API quota超過等の
      // 外部要因を含む)が一切ログへ出力されておらず、「検索を試みたが
      // 実際には毎回失敗していた」ことが実機テストで見えなかった原因の
      // 一つだった。ここで可視化する(挙動自体は変更しない。
      // resultsへ既存どおりsuccess:falseを積むのみ)。
      console.warn(
        `[Tool] ${request.tool} threw an exception:`,
        error instanceof Error ? error.message : String(error)
      );

    }
  }

  return results;
}