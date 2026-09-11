import {
  NOTION_FETCH_ALL_BLOCK_CONTENTS_TOOL_SLUG,
  NOTION_READ_MAX_BLOCKS,
  NOTION_READ_MAX_DEPTH,
  NOTION_RETRIEVE_PAGE_TOOL_SLUG,
  NOTION_SEARCH_TOOL_SLUG,
  mapComposioNotionReadPageResultToCanonical,
  mapComposioNotionSearchResultToCanonical,
  mapNotionActionToComposioTool,
} from "../../../core/tact-integration/providers/composio/mappings/notion";
import { evaluatePolicyDecision } from "../../../core/tact-integration/policy";
import {
  extractNotionReadPageReference,
  extractNotionSearchQuery,
  runIntegrationNotionReadPageCapability,
  runIntegrationNotionSearchCapability,
} from "../../../core/tact-integration/capability";
import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import { formatIntegrationReadResultAnswer } from "../../../core/tact-conversation/orchestration";
import type { CapabilityInvocationRequest, OrchestrationResult } from "../../../core/tact-orchestrator/types";
import { check, summarize, type CheckResult } from "../lib/check";

function request(query: string): CapabilityInvocationRequest {
  return { query, context: { memories: [], knowledge: [], examples: [], recentExecutions: [] } };
}

function result(operation: "search" | "read_page", output: unknown): OrchestrationResult {
  return {
    answer: "placeholder",
    executionId: "exec-notion",
    tasks: [], memoryUsed: [], toolsUsed: [], memoryWrites: [], learningSignals: [],
    metadata: { executionMode: "single-execution" },
    integrationReadResult: { service: "notion", operation, output: JSON.stringify(output) },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const mapped = mapNotionActionToComposioTool({
      service: "notion", operation: "search", input: { query: "  A社  ", maxResults: 10 },
    });
    results.push(check(
      "[Notion mapping] canonical notion.search uses the verified provider action and fixed bounded arguments",
      mapped.ok && mapped.kind === "search" && mapped.invocation.slug === NOTION_SEARCH_TOOL_SLUG &&
        JSON.stringify(mapped.invocation.arguments) === JSON.stringify({ query: "A社", page_size: 10 })
    ));
  }

  {
    const empty = mapNotionActionToComposioTool({ service: "notion", operation: "search", input: { query: " " } });
    const large = mapNotionActionToComposioTool({ service: "notion", operation: "search", input: { query: "A社", maxResults: 21 } });
    const injected = mapNotionActionToComposioTool({ service: "notion", operation: "search", input: { query: "A社", start_cursor: "attacker" } });
    const missingPage = mapNotionActionToComposioTool({ service: "notion", operation: "read_page", input: {} });
    const read = mapNotionActionToComposioTool({
      service: "notion", operation: "read_page", input: { pageId: "0123456789abcdef0123456789abcdef" },
    });
    results.push(check(
      "[Notion validation] empty input, unbounded results, provider parameters, and missing pageId fail closed; page reads stay bounded",
      !empty.ok && !large.ok && !injected.ok && !missingPage.ok && read.ok && read.kind === "read_page" &&
        read.pageInvocation.slug === NOTION_RETRIEVE_PAGE_TOOL_SLUG &&
        read.blocksInvocation.slug === NOTION_FETCH_ALL_BLOCK_CONTENTS_TOOL_SLUG &&
        (read.blocksInvocation.arguments.max_depth === NOTION_READ_MAX_DEPTH) &&
        (read.blocksInvocation.arguments.max_blocks === NOTION_READ_MAX_BLOCKS)
    ));
  }

  {
    const normalized = mapComposioNotionSearchResultToCanonical({
      results: [{
        object: "page", id: "page-secret-id", url: "https://notion.so/a", last_edited_time: "2026-09-10T01:02:03Z",
        parent: { type: "database_id", database_id: "database-secret" },
        properties: { Name: { title: [{ plain_text: "A社 更新案件" }] } },
        auth: { token: "must-not-leak" },
      }],
    });
    const serialized = normalized.ok ? JSON.stringify(normalized.result) : "";
    results.push(check(
      "[Notion normalization] search exposes only the canonical useful fields and no provider/auth metadata",
      normalized.ok && normalized.result.results[0]?.title === "A社 更新案件" &&
        normalized.result.results[0]?.parentHint === "データベース" &&
        !serialized.includes("database-secret") && !serialized.includes("must-not-leak") && !serialized.includes("properties")
    ));
  }

  {
    const normalized = mapComposioNotionReadPageResultToCanonical(
      "page-1",
      { id: "page-1", url: "https://notion.so/a", last_edited_time: "2026-09-10T01:02:03Z", properties: { Name: { title: [{ plain_text: "A社 更新案件" }] } } },
      { results: [
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "更新期限は明日です。" }] } },
        { type: "unsupported", unsupported: { raw: "ignore" } },
        { type: "to_do", to_do: { rich_text: [{ text: { content: "先方へ連絡" } }] } },
      ] }
    );
    results.push(check(
      "[Notion read normalization] plain text is extracted from supported blocks while unsupported payloads are skipped",
      normalized.ok && normalized.result.text.includes("更新期限は明日です。") &&
        normalized.result.text.includes("先方へ連絡") && !normalized.result.text.includes("ignore")
    ));
  }

  {
    const searchCapability = await runIntegrationNotionSearchCapability(request("Notionから「A社」を探して"));
    const readCapability = await runIntegrationNotionReadPageCapability(request("Notionの「A社 更新案件」を読んで"));
    const searchIntent = classifyIntent("Notionで「更新案件」を検索して");
    const readIntent = classifyIntent("Notionの「A社 更新案件」を読んで");
    const searchTask = decomposeTask({ input: "Notionから「A社」を探して" })[0];
    const readTask = decomposeTask({ input: "Notionの「A社 更新案件」を読んで" })[0];
    results.push(check(
      "[Notion intent] quoted Japanese search/read requests produce only canonical actions with read policy and no approval",
      extractNotionSearchQuery("Notionから「A社」を探して") === "A社" &&
        extractNotionReadPageReference("Notionの「A社 更新案件」を読んで") === "A社 更新案件" &&
        searchCapability.success && readCapability.success &&
        evaluatePolicyDecision("notion", "search").decision === "allow" &&
        evaluatePolicyDecision("notion", "read_page").decision === "allow" &&
        searchIntent.intent === "integration_notion_search" && readIntent.intent === "integration_notion_read_page" &&
        searchTask?.assignedCapability === "integration.notion.search" && readTask?.assignedCapability === "integration.notion.read_page"
    ));
  }

  {
    const text = formatIntegrationReadResultAnswer(result("search", {
      results: [{ id: "provider-page-id", title: "A社 更新案件", lastEditedTime: "2026-09-10T00:00:00Z" }],
    })) ?? "";
    const readText = formatIntegrationReadResultAnswer(result("read_page", {
      pageId: "provider-page-id", title: "A社 更新案件", text: "更新期限は明日です。",
    })) ?? "";
    results.push(check(
      "[Notion Slack UX] concise results and page text never disclose provider page identifiers",
      text.includes("A社 更新案件") && !text.includes("provider-page-id") &&
        readText.includes("更新期限は明日です。") && !readText.includes("provider-page-id")
    ));
  }

  return summarize("integration/notion", results);
}
