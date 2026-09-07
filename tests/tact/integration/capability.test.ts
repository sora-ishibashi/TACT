// =========================
// TACT Integration — "integration.slack.send_message" /
// "integration.slack.list_channels" Capability Regression
// (Architecture Migration Phase C2.1b / C2.2)
// =========================
//
// 対象: core/tact-integration/capability.tsのrunIntegrationSlackSend
// MessageCapability() / runIntegrationSlackListChannelsCapability()。
// いずれも純粋関数(DBアクセス・Composio呼び出しなし)のため、
// Category A(Deterministic Evaluation)。

import {
  runIntegrationSlackSendMessageCapability,
  runIntegrationSlackListChannelsCapability,
} from "../../../core/tact-integration/capability";
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

  // =========================
  // send_message (write)
  // =========================

  // ---- 正常系: channel/textが両方揃っている場合 ----
  {
    const result = await runIntegrationSlackSendMessageCapability(
      makeRequest("Slackの#tactに『明日の会議は10時です』って送って")
    );

    results.push(
      check(
        "[正常系] success:true、integrationRequirementが設定される(旧approvalRequirementは使わない、Correction2)",
        result.success === true && !!result.integrationRequirement && result.approvalRequirement === undefined
      )
    );

    results.push(
      check(
        "[正常系] Phase C2.2: integrationRequirement.requiresApproval===true(policy.ts上writeとして登録済み)",
        result.integrationRequirement?.requiresApproval === true
      )
    );

    results.push(
      check(
        "[正常系] integrationRequirement.action.kindが'integration_action'",
        result.integrationRequirement?.action?.kind === "integration_action"
      )
    );

    const metadata = result.integrationRequirement?.action?.metadata as
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

  // =========================
  // list_channels (read, Phase C2.2新規)
  // =========================

  {
    const result = await runIntegrationSlackListChannelsCapability();

    results.push(
      check(
        "[Case P2] success:true、integrationRequirementが設定される",
        result.success === true && !!result.integrationRequirement
      )
    );

    results.push(
      check(
        "[Case P2] integrationRequirement.requiresApproval===false(policy.ts上readとして登録済み)",
        result.integrationRequirement?.requiresApproval === false
      )
    );

    const metadata = result.integrationRequirement?.action?.metadata as
      | { service?: unknown; operation?: unknown; input?: unknown }
      | undefined;

    results.push(
      check(
        "[Case P2] metadataがcanonical shape({service:'slack', operation:'list_channels', input:{}})を持つ",
        metadata?.service === "slack" &&
          metadata?.operation === "list_channels" &&
          JSON.stringify(metadata?.input) === JSON.stringify({})
      )
    );

    results.push(
      check(
        "[Case P2] 結果にComposio/provider固有の識別子が一切含まれない",
        !JSON.stringify(result).toLowerCase().includes("composio")
      )
    );
  }

  return summarize("integration/capability", results);

}
