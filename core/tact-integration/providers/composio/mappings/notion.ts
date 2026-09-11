import type {
  IntegrationAction,
  NotionReadPageResult,
  NotionSearchResult,
  NotionSearchResultItem,
} from "../../../types";
import type { ComposioToolInvocation } from "./slack";

// Verified against this project's Composio catalog on 2026-09-11.
export const NOTION_SEARCH_TOOL_SLUG = "NOTION_SEARCH_NOTION_PAGE";
export const NOTION_RETRIEVE_PAGE_TOOL_SLUG = "NOTION_RETRIEVE_PAGE";
export const NOTION_FETCH_ALL_BLOCK_CONTENTS_TOOL_SLUG = "NOTION_FETCH_ALL_BLOCK_CONTENTS";

export const NOTION_SEARCH_DEFAULT_MAX_RESULTS = 10;
export const NOTION_SEARCH_MAX_RESULTS = 20;
export const NOTION_SEARCH_MAX_QUERY_LENGTH = 200;
export const NOTION_READ_MAX_DEPTH = 3;
export const NOTION_READ_MAX_BLOCKS = 250;
export const NOTION_READ_MAX_TEXT_LENGTH = 16_000;

export type NotionToolMappingResult =
  | { ok: true; kind: "search"; invocation: ComposioToolInvocation }
  | {
      ok: true;
      kind: "read_page";
      pageInvocation: ComposioToolInvocation;
      blocksInvocation: ComposioToolInvocation;
    }
  | { ok: true; kind: "read_page_by_title"; searchInvocation: ComposioToolInvocation }
  | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\u0000/gu, "").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function validSearchInput(input: Record<string, unknown>):
  | { ok: true; query: string; maxResults: number }
  | { ok: false; reason: string } {

  if (Object.keys(input).some((key) => key !== "query" && key !== "maxResults")) {
    return { ok: false, reason: "notion.search does not accept provider-specific parameters" };
  }

  const query = typeof input.query === "string" ? input.query.trim().replace(/\s+/gu, " ") : "";

  if (!query) {
    return { ok: false, reason: "notion.search requires a non-empty query" };
  }

  if (query.length > NOTION_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, reason: "notion.search query is too long" };
  }

  const maxResults = input.maxResults ?? NOTION_SEARCH_DEFAULT_MAX_RESULTS;

  if (
    typeof maxResults !== "number" ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > NOTION_SEARCH_MAX_RESULTS
  ) {
    return {
      ok: false,
      reason: `notion.search maxResults must be an integer from 1 to ${NOTION_SEARCH_MAX_RESULTS}`,
    };
  }

  return { ok: true, query, maxResults };
}

function validReadPageInput(input: Record<string, unknown>):
  | { ok: true; pageId: string }
  | { ok: false; reason: string } {

  if (Object.keys(input).some((key) => key !== "pageId")) {
    return { ok: false, reason: "notion.read_page does not accept provider-specific parameters" };
  }

  const pageId = boundedString(input.pageId, 200);
  return pageId
    ? { ok: true, pageId }
    : { ok: false, reason: "notion.read_page requires a pageId" };
}

function isNotionPageId(value: string): boolean {
  return /^[0-9a-f]{32}$/iu.test(value.replace(/-/gu, ""));
}

export function mapNotionActionToComposioTool(action: IntegrationAction): NotionToolMappingResult {
  if (action.service !== "notion") {
    return { ok: false, reason: "Unsupported Notion canonical operation" };
  }

  if (action.operation === "search") {
    const input = validSearchInput(action.input);

    if (!input.ok) {
      return input;
    }

    return {
      ok: true,
      kind: "search",
      invocation: {
        slug: NOTION_SEARCH_TOOL_SLUG,
        // Pagination/cursors, property selection, and sort controls remain
        // provider-owned. TACT performs one bounded title search only.
        arguments: { query: input.query, page_size: input.maxResults },
      },
    };
  }

  if (action.operation === "read_page") {
    const input = validReadPageInput(action.input);

    if (!input.ok) {
      return input;
    }

    if (!isNotionPageId(input.pageId)) {
      return {
        ok: true,
        kind: "read_page_by_title",
        searchInvocation: {
          slug: NOTION_SEARCH_TOOL_SLUG,
          arguments: { query: input.pageId, page_size: NOTION_SEARCH_DEFAULT_MAX_RESULTS },
        },
      };
    }

    return {
      ok: true,
      kind: "read_page",
      pageInvocation: {
        slug: NOTION_RETRIEVE_PAGE_TOOL_SLUG,
        arguments: { page_id: input.pageId },
      },
      blocksInvocation: {
        slug: NOTION_FETCH_ALL_BLOCK_CONTENTS_TOOL_SLUG,
        arguments: {
          block_id: input.pageId,
          recursive: true,
          max_depth: NOTION_READ_MAX_DEPTH,
          page_size: 100,
          max_blocks: NOTION_READ_MAX_BLOCKS,
        },
      },
    };
  }

  return { ok: false, reason: "Unsupported Notion canonical operation" };
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return asRecord(record?.data) ?? record;
}

