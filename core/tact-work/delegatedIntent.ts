import type {
  ContextEvidenceItem,
  ContextResolutionPlan,
  ContextResolutionResult,
} from "../tact-context-resolution";
import type {
  ResolvedWorkIntent,
  WorkCapabilityRequirement,
  WorkEvidenceReference,
  WorkRequestType,
} from "./types";

const MAX_SUBJECT_LENGTH = 160;
const MAX_EVIDENCE_REFS = 16;

function bounded(value: string, maximum: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}
/**
 * Classifies only the authenticated current request. Conversation evidence may
 * resolve a referent, but it can never supply an action verb or authorization.
 */
export function classifyDelegatedRequestType(requestText: string): WorkRequestType {
  const text = bounded(requestText, 240);
  if (/(?:確認|調べ|読ん|見て|検証|状況)/u.test(text)) return "inspect";
  if (/(?:下書き|案を作|作成して|準備して)/u.test(text)) return "prepare";
  if (/(?:送って|送信|削除|更新|作業して|実行して)/u.test(text)) return "act";
  if (/(?:監視|見張|通知して)/u.test(text)) return "monitor";
  return "unknown";
}

/**
 * Converts an already server-derived context plan into provider-independent
 * Work semantics. It deliberately has no access to raw Slack bodies or
 * provider action names.
 */
export function resolveDelegatedWorkIntent(
  plan: ContextResolutionPlan | undefined
): ResolvedWorkIntent | undefined {
  if (plan?.kind !== "ready" || !plan.subject?.summary) {
    return undefined;
  }

  const subject = bounded(plan.subject.summary, MAX_SUBJECT_LENGTH);
  const requestType = classifyDelegatedRequestType(plan.requestText);

  // WORK-P1 currently executes only the bounded read-only confirmation path.
  // A recognized write-like request is represented as intent, never executed
  // through this helper.
  if (!subject || requestType !== "inspect") {
    return undefined;
  }

  const requiredCapabilities: WorkCapabilityRequirement[] = [];
  if (plan.sources.notion) requiredCapabilities.push("organizational_context.read");
  if (plan.sources.gmail) requiredCapabilities.push("communication.read");

  const completionConditions: ResolvedWorkIntent["completionConditions"] = [
    "subject_identified",
    ...(plan.sources.notion ? ["organizational_context_checked" as const] : []),
    ...(plan.sources.gmail ? ["communication_checked" as const] : []),
    "result_synthesized",
    "result_delivered",
  ];

  const objectiveParts = ["現在状況"];
  if (plan.sources.notion) objectiveParts.push("期限");
  if (plan.sources.gmail) objectiveParts.push("先方からの連絡状況");

  return {
    subject,
    title: bounded(`${subject}の状況確認`, 160),
    objective: bounded(`${subject}について、${objectiveParts.join("・")}を確認して報告する。`, 320),
    requestType,
    completionConditions,
    requiredCapabilities,
  };
}

function toEvidenceReference(item: ContextEvidenceItem): WorkEvidenceReference {
  return {
    category: item.category,
    sourceType: item.sourceType,
    sourceRef: item.sourceRef,
    ...(item.provenance.operation === "search" || item.provenance.operation === "read_page" || item.provenance.operation === "search_messages"
      ? { operation: item.provenance.operation }
      : {}),
  };
}

// The Work retains provenance, not context text. This is intentionally a
// bounded, deterministic projection of the Context Pack.
export function buildWorkEvidenceReferences(
  result: ContextResolutionResult
): WorkEvidenceReference[] {
  const seen = new Set<string>();
  const references: WorkEvidenceReference[] = [];

  for (const item of result.pack.evidence) {
    const reference = toEvidenceReference(item);
    const key = `${reference.category}:${reference.sourceType}:${reference.sourceRef}:${reference.operation ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
    if (references.length >= MAX_EVIDENCE_REFS) break;
  }

  return references;
}
