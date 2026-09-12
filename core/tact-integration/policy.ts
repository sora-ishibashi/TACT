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
  { service: "gmail", operation: "search_messages", riskClass: "read" },
  { service: "gmail", operation: "send_message", riskClass: "write" },
  { service: "notion", operation: "search", riskClass: "read" },
  { service: "notion", operation: "read_page", riskClass: "read" },
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

// =========================
// Canonical PolicyDecision (Fast Port P2a: Preloop PolicyDecision /
// pre-execution gate pattern port — ADAPT_AND_BORROW, not a source copy)
// =========================
//
// 目的(docs/architecture/p2-p5-final-architecture.md Section5-8):
// 既存の暗黙3-state挙動(requiresApproval:boolean + policy未検出=呼び出し元が
// 個別にinvalid_action等へ変換する)を、明示的な4-state canonical
// PolicyDecisionへformalizeする。Preloopの`PolicyDecision`
// (action ∈ {allow, deny, require_approval} + 別経路のask_user)から、
// 「pre-execution評価」「machine-readable state」「actor/action/context
// 分離」「authorizationとexecutionの責務分離」という設計思想だけを
// TACT TypeScript流に移植する——Preloopのsource code(Python/FastAPI/
// SQLAlchemy)は一切コピーしていない。
//
// 絶対条件(Fast Port P2a指示、最重要):
//   - riskClass(Actionの危険度)とPolicyDecision(今この
//     Actionをどう扱うか)は別軸のまま。requiresApprovalForRiskClass()
//     という既存の唯一のsource of truthを、この先も再利用するだけで
//     複製しない(既存の絶対条件をそのまま継承)。
//   - unknown service/operationはALLOWへfallbackしない(fail-closed、
//     Preloopのfail-closed-on-evaluator-errorパターンと同じ精神)。
//   - REQUIRE_INPUTはREQUIRE_APPROVALの代替ではない
//     (Authorization拒否ではなく、安全な実行に必要な情報が不足して
//     いるだけ)。P2a時点ではこの決定を実際に生成するCapability
//     Producerが存在しないため、evaluatePolicyDecision()からは
//     一切返さない——型として構築可能であることだけをテスト/将来の
//     呼び出し元のためにbuildRequireInputDecision()で保証する
//     (Step9 Non-goals: Provider call/Run/Approval/Work状態変更/
//     Clarification entity/Slack質問のいずれも、この関数自体は
//     一切発生させない——単なるpure data constructor)。
//   - このfileはまだ誰からも呼ばれない(P2a Non-goal: 既存caller
//     移植はP2bのscope)。core/tact-integration/execution.ts・
//     core/tact-integration/capability.tsの現在の挙動は一切変更
//     されない。

export type PolicyDecisionOutcome = "allow" | "require_approval" | "require_input" | "deny";

// 将来のARCH-P4 Audit Eventでもそのまま使えるstable machine-readable
// codeを意識する(docs/architecture/p2-p5-final-architecture.md
// Section5)。既存に実在するcaseだけを登録し、まだ存在しないcaseを
// 先回りして大量登録しない(Step3絶対条件)。
export type PolicyReasonCode =
  | "allowed_read"
  | "approval_required_write"
  | "approval_required_destructive"
  | "denied_unknown_service"
  | "denied_unknown_operation"
  | "required_input_missing_parameters";

// decision fieldでexhaustive switchできるdiscriminated union
// (boolean flagsで表現しない、Step2絶対条件)。raw error文字列は
// 一切含めない——machine state(decision/riskClass/reasonCode)と
// human向けmessageを分離する(reasonCodeから先の文言組み立ては
// 呼び出し元/Bot層の責務)。
export type PolicyDecision =
  | { decision: "allow"; riskClass: IntegrationRiskClass; reasonCode: PolicyReasonCode }
  | { decision: "require_approval"; riskClass: IntegrationRiskClass; reasonCode: PolicyReasonCode }
  | {
      decision: "require_input";
      riskClass: IntegrationRiskClass | null;
      reasonCode: PolicyReasonCode;
      missingParameters?: readonly string[];
    }
  | { decision: "deny"; riskClass: IntegrationRiskClass | null; reasonCode: PolicyReasonCode };

