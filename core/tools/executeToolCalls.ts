import { TactToolRequest } from "./types";
import { executeToolPipeline } from "./pipeline/executeToolPipeline";

export async function executeToolCalls(
  toolRequests: TactToolRequest[],
  userInput: string
) {
  const results: Record<string, unknown[]> = {};

  for (const request of toolRequests) {
    try {
      const result = await executeToolPipeline(
        request,
        userInput
      );

      if (!results[request.tool]) {
        results[request.tool] = [];
      }

      results[request.tool].push(result);

    } catch (error) {

      if (!results[request.tool]) {
        results[request.tool] = [];
      }

      results[request.tool].push({
        success: false,
        error: String(error),
      });

    }
  }

  return results;
}