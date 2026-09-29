// =========================
// TACT Canonical Execution — Permission Policy Resolver (SOR-51)
// =========================
//
// core/tact-integration/policy.tsのPOLICY_ALLOWLIST(fail-closed static
// allowlist)と同じ設計思想(ADAPT_AND_BORROW、値そのものは共有しない)
// を、Runs Observation向けに独立して実装する。「意味的な違いを明示した
// 上で分離する」(SOR-51指示)——既存POLICY_ALLOWLISTは一切import・
// 変更しない。
//
// 絶対条件(SOR-51指示「Unknownの扱い」、最重要): matchするruleが
// 無い場合、allowedへ安全側fallbackしない。denyへも断定しない
// (既存Integration Policyとの最大の違い)——unknownという「観測価値の
// ある不確実状態」を返す。

import type { CanonicalExecution } from "../types";
import type { PermissionPolicyRule, PermissionSubject } from "./types";

// =========================
// Initial allowlist (M-0)
// =========================
//
// SOR-51指示のvertical slice例をそのまま最小限のruleとして登録する。
// 個別actorId・organization・workspace・OAuth scope・time等は
// 「必要ならmetadataを持てるが巨大なJSON dumpは禁止」「将来足せる余地を
// 残す」という指示どおり、この時点では実装しない(過剰な先回り登録
// 禁止)。
const PERMISSION_POLICY_ALLOWLIST: readonly PermissionPolicyRule[] = [

  // 人間がSlackでTACTをmentionする(app_mention → actionCategory=create、
  // resourceType=slack_message)ことは、TACTが正しく機能するための
  // 通常の想定経路であり、許可する。
  {
    id: "human-slack-mention-allowed",
    subjectKind: "human",
    provider: "slack",
    resourceType: "slack_message",
    actionCategory: "create",
    decision: "allowed",
    reasonCode: "human_slack_mention_allowed",
  },

  // SOR-51指示のCase1例(Agent + slack channel READ = allowed)。
  {
    id: "ai-agent-slack-channel-read-allowed",
    subjectKind: "ai_agent",
    provider: "slack",
    resourceType: "slack_channel",
    actionCategory: "read",
    decision: "allowed",
    reasonCode: "ai_agent_slack_channel_read_allowed",
  },

  // SOR-51指示のCase2例(Agent + slack message SEND = denied)。M-0の
  // Observation Modeでは実行そのものはブロックしないが、denied
  // として記録し後続のAttention Candidateへ渡す。
  {
    id: "ai-agent-slack-message-send-denied",
    subjectKind: "ai_agent",
    provider: "slack",
    resourceType: "slack_message",
    actionCategory: "send",
    decision: "denied",
    reasonCode: "ai_agent_slack_message_send_denied",
  },

  // =========================
  // SOR-51 M-0 Test Permission Matrix — Notion (SOR-69 experimental MCP
  // host / Claude Test Agent向け)
  // =========================
  //
  // MCP経由で観測されるNotion実行はprovider="mcp"・targetProvider=
  // "notion"となる(normalizeNotionMcpExecution.ts)ため、providerは
  // wildcardにしtargetProviderで対象systemを判定する。resourceTypeは
  // page/database/block横断でmatrixがaction単位のみを区別するため
  // wildcard。principal(actorId)・agent(agentId)のいずれかが未解決
  // (test host側の環境変数未設定・identity解決不能等)の場合は
  // 推測でmatchさせない(requiresKnownActorId/requiresKnownAgentId、
  // SOR-51指示「Notion M-0 Binding」「unknownを推測しない」)。

  {
    id: "notion-ai-agent-read-allowed",
    subjectKind: "ai_agent",
    provider: "*",
    targetProvider: "notion",
    resourceType: "*",
    actionCategory: "read",
    decision: "allowed",
    reasonCode: "notion_m0_read_allowed",
    requiresKnownActorId: true,
    requiresKnownAgentId: true,
  },

  {
    id: "notion-ai-agent-create-page-allowed",
    subjectKind: "ai_agent",
    provider: "*",
    targetProvider: "notion",
    resourceType: "*",
    actionCategory: "create",
    decision: "allowed",
    reasonCode: "notion_m0_create_page_allowed",
    requiresKnownActorId: true,
    requiresKnownAgentId: true,
  },

  {
    id: "notion-ai-agent-update-page-approval-required",
    subjectKind: "ai_agent",
    provider: "*",
    targetProvider: "notion",
    resourceType: "*",
    actionCategory: "update",
    decision: "approval_required",
    reasonCode: "notion_m0_update_page_approval_required",
    requiresKnownActorId: true,
    requiresKnownAgentId: true,
  },

  {
    id: "notion-ai-agent-delete-page-denied",
    subjectKind: "ai_agent",
    provider: "*",
    targetProvider: "notion",
    resourceType: "*",
    actionCategory: "delete",
    decision: "denied",
    reasonCode: "notion_m0_delete_page_forbidden",
    requiresKnownActorId: true,
    requiresKnownAgentId: true,
  },

];

