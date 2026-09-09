import {
  GMAIL_FETCH_EMAILS_TOOL_SLUG,
  GMAIL_MESSAGE_BODY_MAX_LENGTH,
  mapComposioGmailSearchResultToCanonical,
  mapGmailActionToComposioTool,
} from "../../../core/tact-integration/providers/composio/mappings/gmail";
import { buildExecutionResultFromToolResult } from "../../../core/tact-integration/providers/composio/adapter";
import { evaluatePolicyDecision } from "../../../core/tact-integration/policy";
import { runIntegrationGmailSearchMessagesCapability } from "../../../core/tact-integration/capability";
import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import { decomposeTask } from "../../../core/tact-orchestrator/decomposer";
import { formatIntegrationReadResultAnswer } from "../../../core/tact-conversation/orchestration";
import type { CapabilityInvocationRequest, OrchestrationResult } from "../../../core/tact-orchestrator/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeCapabilityRequest(query: string): CapabilityInvocationRequest {
  return { query, context: { memories: [], knowledge: [], examples: [], recentExecutions: [] } };
}

function makeConversationResult(output: unknown): OrchestrationResult {
  return {
    answer: "placeholder",
    executionId: "exec-1",
    tasks: [],
    memoryUsed: [],
    toolsUsed: [],
    memoryWrites: [],
    learningSignals: [],
    metadata: { executionMode: "single-execution" },
    integrationReadResult: {
      service: "gmail",
      operation: "search_messages",
      output: JSON.stringify(output),
    },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  {
    const mapped = mapGmailActionToComposioTool({
      service: "gmail",
      operation: "search_messages",
      input: { query: "A社", maxResults: 10 },
    });

    results.push(check(
      "[Gmail mapping] canonical gmail.search_messages maps to the verified Composio action once",
      mapped.ok && mapped.invocation.slug === GMAIL_FETCH_EMAILS_TOOL_SLUG
    ));
    results.push(check(
      "[Gmail mapping] only fixed, read-only provider parameters are sent",
      mapped.ok && JSON.stringify(mapped.invocation.arguments) === JSON.stringify({
        query: "A社", max_results: 10, user_id: "me", include_payload: true, include_spam_trash: false,
      })
    ));
  }

  {
    const empty = mapGmailActionToComposioTool({ service: "gmail", operation: "search_messages", input: { query: "   " } });
    const oversized = mapGmailActionToComposioTool({ service: "gmail", operation: "search_messages", input: { query: "A社", maxResults: 21 } });
    const arbitrary = mapGmailActionToComposioTool({ service: "gmail", operation: "search_messages", input: { query: "A社", page_token: "attacker", include_spam_trash: true } });

    results.push(check(
      "[Gmail validation] empty query, out-of-bound maxResults, and arbitrary provider parameters fail closed",
      !empty.ok && !oversized.ok && !arbitrary.ok
    ));
  }

  {
    const plainText = Buffer.from("x".repeat(GMAIL_MESSAGE_BODY_MAX_LENGTH + 100)).toString("base64url");
    const normalized = mapComposioGmailSearchResultToCanonical({
      messages: [{
        id: "message-1",
        threadId: "thread-1",
        snippet: "Meeting confirmation",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "Subject", value: "A社との会議" },
            { name: "From", value: "owner@example.com" },
            { name: "To", value: "me@example.com" },
            { name: "Date", value: "Mon, 01 Sep 2026 12:00:00 +0000" },
            { name: "X-Provider-Token", value: "must-not-pass" },
          ],
          parts: [
            { mimeType: "text/html", body: { data: Buffer.from("<script>bad()</script>").toString("base64url") } },
            { mimeType: "text/plain", body: { data: plainText } },
          ],
        },
      }],
    });

    const serialized = normalized.ok ? JSON.stringify(normalized.result) : "";
    results.push(check(
      "[Gmail normalization] exposes only canonical fields, text/plain body bounded, and no headers/HTML/provider metadata",
      normalized.ok &&
        normalized.result.messages[0]?.bodyText?.length === GMAIL_MESSAGE_BODY_MAX_LENGTH &&
        !serialized.includes("X-Provider-Token") &&
        !serialized.includes("<script>") &&
        !serialized.includes("payload")
    ));
  }

  {
    const noMessages = mapComposioGmailSearchResultToCanonical({ messages: [] });
    const malformed = mapComposioGmailSearchResultToCanonical({ messages: [{ threadId: "missing-id" }] });
    const providerFailed = buildExecutionResultFromToolResult(
      { service: "gmail", operation: "search_messages", input: { query: "A社" } },
      { successful: false, error: "upstream unavailable" }
    );

    results.push(check(
      "[Gmail errors] successful empty search is distinct from malformed or provider-failed responses",
      noMessages.ok && noMessages.result.messages.length === 0 && !malformed.ok && providerFailed.status === "failed"
    ));
  }

  {
    const policy = evaluatePolicyDecision("gmail", "search_messages");
    const capability = await runIntegrationGmailSearchMessagesCapability(makeCapabilityRequest("A社との最近のメールを確認して"));
    const rejected = await runIntegrationGmailSearchMessagesCapability(makeCapabilityRequest("メールを検索して"));
    const producedQuery = (capability.integrationRequirement?.action.metadata as {
      input?: { query?: unknown; maxResults?: unknown };
    }).input?.query;

    results.push(check(
      "[Gmail policy/capability] canonical read action is allow and produces canonical input only",
        policy.decision === "allow" &&
        policy.riskClass === "read" &&
        capability.success &&
        typeof producedQuery === "string" &&
        producedQuery.includes("A社") &&
        !producedQuery.includes("メール") &&
        rejected.success === false
    ));
  }

  {
    const intent = classifyIntent("A社との最近のメールを確認して");
    const tasks = decomposeTask({ input: "A社との最近のメールを確認して" });

    results.push(check(
      "[Gmail conversation mapping] deterministic Gmail/email search intent reaches only integration.gmail.search_messages",
      intent.intent === "integration_gmail_search_messages" && tasks[0]?.assignedCapability === "integration.gmail.search_messages"
    ));
  }

  {
    const text = formatIntegrationReadResultAnswer(makeConversationResult({
      messages: [{ messageId: "secret-id", subject: "A社との会議", from: "owner@example.com", date: "2026-09-01", snippet: "次回日程について" }],
    })) ?? "";
    const emptyText = formatIntegrationReadResultAnswer(makeConversationResult({ messages: [] }));

    results.push(check(
      "[Gmail Slack UX] summary is readable without message IDs or provider internals; valid empty is not provider failure",
      text.includes("A社との会議") && text.includes("owner@example.com") && !text.includes("secret-id") &&
        emptyText === "該当するメールは見つかりませんでした。"
    ));
  }

  return summarize("integration/gmail", results);

}
