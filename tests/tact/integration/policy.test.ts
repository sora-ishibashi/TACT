// =========================
// TACT Integration — Canonical Action Policy Regression
// (Architecture Migration Phase C2.2)
// =========================
//
// 対象: core/tact-integration/policy.tsのlookupIntegrationActionPolicy()
// /resolveIntegrationActionPolicy()/requiresApprovalForRiskClass()。
// 純粋関数・静的allowlistのみ(DBアクセス・Composio呼び出しなし)。

import {
  lookupIntegrationActionPolicy,
  resolveIntegrationActionPolicy,
  requiresApprovalForRiskClass,
} from "../../../core/tact-integration/policy";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case P1: slack.send_message -> write / requiresApproval:true ----
  {
    const policy = resolveIntegrationActionPolicy("slack", "send_message");

    results.push(
      check(
        "[Case P1] slack.send_messageはriskClass='write'として登録されている",
        policy?.riskClass === "write"
      )
    );

    results.push(
      check(
        "[Case P1] slack.send_messageはrequiresApproval===true",
        policy?.requiresApproval === true
      )
    );
  }

  // ---- Case P2: slack.list_channels -> read / requiresApproval:false ----
  {
    const policy = resolveIntegrationActionPolicy("slack", "list_channels");

    results.push(
      check(
        "[Case P2] slack.list_channelsはriskClass='read'として登録されている",
        policy?.riskClass === "read"
      )
    );

    results.push(
      check(
        "[Case P2] slack.list_channelsはrequiresApproval===false",
        policy?.requiresApproval === false
      )
    );
  }

  // ---- Case P3: unknown action -> policy無し、read側へfallbackしない ----
  {
    const lookup = lookupIntegrationActionPolicy("slack", "delete_channel");
    const resolved = resolveIntegrationActionPolicy("slack", "delete_channel");

    results.push(
      check(
        "[Case P3] 未登録のoperation(slack.delete_channel)はlookupIntegrationActionPolicy()がundefinedを返す(fail-closed、allowlistに無いものは実行可能扱いにしない)",
        lookup === undefined && resolved === undefined
      )
    );

    const unknownService = resolveIntegrationActionPolicy("gmail", "send_message");

    results.push(
      check(
        "[Case P3] 未登録のservice(gmail)も同様にundefinedを返す(service+operationの完全一致のみ許可)",
        unknownService === undefined
      )
    );
  }

  // ---- requiresApprovalForRiskClass(): 唯一のsource of truth ----
  {
    results.push(
      check(
        "[絶対条件] requiresApprovalForRiskClass('read')===false、'write'/'destructive'===true(riskClass以外にrequiresApprovalを手書きしない設計の直接確認)",
        requiresApprovalForRiskClass("read") === false &&
          requiresApprovalForRiskClass("write") === true &&
          requiresApprovalForRiskClass("destructive") === true
      )
    );
  }

  // ---- destructive future-proofing: 型として表現可能(実action未登録) ----
  {
    const anyDestructiveRegistered =
      resolveIntegrationActionPolicy("slack", "send_message")?.riskClass === "destructive" ||
      resolveIntegrationActionPolicy("slack", "list_channels")?.riskClass === "destructive";

    results.push(
      check(
        "[Section22] Phase C2.2時点でdestructiveとして登録されたactionは存在しない(型としてのみ表現可能、実装は将来)",
        !anyDestructiveRegistered
      )
    );
  }

  return summarize("integration/policy", results);

}
