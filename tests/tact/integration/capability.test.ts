// =========================
// TACT Integration — "integration.slack.send_message" Capability
// Regression (Architecture Migration Phase C2.1b)
// =========================
//
// 対象: core/tact-integration/capability.tsのrunIntegrationSlackSend
// MessageCapability()。純粋関数(DBアクセス・Composio呼び出しなし)の
// ため、Category A(Deterministic Evaluation)。

import { runIntegrationSlackSendMessageCapability } from "../../../core/tact-integration/capability";
import type { CapabilityInvocationRequest } from "../../../core/tact-orchestrator/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeRequest(query: string): CapabilityInvocationRequest {
  return {
    query,
    context: { memories: [], knowledge: [], examples: [], recentExecutions: [] },
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 正常系: channel/textが両方揃っている場合 ----
  {
    const result = await runIntegrationSlackSendMessageCapability(
      makeRequest("Slackの#tactに『明日の会議は10時です』って送って")
    );

    results.push(
      check(
        "[正常系] success:true、approvalRequirementが設定される",
        result.success === true && !!result.approvalRequirement
      )
    );

    results.push(
      check(
        "[正常系] approvalRequirement.action.kindが'integration_action'",
        result.approvalRequirement?.action?.kind === "integration_action"
      )
    );

    const metadata = result.approvalRequirement?.action?.metadata as
      | { service?: unknown; operation?: unknown; input?: { channel?: unknown; text?: unknown } }
      | undefined;

    results.push(
      check(
        "[正常系] metadataがcanonical shape({service,operation,input:{channel,text}})を持つ",
        metadata?.service === "slack" &&
          metadata?.operation === "send_message" &&
          metadata?.input?.channel === "tact" &&
          metadata?.input?.text === "明日の会議は10時です"
      )
    );

    results.push(
      check(
        "[正常系] metadataにconnectionIdはまだ含まれない(Connection解決はcore/tact-work側の責務)",
        !metadata || !("connectionId" in metadata)
      )
    );

    // ---- Case 9: provider-specific identifierが一切含まれない ----
    const serialized = JSON.stringify(result).toLowerCase();

    results.push(
      check(
        "[Case9] 結果にComposio/provider固有の識別子が一切含まれない(slack_send_message tool slug/markdown_text/connectedAccountId等)",
        !serialized.includes("composio") &&
          !serialized.includes("slack_send_message") &&
          !serialized.includes("markdown_text") &&
          !serialized.includes("connectedaccountid") &&
          !serialized.includes("toolkit")
      )
    );
  }

  // ---- 防御的: 何らかの理由でrouting層の判定と食い違う場合 ----
  {
    const result = await runIntegrationSlackSendMessageCapability(
      makeRequest("Slackに送って")
    );

    results.push(
      check(
        "[防御的] channel/textを抽出できない場合、例外を投げずsuccess:falseを返す",
        result.success === false && typeof result.errorMessage === "string"
      )
    );
  }

  return summarize("integration/capability", results);

}