function richTextToPlainText(value: unknown, maxLength = 2_000): string | undefined {
  const entries = Array.isArray(value) ? value : [];
  let text = "";

  for (const entry of entries) {
    const record = asRecord(entry);
    const part = boundedString(record?.plain_text, maxLength) ??
      boundedString(asRecord(record?.text)?.content, maxLength);

    if (part) {
      text += part;
      if (text.length >= maxLength) {
        return text.slice(0, maxLength);
      }
    }
  }

  return boundedString(text, maxLength);
}

function titleFromProperties(properties: unknown): string | undefined {
  const record = asRecord(properties);

  if (!record) {
    return undefined;
  }

  for (const property of Object.values(record)) {
    const value = asRecord(property);
    const title = richTextToPlainText(value?.title);

    if (title) {
      return title;
    }
  }

  return undefined;
}

function titleFromItem(item: Record<string, unknown>): string | undefined {
  return richTextToPlainText(item.title) ??
    titleFromProperties(item.properties) ??
    boundedString(item.name, 500);
}

function objectType(value: unknown): NotionSearchResultItem["objectType"] {
  return value === "page" || value === "database" ? value : "unknown";
}

function parentHint(parent: unknown): string | undefined {
  const type = asRecord(parent)?.type;

  switch (type) {
    case "workspace":
      return "ワークスペース";
    case "database_id":
    case "data_source_id":
      return "データベース";
    case "page_id":
      return "ページ";
    default:
      return undefined;
  }
}

export function mapComposioNotionSearchResultToCanonical(rawData: unknown):
  | { ok: true; result: NotionSearchResult }
  | { ok: false; reason: string } {

  const data = dataRecord(rawData);
  const rawResults = Array.isArray(data?.results) ? data.results : undefined;

  if (!rawResults) {
    return { ok: false, reason: "Notion search response did not contain a results array" };
  }

  const results: NotionSearchResultItem[] = [];

  for (const rawResult of rawResults.slice(0, NOTION_SEARCH_MAX_RESULTS)) {
    const item = asRecord(rawResult);
    const id = boundedString(item?.id, 200);

    if (!item || !id) {
      return { ok: false, reason: "Notion search response contained an item without an id" };
    }

    results.push({
      objectType: objectType(item.object),
      id,
      title: titleFromItem(item) ?? "無題",
      ...(boundedString(item.url, 2_000) ? { url: boundedString(item.url, 2_000) } : {}),
      ...(boundedString(item.last_edited_time, 100)
        ? { lastEditedTime: boundedString(item.last_edited_time, 100) }
        : {}),
      ...(parentHint(item.parent) ? { parentHint: parentHint(item.parent) } : {}),
    });
  }

  return { ok: true, result: { results } };
}

function blockText(block: Record<string, unknown>): string | undefined {
  const type = boundedString(block.type, 100);
  const content = type ? asRecord(block[type]) : undefined;

  return richTextToPlainText(content?.rich_text) ??
    richTextToPlainText(content?.caption) ??
    richTextToPlainText(block.rich_text);
}

function collectBlocks(value: unknown, collected: Record<string, unknown>[]): void {
  if (collected.length >= NOTION_READ_MAX_BLOCKS) {
    return;
  }

  const record = asRecord(value);
  const items = Array.isArray(record?.results)
    ? record.results
    : Array.isArray(record?.blocks)
      ? record.blocks
      : Array.isArray(value)
        ? value
        : [];

  for (const item of items) {
    if (collected.length >= NOTION_READ_MAX_BLOCKS) {
      return;
    }

    const block = asRecord(item);
    if (!block) {
      continue;
    }

    collected.push(block);
    collectBlocks(block.children, collected);
  }
}

export function mapComposioNotionReadPageResultToCanonical(
  pageId: string,
  rawPage: unknown,
  rawBlocks: unknown
): { ok: true; result: NotionReadPageResult } | { ok: false; reason: string } {
  const page = dataRecord(rawPage);

  if (!page) {
    return { ok: false, reason: "Notion page response did not contain page data" };
  }

  const blocks: Record<string, unknown>[] = [];
  collectBlocks(dataRecord(rawBlocks), blocks);
  const textParts: string[] = [];
  let remaining = NOTION_READ_MAX_TEXT_LENGTH;

  for (const block of blocks) {
    const text = blockText(block);

    if (text) {
      textParts.push(text.slice(0, remaining));
      remaining -= text.length;
      if (remaining <= 0) {
        break;
      }
    }
  }

  return {
    ok: true,
    result: {
      pageId,
      ...(titleFromItem(page) ? { title: titleFromItem(page) } : {}),
      ...(boundedString(page.url, 2_000) ? { url: boundedString(page.url, 2_000) } : {}),
      text: textParts.join("\n").slice(0, NOTION_READ_MAX_TEXT_LENGTH),
      ...(boundedString(page.last_edited_time, 100)
        ? { lastEditedTime: boundedString(page.last_edited_time, 100) }
        : {}),
    },
  };
}
