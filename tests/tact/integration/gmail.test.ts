import {
  GMAIL_FETCH_EMAILS_TOOL_SLUG,
  GMAIL_SEND_EMAIL_TOOL_SLUG,
  GMAIL_MESSAGE_BODY_MAX_LENGTH,
  mapComposioGmailSendResultToCanonical,
  mapComposioGmailSearchResultToCanonical,
  mapGmailActionToComposioTool,
} from "../../../core/tact-integration/providers/composio/mappings/gmail";
import { buildExecutionResultFromToolResult } from "../../../core/tact-integration/providers/composio/adapter";
import { evaluatePolicyDecision } from "../../../core/tact-integration/policy";
import {
  extractGmailSearchQuery,
  runIntegrationGmailSearchMessagesCapability,
} from "../../../core/tact-integration/capability";
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
    const mapped = mapGmailActionToComposioTool({
      service: "gmail",
      operation: "send_message",
      input: {
        to: ["customer@example.com", "team@example.com"],
        cc: ["manager@example.com"],
        subject: "確認のご連絡",
        bodyText: "確認しました。",
      },
    });
    const policy = evaluatePolicyDecision("gmail", "send_message");
    results.push(check(
      "[Gmail send mapping] canonical text mail maps once to the verified provider action and requires approval",
      mapped.ok && mapped.invocation.slug === GMAIL_SEND_EMAIL_TOOL_SLUG &&
        JSON.stringify(mapped.invocation.arguments) === JSON.stringify({
          recipient_email: "customer@example.com",
          extra_recipients: ["team@example.com"],
          cc: ["manager@example.com"],
          subject: "確認のご連絡",
          body: "確認しました。",
          is_html: false,
          user_id: "me",
        }) &&
        policy.decision === "require_approval" && policy.riskClass === "write"
    ));

    const invalid = mapGmailActionToComposioTool({
      service: "gmail", operation: "send_message",
      input: { to: ["not-an-email"], subject: "x", bodyText: "x", providerRequestId: "attacker" },
    });
    const replyUnsupported = mapGmailActionToComposioTool({
      service: "gmail", operation: "send_message",
      input: { to: ["customer@example.com"], subject: "x", bodyText: "x", threadId: "thread-1" },
    });
    results.push(check(
      "[Gmail send validation] invalid/provider-controlled input and unsupported reply binding fail closed",
      !invalid.ok && !replyUnsupported.ok
    ));
  }

  {
    const normalized = mapComposioGmailSendResultToCanonical({
      id: "sent-message-1", threadId: "thread-1", token: "must-not-leak", headers: { authorization: "secret" },
    });
    const missingId = mapComposioGmailSendResultToCanonical({ threadId: "thread-1" });
    const serialized = normalized.ok ? JSON.stringify(normalized.result) : "";
    results.push(check(
      "[Gmail send normalization] confirms only a provider-returned message id and exposes no provider payload",
      normalized.ok && normalized.result.sent && normalized.result.messageId === "sent-message-1" &&
        normalized.result.threadId === "thread-1" && !serialized.includes("token") && !serialized.includes("secret") && !missingId.ok
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

  // =========================
  // LIVE-1A Gmail Query Extraction Fix
  // =========================
  //
  // Root cause再現: 実LIVE障害("Gmailから「TACT-LIVE-1A-TEST」を検索して"
  // がComposioへ"から「TACT-LIVE-1A-TEST」"というqueryを送っていた)を
  // 直接再現し、修正後は引用符内の文字列だけが抽出されることを確認する。

  {
    results.push(check(
      "[LIVE-1A] Gmailから「TACT-LIVE-1A-TEST」を検索して -> TACT-LIVE-1A-TEST(実LIVE障害の直接再現)",
      extractGmailSearchQuery("Gmailから「TACT-LIVE-1A-TEST」を検索して") === "TACT-LIVE-1A-TEST"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] Gmailで「請求書」を検索して -> 請求書",
      extractGmailSearchQuery("Gmailで「請求書」を検索して") === "請求書"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] Gmailから\"invoice\"を探して -> invoice(半角二重引用符)",
      extractGmailSearchQuery("Gmailから\"invoice\"を探して") === "invoice"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] Gmailで 'OpenAI' を検索 -> OpenAI(半角単一引用符)",
      extractGmailSearchQuery("Gmailで 'OpenAI' を検索") === "OpenAI"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] GmailでOpenAIを検索して -> OpenAI(引用無しでも会話上のnoiseを含めない)",
      extractGmailSearchQuery("GmailでOpenAIを検索して") === "OpenAI"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] GmailからTACTを検索して -> TACT(引用無し、「から」が残らない)",
      extractGmailSearchQuery("GmailからTACTを検索して") === "TACT"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] Gmailで田中さんのメールを探して -> 田中さんのメール(Gmail明示時、内容中のメールは保持する)",
      extractGmailSearchQuery("Gmailで田中さんのメールを探して") === "田中さんのメール"
    ));
  }

  {
    const query = extractGmailSearchQuery("Gmailから「TACT-LIVE-1A-TEST」を検索して") ?? "";
    results.push(check(
      "[LIVE-1A] 引用抽出結果は「から」「Gmail」「引用符」「を検索して」のいずれも保持しない",
      !query.includes("から") &&
        !/gmail/i.test(query) &&
        !/[「『」』"']/.test(query) &&
        !query.includes("を検索して")
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] 複数の引用が存在し曖昧な場合はfallback抽出へ委ねる(推測で片方を選ばない)",
      extractGmailSearchQuery("Gmailで「A社」と「B社」を検索して") !== "A社" &&
        extractGmailSearchQuery("Gmailで「A社」と「B社」を検索して") !== "B社"
    ));
  }

  {
    results.push(check(
      "[LIVE-1A] 空の引用(「」)はfail closedする(fallback抽出へ迂回しない)",
      extractGmailSearchQuery("Gmailから「」を検索して") === undefined
    ));
  }

  {
    // 既存contract(引用が無く、cleanup後に空になる入力はundefined)を
    // 維持していることの直接確認。
    results.push(check(
      "[LIVE-1A] 既存のfail-closed契約を維持する(「メールを検索して」は依然としてundefined)",
      extractGmailSearchQuery("メールを検索して") === undefined
    ));
  }

  {
    // 既存Regression(このfileの直前のcheck、[Gmail policy/capability])と
    // 同じ入力を、extractGmailSearchQuery()単体でも直接確認する
    // ——"Gmail"の英語表記が無い入力では、既存通り「メール」全体を
    // 話題語として除去する(既存挙動を壊さない)。
    results.push(check(
      "[LIVE-1A] 既存の日本語のみ入力(A社との最近のメールを確認して)は引き続き「メール」を含まない",
      !((extractGmailSearchQuery("A社との最近のメールを確認して") ?? "").includes("メール"))
    ));
  }

  return summarize("integration/gmail", results);

}
