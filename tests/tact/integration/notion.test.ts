import {
  NOTION_FETCH_ALL_BLOCK_CONTENTS_TOOL_SLUG,
  NOTION_READ_MAX_BLOCKS,
  NOTION_READ_MAX_DEPTH,
  NOTION_SEARCH_FALLBACK_MAX_ITEMS,
  NOTION_RETRIEVE_PAGE_TOOL_SLUG,
  NOTION_SEARCH_TOOL_SLUG,
  mapComposioNotionReadPageResultToCanonical,
  mapComposioNotionSearchResultToCanonical,
  mapNotionActionToComposioTool,
} from "../../../core/tact-integration/providers/composio/mappings/notion";
import { executeNotionSearchWithIndexFallback } from "../../../core/tact-integration/providers/composio/adapter";
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

function notionSearchAction(query: string, maxResults = 10) {
  return { service: "notion" as const, operation: "search" as const, input: { query, maxResults } };
}

function rawNotionPage(id: string, title: string) {
  return {
    object: "page",
    id,
    properties: { Name: { title: [{ plain_text: title }] } },
    auth: { token: "must-not-leak" },
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
    const action = notionSearchAction("TACT-NOTION-LIVE-TEST");
    const mapped = mapNotionActionToComposioTool(action);
    const invocations: Array<{ slug: string; arguments: Record<string, unknown> }> = [];
    const execution = mapped.ok && mapped.kind === "search"
      ? await executeNotionSearchWithIndexFallback(action, mapped.invocation, async (invocation) => {
        invocations.push(invocation);
        return { successful: true, logId: "normal-search", data: { results: [rawNotionPage("page-1", "TACT-NOTION-LIVE-TEST")] } };
      })
      : undefined;

    results.push(check(
      "[Notion index fallback] a non-empty title search returns normally without an empty-query fallback",
      execution?.status === "completed" && invocations.length === 1 &&
        invocations[0]?.arguments.query === "TACT-NOTION-LIVE-TEST"
    ));
  }

  {
    const action = notionSearchAction("TACT-NOTION-LIVE-TEST");
    const mapped = mapNotionActionToComposioTool(action);
    const invocations: Array<{ slug: string; arguments: Record<string, unknown> }> = [];
    const execution = mapped.ok && mapped.kind === "search"
      ? await executeNotionSearchWithIndexFallback(action, mapped.invocation, async (invocation) => {
        invocations.push(invocation);
        return invocations.length === 1
          ? { successful: true, logId: "normal-empty", data: { results: [] } }
          : { successful: true, logId: "fallback", data: { results: [rawNotionPage("page-2", "TACT-NOTION-LIVE-TEST")] } };
      })
      : undefined;
    const output = execution?.status === "completed" ? execution.output as { results?: Array<{ title?: string }> } : undefined;

    results.push(check(
      "[Notion index fallback] empty title search makes one bounded empty-query request and returns its exact normalized title match",
      execution?.status === "completed" && invocations.length === 2 &&
        JSON.stringify(invocations[1]?.arguments) === JSON.stringify({
          query: "", page_size: NOTION_SEARCH_FALLBACK_MAX_ITEMS,
        }) &&
        !Object.hasOwn(invocations[1]?.arguments ?? {}, "start_cursor") &&
        output?.results?.length === 1 && output.results[0]?.title === "TACT-NOTION-LIVE-TEST"
    ));
  }

  {
    const action = notionSearchAction("Test", 1);
    const mapped = mapNotionActionToComposioTool(action);
    const execution = mapped.ok && mapped.kind === "search"
      ? await executeNotionSearchWithIndexFallback(action, mapped.invocation, async (invocation) => (
        invocation.arguments.query === ""
          ? {
            successful: true,
            data: {
              results: [
                rawNotionPage("unrelated", "Roadmap"),
                rawNotionPage("contains-1", "Test project"),
                rawNotionPage("exact", "  test  "),
                rawNotionPage("contains-2", "Testing notes"),
              ],
            },
          }
          : { successful: true, data: { results: [] } }
      ))
      : undefined;
    const output = execution?.status === "completed"
      ? execution.output as { results?: Array<{ id?: string; title?: string }> }
      : undefined;
    const serialized = JSON.stringify(output);

    results.push(check(
      "[Notion index fallback] exact normalized title wins over unrelated/contains matches and output remains normalized",
      execution?.status === "completed" && output?.results?.length === 1 &&
        output.results[0]?.id === "exact" && output.results[0]?.title === "test" &&
        !serialized.includes("must-not-leak") && !serialized.includes("properties")
    ));
  }

  {
    const action = notionSearchAction("test", 1);
    const mapped = mapNotionActionToComposioTool(action);
    const execution = mapped.ok && mapped.kind === "search"
      ? await executeNotionSearchWithIndexFallback(action, mapped.invocation, async (invocation) => (
        invocation.arguments.query === ""
          ? {
            successful: true,
            data: { results: [
              rawNotionPage("unrelated", "Roadmap"),
              rawNotionPage("contains-1", "Test project"),
              rawNotionPage("contains-2", "Testing notes"),
            ] },
          }
          : { successful: true, data: { results: [] } }
      ))
      : undefined;
    const output = execution?.status === "completed"
      ? execution.output as { results?: Array<{ id?: string }> }
      : undefined;

    results.push(check(
      "[Notion index fallback] contains matching excludes unrelated results and respects canonical maxResults",
      execution?.status === "completed" && output?.results?.length === 1 &&
        output.results[0]?.id === "contains-1"
    ));
  }

  {
    const action = notionSearchAction("TACT-NOTION-LIVE-TEST");
    const mapped = mapNotionActionToComposioTool(action);
    let calls = 0;
    const execution = mapped.ok && mapped.kind === "search"
      ? await executeNotionSearchWithIndexFallback(action, mapped.invocation, async () => {
        calls += 1;
        return { successful: true, data: { results: calls === 1 ? [] : [rawNotionPage("unrelated", "Roadmap")] } };
      })
      : undefined;
    const output = execution?.status === "completed" ? execution.output as { results?: unknown[] } : undefined;

    results.push(check(
      "[Notion index fallback] an empty fallback match set returns canonical zero results after exactly one additional request",
      execution?.status === "completed" && calls === 2 && output?.results?.length === 0
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
