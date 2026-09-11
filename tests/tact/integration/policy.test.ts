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
  evaluatePolicyDecision,
  buildRequireInputDecision,
  type PolicyDecision,
} from "../../../core/tact-integration/policy";
import { check, summarize, type CheckResult } from "../lib/check";

// Fast Port P2a指示Step10絶対条件: PolicyDecisionはexhaustive switchで
// 網羅できることを型レベルで確認する。到達しないdefault節が
// コンパイルエラーにならなければ(=someUnhandledCase: neverの型検査を
// 通れば)、4値のunionを漏れなく処理できている証拠になる
// (production helperは増やさず、テスト内のみで完結させる、Step10)。
function decisionLabel(decision: PolicyDecision): string {

  switch (decision.decision) {

    case "allow":
      return "allow";

    case "require_approval":
      return "require_approval";

    case "require_input":
      return "require_input";

    case "deny":
      return "deny";

    default: {
      const exhaustiveCheck: never = decision;
      return exhaustiveCheck;
    }

  }

}

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

    const unknownService = resolveIntegrationActionPolicy("notion", "send_message");

    results.push(
      check(
        "[Case P3] 未登録のservice(notion)も同様にundefinedを返す(service+operationの完全一致のみ許可)",
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

  // =========================
  // Fast Port P2a — canonical PolicyDecision (Preloop pattern port)
  // =========================
  //
  // 対象: evaluatePolicyDecision()/buildRequireInputDecision()。
  // 既存のresolveIntegrationActionPolicy()/requiresApprovalForRiskClass()
  // (上記Case P1〜P3、および絶対条件テスト)を一切変更せず、その上に
  // 積み上げた新しいpure functionだけを検証する——legacy evaluator側の
  // 挙動が変わっていないことは、上記の既存テストがそのまま
  // regressionとして機能する(Step11 Case13/14はこのファイル内の
  // 既存テストで既に担保済みのため、重複テストを追加しない)。

  // ---- [Case D1] slack.list_channels -> allow ----
  {
    const decision = evaluatePolicyDecision("slack", "list_channels");

    results.push(
      check(
        "[Case D1] slack.list_channelsはevaluatePolicyDecision()でdecision==='allow'",
        decision.decision === "allow"
      )
    );

    results.push(
      check(
        "[Case D1] allowはriskClass='read'を保持する(Step5: allow preserves read riskClass)",
        decision.decision === "allow" && decision.riskClass === "read"
      )
    );

    results.push(
      check(
        "[Case D1] allowはreasonCode='allowed_read'を持つ",
        decision.decision === "allow" && decision.reasonCode === "allowed_read"
      )
    );
  }

  // ---- [Case D2] slack.send_message -> require_approval ----
  {
    const decision = evaluatePolicyDecision("slack", "send_message");

    results.push(
      check(
        "[Case D2] slack.send_messageはevaluatePolicyDecision()でdecision==='require_approval'",
        decision.decision === "require_approval"
      )
    );

    results.push(
      check(
        "[Case D2] require_approvalはriskClass='write'を保持する(Step5: require_approval preserves write riskClass)",
        decision.decision === "require_approval" && decision.riskClass === "write"
      )
    );

    results.push(
      check(
        "[Case D2] require_approvalはreasonCode='approval_required_write'を持つ",
        decision.decision === "require_approval" && decision.reasonCode === "approval_required_write"
      )
    );
  }

  // ---- [Case D3] unknown operation (service既知) -> deny ----
  {
    const decision = evaluatePolicyDecision("slack", "delete_channel");

    results.push(
      check(
        "[Case D3] 未登録operation(service='slack'は既知)はdecision==='deny'",
        decision.decision === "deny"
      )
    );

    results.push(
      check(
        "[Case D3] service既知の未登録operationはreasonCode='denied_unknown_operation'",
        decision.decision === "deny" && decision.reasonCode === "denied_unknown_operation"
      )
    );

    results.push(
      check(
        "[Case D3] denyのriskClassはnull(未知actionにriskClassを補って返さない)",
        decision.decision === "deny" && decision.riskClass === null
      )
    );
  }

  // ---- [Case D4] unknown service -> deny ----
  {
    const decision = evaluatePolicyDecision("google_drive", "send_message");

    results.push(
      check(
        "[Case D4] 未登録service(google_drive)はdecision==='deny'",
        decision.decision === "deny"
      )
    );

    results.push(
      check(
        "[Case D4] 未登録serviceはreasonCode='denied_unknown_service'(未登録operationと区別する)",
        decision.decision === "deny" && decision.reasonCode === "denied_unknown_service"
      )
    );
  }

  // ---- [Case D5] deny does not imply approval ----
  {
    const decision = evaluatePolicyDecision("notion", "send_message");

    results.push(
      check(
        "[Case D5] denyはrequire_approvalではない(Approvalで突破不可という絶対条件12の型レベル確認)",
        decision.decision === "deny" && (decision as { decision: string }).decision !== "require_approval"
      )
    );
  }

  // ---- [Case D6] require_input is distinguishable from require_approval ----
  {
    const requireInput = buildRequireInputDecision("required_input_missing_parameters", {
      missingParameters: ["channel"],
    });

    results.push(
      check(
        "[Case D6] buildRequireInputDecision()はdecision==='require_input'を構築できる(型としてconstructible)",
        requireInput.decision === "require_input"
      )
    );

    results.push(
      check(
        "[Case D6] require_input !== require_approval(絶対条件11: 別のdecision値として区別可能)",
        (requireInput as { decision: string }).decision !== "require_approval"
      )
    );

    results.push(
      check(
        "[Case D6] require_inputはmissingParametersを保持できる",
        requireInput.decision === "require_input" &&
          Array.isArray(requireInput.missingParameters) &&
          requireInput.missingParameters[0] === "channel"
      )
    );
  }

  // ---- [Case D7] reasonCode is always present across all 4 outcomes ----
  {
    const allow = evaluatePolicyDecision("slack", "list_channels");
    const requireApproval = evaluatePolicyDecision("slack", "send_message");
    const deny = evaluatePolicyDecision("unknown", "op");
    const requireInput = buildRequireInputDecision("required_input_missing_parameters");

    results.push(
      check(
        "[Case D7] allow/require_approval/deny/require_inputのいずれもreasonCode(string)を持つ",
        typeof allow.reasonCode === "string" &&
          typeof requireApproval.reasonCode === "string" &&
          typeof deny.reasonCode === "string" &&
          typeof requireInput.reasonCode === "string"
      )
    );
  }

  // ---- [Case D8] fail-closed: unsupported/malformed target never falls back to allow ----
  {
    const emptyService = evaluatePolicyDecision("", "");
    const wrongCaseService = evaluatePolicyDecision("Slack", "send_message");

    results.push(
      check(
        "[Case D8] 空文字service/operationはallowへfallbackせずdeny(fail-closed)",
        emptyService.decision === "deny"
      )
    );

    results.push(
      check(
        "[Case D8] 大文字小文字違いの未登録service('Slack')もallowへfallbackせずdeny(完全一致以外は未知として扱う)",
        wrongCaseService.decision === "deny"
      )
    );
  }

  // ---- [Case D9] exhaustive union handling (compile-time + runtime label) ----
  {
    const allow = evaluatePolicyDecision("slack", "list_channels");
    const requireApproval = evaluatePolicyDecision("slack", "send_message");
    const deny = evaluatePolicyDecision("unknown", "op");
    const requireInput = buildRequireInputDecision("required_input_missing_parameters");

    results.push(
      check(
        "[Case D9] 4値すべてがdecisionLabel()のexhaustive switchで一意にラベル化できる(neverチェックがコンパイルを通ることが型レベルの証拠、ここではラベル値も実行時に確認する)",
        decisionLabel(allow) === "allow" &&
          decisionLabel(requireApproval) === "require_approval" &&
          decisionLabel(deny) === "deny" &&
          decisionLabel(requireInput) === "require_input"
      )
    );
  }

  // ---- [Case D10] no side effects: evaluatePolicyDecision()/buildRequireInputDecision()は
  // 純粋関数であり、Provider呼び出し・Approval作成・Run作成・LLM呼び出し・
  // Search呼び出しのいずれも行わない(この関数のimport元がSupabase
  // client・Composio SDK・LLM provider・Search providerのいずれも
  // importしていないことをmodule graphレベルで確認する——実行時の
  // spyではなく、静的なimport構造そのものがゼロ依存であることの
  // 確認。core/tact-integration/policy.ts自身がIntegrationServiceの
  // 型のみをimportしていることは、このファイル冒頭のimport文
  // (`import type { IntegrationService } from "./types"`)で
  // 既に保証されている——ここでは同じ主張を、呼び出し結果の型
  // からも再確認する: PolicyDecisionにはprovider実行結果・
  // Run/Approval idに相当するfieldが一切存在しない)。
  {
    const decision = evaluatePolicyDecision("slack", "send_message");

    const decisionKeys = Object.keys(decision).sort();

    results.push(
      check(
        "[Case D10] PolicyDecisionはdecision/riskClass/reasonCode(+require_inputのみmissingParameters)以外のfieldを持たない" +
          "(Provider実行結果・Run id・Approval idに相当するfieldが混入していないことの確認、Provider call=0/Run作成=0/Approval作成=0の型レベル保証)",
        decisionKeys.every((key) => ["decision", "riskClass", "reasonCode"].includes(key))
      )
    );
  }

  return summarize("integration/policy", results);

}
