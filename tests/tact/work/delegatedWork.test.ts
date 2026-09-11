import {
  buildWorkEvidenceReferences,
  classifyDelegatedRequestType,
  resolveDelegatedWorkIntent,
} from "../../../core/tact-work/delegatedIntent";
import { evaluateDelegatedWorkCompletion } from "../../../core/tact-work/delegatedCompletion";
import type { ContextResolutionPlan, ContextResolutionResult } from "../../../core/tact-context-resolution";
import { check, summarize, type CheckResult } from "../lib/check";

const plan: ContextResolutionPlan = {
  kind: "ready",
  requestText: "これ確認して",
  subject: { summary: "TACTテスト商事の更新案件", queryTerms: ["TACTテスト商事の更新案件", "TACTテスト商事"] },
  sources: {
    notion: { query: "TACTテスト商事の更新案件" },
    gmail: { query: "TACTテスト商事" },
  },
};

function resolution(overrides: Partial<ContextResolutionResult["sources"]> = {}): ContextResolutionResult {
  return {
    plan,
    pack: {
      request: { text: "これ確認して" },
      subject: { summary: "TACTテスト商事の更新案件", queryTerms: ["TACTテスト商事の更新案件"] },
      evidence: [
        {
          category: "conversation",
          sourceType: "slack",
          sourceRef: "slack-message-1",
          text: "TACTテスト商事の更新案件、期限どうだったっけ",
          provenance: { sourceRef: "slack:C1:1" },
        },
        {
          category: "organizational",
          sourceType: "notion",
          sourceRef: "notion-page-1",
          title: "TACTテスト商事の更新案件",
          text: "期限は9月15日です。担当は田中さんです。",
          provenance: { operation: "read_page", sourceRef: "notion-page-1" },
        },
        {
          category: "communication",
          sourceType: "gmail",
          sourceRef: "gmail-message-1",
          title: "TACTテスト商事 更新案件について",
          text: "契約条件を確認しました。",
          provenance: { operation: "search_messages", sourceRef: "gmail-message-1" },
        },
      ],
      metrics: { evidenceCount: 3, totalChars: 72, truncated: false },
    },
    sources: { notion: "available", gmail: "available", ...overrides },
  };
}
export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const intent = resolveDelegatedWorkIntent(plan);

  results.push(check(
    "[WORK-P1 intent] resolved context creates a subject-based inspect objective rather than the raw referential request",
    intent?.subject === "TACTテスト商事の更新案件" &&
      intent.title === "TACTテスト商事の更新案件の状況確認" &&
      intent.objective.includes("現在状況") &&
      intent.requestType === "inspect"
  ));

  results.push(check(
    "[WORK-P1 capability] Work semantics use capability categories and never Composio/provider action names",
    intent?.requiredCapabilities.includes("organizational_context.read") === true &&
      intent.requiredCapabilities.includes("communication.read") === true &&
      !JSON.stringify(intent).includes("NOTION_") &&
      !JSON.stringify(intent).includes("GMAIL_")
  ));

  results.push(check(
    "[WORK-P1 authority] only the current request determines request type; a historical delete instruction cannot turn confirmation into a write",
    classifyDelegatedRequestType("これ確認して") === "inspect" &&
      classifyDelegatedRequestType("この顧客データを削除して") === "act" &&
      intent?.requestType === "inspect"
  ));

  results.push(check(
    "[WORK-P1 read-vs-act] a send-like request is classified but not converted into this read-only context Work",
    classifyDelegatedRequestType("これ送って") === "act" &&
      resolveDelegatedWorkIntent({ ...plan, requestText: "これ送って" }) === undefined
  ));

  if (intent) {
    const awaiting = evaluateDelegatedWorkCompletion(intent, resolution(), false);
    const noMatch = evaluateDelegatedWorkCompletion(intent, resolution({ gmail: "no_match" }), true);
    const unavailable = evaluateDelegatedWorkCompletion(intent, resolution({ gmail: "unavailable" }), true);

    results.push(check(
      "[WORK-P1 completion] provider Task success alone is insufficient until the result is durably delivered",
      awaiting.state === "awaiting_delivery" && awaiting.unmetConditions.includes("result_delivered")
    ));

    results.push(check(
      "[WORK-P1 completion] a no-match result satisfies a request to check and can complete after delivery",
      noMatch.state === "completed"
    ));

    results.push(check(
      "[WORK-P1 completion] required unavailable evidence blocks completion instead of producing a false completed Work",
      unavailable.state === "blocked" && unavailable.unmetConditions.includes("communication_checked")
    ));
  }

  const refs = buildWorkEvidenceReferences(resolution());
  results.push(check(
    "[WORK-P1 evidence] Work stores bounded provenance references, never Context Pack bodies or connection/account metadata",
    refs.length === 3 && refs.some((ref) => ref.operation === "read_page") &&
      !JSON.stringify(refs).includes("期限は") &&
      !JSON.stringify(refs).includes("connectionId") &&
      !JSON.stringify(refs).includes("providerConnectedAccountId")
  ));

  return summarize("work/delegatedWork", results);
}