// service自体がallowlistに一件でも登録されているかどうかを見るための
// 内部専用helper。「未登録operation(service既知)」と「未登録service」
// を別のreasonCodeとして区別するためだけに使う(POLICY_ALLOWLIST自体は
// この先もexportしない、絶対条件: 唯一のstatic allowlistとしての
// カプセル化を崩さない)。
function isKnownIntegrationService(service: string): boolean {
  return POLICY_ALLOWLIST.some((entry) => entry.service === service);
}

// =========================
// evaluatePolicyDecision (pure function, P2a foundation)
// =========================
//
// 既存のlookupIntegrationActionPolicy()/requiresApprovalForRiskClass()
// を再利用するだけで、新しいpolicy registryを複製しない(Step5絶対
// 条件)。DBアクセス・Provider呼び出し・Approval作成のいずれも行わない
// 純粋関数。
//
// 既知mapping(Step6、既存POLICY_ALLOWLISTの登録内容をそのまま反映):
//   slack.list_channels (read)        -> allow
//   slack.send_message  (write)       -> require_approval
//   未登録operation(service既知)      -> deny (denied_unknown_operation)
//   未登録service                      -> deny (denied_unknown_service)
//
// destructive riskClassについて(Step4への回答): 既存の
// requiresApprovalForRiskClass()は"write"/"destructive"のいずれも
// true(承認必要)を返す唯一のsource of truthであり、この関数は
// それをそのまま再利用するだけで独自のriskClass判定を追加しない
// (絶対条件: 既存behaviorを勝手に変えない)。したがって現時点では
// destructiveも require_approval へ倒れる——「destructiveは常にDENY」
// という新しいruleは、既存source of truthを書き換える別の意思決定を
// 必要とするため、P2aでは導入しない(現時点でdestructiveとして
// 登録済みのactionは存在せず、この選択が現在のライブ挙動へ与える
// 影響も無い)。
export function evaluatePolicyDecision(service: string, operation: string): PolicyDecision {

  const policy = lookupIntegrationActionPolicy(service, operation);

  if (!policy) {

    return {
      decision: "deny",
      riskClass: null,
      reasonCode: isKnownIntegrationService(service)
        ? "denied_unknown_operation"
        : "denied_unknown_service",
    };

  }

  if (!requiresApprovalForRiskClass(policy.riskClass)) {

    return { decision: "allow", riskClass: policy.riskClass, reasonCode: "allowed_read" };

  }

  return {
    decision: "require_approval",
    riskClass: policy.riskClass,
    reasonCode:
      policy.riskClass === "write" ? "approval_required_write" : "approval_required_destructive",
  };

}

// =========================
// buildRequireInputDecision (REQUIRE_INPUT foundation, P2a)
// =========================
//
// Step9絶対条件: REQUIRE_INPUTは正式なcanonical decision値として
// 追加するが、P2a時点でこれを実際に生成するCapability Producerは
// 存在しない(既存のambiguity検出はcore/tact-orchestrator/
// ambiguityDetector.ts側の別経路であり、この関数自身はDBアクセス・
// Provider呼び出し・Approval/Run/Clarification entityの作成のいずれも
// 一切行わない、単なるpure data constructor)。evaluatePolicyDecision()
// からは一切返されない——型としての構築可能性(exhaustive switch対応・
// テストでのconstructibility確認)だけを保証する目的で用意する。
export function buildRequireInputDecision(
  reasonCode: PolicyReasonCode,
  options?: { riskClass?: IntegrationRiskClass | null; missingParameters?: readonly string[] }
): PolicyDecision {

  return {
    decision: "require_input",
    riskClass: options?.riskClass ?? null,
    reasonCode,
    missingParameters: options?.missingParameters,
  };

}
