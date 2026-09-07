import type { IntegrationService } from "./types";

// =========================
// TACT Integration — Canonical Action Policy Registry
// (Architecture Migration Phase C2.2)
// =========================
//
// 目的: 「service+operationというcanonical integration actionが、
// read/write/destructiveのどれで、Approvalを必要とするか」を
// TACT Integration domainが所有するstatic allowlistとして定義する。
//
// 絶対条件(ユーザー指示 Correction 1、fail-closed allowlist):
// このRegistryは「実行可能なcanonical integration actionの
// allowlist」である。service+operationの組み合わせがここに
// 登録されていない場合、それは「未知のaction」であり、
// 「承認を取れば実行できる」という経路には絶対に乗せない
// (Approvalはauthorizationであり、未知operationをProviderへ
// 流してよいことにするvalidationではない)。lookup系関数は
// 見つからない場合は必ずundefinedを返し、呼び出し元は
// 「実行そのものを拒否する」ことだけを行う——「承認必須へ安全側
// fallbackする」という設計は採用しない(それ自体が「未知でも
// 人間が承認すれば実行できる」という禁止された構造になるため)。
//
// 絶対条件(ユーザー指示 Correction 1): riskClassとrequiresApprovalを
// 別々に手書きし、矛盾しうる2つのsource of truthを作らない。
// requiresApprovalは常にriskClassから導出する
// (requiresApprovalForRiskClass()、read以外は常にtrue)。将来
// policy override(例: 特定操作だけ追加確認を挟む)が必要になった
// 場合は、この導出関数自体を拡張する形で対応する——今回は行わない。
//
// 絶対条件(ユーザー指示 Section4、Policy ownership): Composio等の
// Provider metadataをsource of truthにしない・Provider Adapterで
// risk判定をしない・OrchestratorにSlack operationごとのif文を
// 増やさない・Botでread/write判定をしない・
// core/tact-core/capabilities/registry.ts(runtime name→handler
// dispatcher)へこのpolicy metadataを混ぜない。このfileは
// core/tact-integration domain内に閉じた、純粋なstatic lookupのみ。

export type IntegrationRiskClass = "read" | "write" | "destructive";

export interface IntegrationActionPolicy {

  service: IntegrationService;

  operation: string;

  riskClass: IntegrationRiskClass;

}

// riskClass → requiresApprovalの唯一の導出ロジック(絶対条件:
// これ以外の場所でrequiresApprovalを手書きしない)。
export function requiresApprovalForRiskClass(riskClass: IntegrationRiskClass): boolean {
  return riskClass !== "read";
}

// =========================
// Initial allowlist (Phase C2.2)
// =========================
//
// 絶対条件(ユーザー指示 Section3): 既に実コードで確認済みのcanonical
// actionだけを登録する。将来のaction(Calendar/Gmail・destructive操作等)
// を先回りして大量登録しない。
//
//   slack.send_message  → write(既存Phase C1〜C2.1c実装、Approval必須)
//   slack.list_channels → read(Phase C2.2で新規追加、Approval不要)
//
// 注意(Phase C2.2a/C2.2b): slack.list_channelsは、Composio metadata
// API(live、tool実行は伴わない)から一次確認したexact tool slug
// (SLACK_LIST_ALL_CHANNELS)・input/output schemaに基づき、
// core/tact-integration/providers/composio/mappings/slack.tsで
// Provider mappingまで完成済み。
const POLICY_ALLOWLIST: readonly IntegrationActionPolicy[] = [
  { service: "slack", operation: "send_message", riskClass: "write" },
  { service: "slack", operation: "list_channels", riskClass: "read" },
];

// service+operationの組み合わせで完全一致するpolicyだけを返す。
// 見つからない場合はundefined(絶対条件: 安全側fallbackとして
// 別のriskClassを補って返すことはしない——「見つからない」という
// 事実そのものが呼び出し元にとって唯一の正しいsignalである)。
export function lookupIntegrationActionPolicy(
  service: string,
  operation: string
): IntegrationActionPolicy | undefined {

  return POLICY_ALLOWLIST.find(
    (policy) => policy.service === service && policy.operation === operation
  );

}

export interface ResolvedIntegrationActionPolicy extends IntegrationActionPolicy {
  requiresApproval: boolean;
}

// lookupIntegrationActionPolicy() + requiresApprovalForRiskClass()を
// 1回で行う便宜関数(呼び出し元がriskClassからrequiresApprovalを
// 独自に再導出する重複コードを増やさないため)。
export function resolveIntegrationActionPolicy(
  service: string,
  operation: string
): ResolvedIntegrationActionPolicy | undefined {

  const policy = lookupIntegrationActionPolicy(service, operation);

  if (!policy) {
    return undefined;
  }

  return { ...policy, requiresApproval: requiresApprovalForRiskClass(policy.riskClass) };

}