// テスト専用に公開する(listPermissionPolicyRules()と同じ理由: SOR-51
// Testsは実際のmatching規則(targetProvider/requiresKnown*/connectionId
// scope)そのものを、固定allowlistの内容に左右されず検証する必要がある)。
export function matchesRule(rule: PermissionPolicyRule, subject: PermissionSubject, execution: CanonicalExecution): boolean {

  if (rule.subjectKind !== "*" && rule.subjectKind !== subject.kind) {
    return false;
  }

  if (rule.provider !== "*" && rule.provider !== execution.provider) {
    return false;
  }

  // 加算的check(SOR-51 M-0): 未設定のruleはこのfieldを一切見ない
  // ——既存Slack ruleの挙動を変えない(types.tsのtargetProviderコメント
  // 参照)。
  if (rule.targetProvider !== undefined && rule.targetProvider !== "*" && rule.targetProvider !== execution.targetProvider) {
    return false;
  }

  if (rule.resourceType !== "*" && rule.resourceType !== execution.resourceType) {
    return false;
  }

  if (rule.actionCategory !== "*" && rule.actionCategory !== execution.actionCategory) {
    return false;
  }

  // 絶対条件(SOR-51指示「Notion M-0 Binding」「unknownを推測しない」):
  // principal/agentの既知性をruleが要求する場合、未解決(null)なら
  // matchさせない——後続でresolvePermissionPolicy()がundefinedを返し、
  // evaluatePermission()がunknownへ倒れる。
  if (rule.requiresKnownActorId && !subject.id) {
    return false;
  }

  if (rule.requiresKnownAgentId && !execution.agentId) {
    return false;
  }

  // 加算的check(SOR-51 M-0、section3「connection/account scope」):
  // 未設定/"*"のruleはconnectionを一切見ない(M-0 Notion matrixは
  // connection単位で分岐しない)。明示的に設定されたruleのみ、
  // 一致しないconnectionIdでmatch失敗させる。
  if (rule.connectionId !== undefined && rule.connectionId !== "*" && rule.connectionId !== execution.connectionId) {
    return false;
  }

  return true;

}

// 最初に一致したruleを返す(絶対条件: 複数ruleが矛盾してmatchする
// 場合の優先順位はallowlistの登録順とする——core/tact-integration/
// policy.tsのlookupIntegrationActionPolicy()と同じ「exact match、
// 見つからなければundefined」という単純さを踏襲する)。
export function resolvePermissionPolicy(
  subject: PermissionSubject,
  execution: CanonicalExecution
): PermissionPolicyRule | undefined {

  return PERMISSION_POLICY_ALLOWLIST.find((rule) => matchesRule(rule, subject, execution));

}

// テスト専用: allowlist自体の内容を検証するためだけに公開する
// (core/tact-integration/policy.tsがPOLICY_ALLOWLIST自体を非公開に
// している方針とは異なり、SOR-51 Tests要件が「exact policy match」
// 等をallowlistの実際の登録内容に基づいて検証することを求めるため)。
export function listPermissionPolicyRules(): readonly PermissionPolicyRule[] {
  return PERMISSION_POLICY_ALLOWLIST;
}
