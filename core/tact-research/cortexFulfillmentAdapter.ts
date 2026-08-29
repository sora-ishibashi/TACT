import { performWebResearch } from "./webResearch";
import type { ResearchFulfillmentSearchAdapter } from "../tact-analysis/fulfillment";

/**
 * Adapts the existing canonical web-research boundary to Cortex fulfillment.
 * Cortex remains provider-independent and never imports a search SDK directly.
 */
export function createCortexFulfillmentSearchAdapter(
  webResearch: typeof performWebResearch = performWebResearch,
): ResearchFulfillmentSearchAdapter {
  return {
    async search(request) {
      const result = await webResearch([...request.queries], request.objective, 3);
      return {
        evidence: result.evidence.map((evidence) => ({
          id: evidence.id,
          text: evidence.evidence,
          claim: evidence.claim,
          url: evidence.source,
        })),
      };
    },
  };
}
