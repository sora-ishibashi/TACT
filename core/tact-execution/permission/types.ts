// =========================
// TACT Canonical Execution — Permission Observation Types (SOR-51)
// =========================
//
// Core Principle(SOR-51指示、最重要): Executionは「実際に起きた事実」、
// Permission Policyは「起きてよいこと」——この2つを混ぜない。この
// fileはPolicy/Decision側の型だけを持ち、CanonicalExecution
// (../types.ts)へpolicy語彙を混入させない。
//
// 既存core/tact-integration/policy.tsとの区別(意図的に統合しない
// 理由): 既存Policyは「TACT自身がこれから実行してよいか」の
// PRE-EXECUTION gate(未知はdenyへfail closed)。対してこちらは
// 「既に起きたExecutionが期待どおりだったか」のPOST-HOC観測
// (未知はunknownへfail closed、denyのような断定はしない)。目的・
// timing・fail-closed先が異なるため分離する
// (supabase/migrations/20261021000000_create_tact_execution_permission_decisions.sql
// 冒頭コメント参照)。

import type { JsonValue } from "../../tact-work/approvalIntegrity";
import type {
  CanonicalExecution,
  ExecutionActorKind,
  ExecutionActionCategory,
  ExecutionProvider,
} from "../types";

// evaluatePolicyDecision()のPolicyDecisionOutcome(allow/require_approval/
// require_input/deny)とは別の、独立した4値。「pending」はDBの初期値
// (未評価)であり、決定そのものの値ではない(../types.tsの
// ExecutionPermissionStatusは「pending」を含む5値、こちらはEvaluatorが
// 実際に返せる4値のみ)。
//
// SOR-51 M-0(Notion Permission Registry、絶対条件「Do not flatten
// approval into denied」): "approval_required"はdenied/deniedのどちらとも
// 異なる独立した意味を持つ——「実行可能性の可否」ではなく「registered
// permissionが人間承認必須と定義している」ことを表す。deniedへ丸めたり
// allowedへ寄せたりしない。SOR-52のAttentionが後続でこの値を使う。
export type PermissionDecisionStatus = "allowed" | "denied" | "unknown" | "approval_required";

export const PERMISSION_DECISION_STATUSES: readonly PermissionDecisionStatus[] = [
  "allowed",
  "denied",
  "unknown",
  "approval_required",
];

// Executionのactor情報から機械的に導出する評価対象(Permission Context
// Resolverの出力)。SOR-51指示: 「過剰なActor Registryを新設しない」
// ——CanonicalExecutionが既に持つactorKind/actorId(../types.tsの
// ExecutionActorReferenceと同じ形)をそのまま使う。
export interface PermissionSubject {

  kind: ExecutionActorKind;

  id: string | null;

}

// policyが1件もmatchしなかった場合のsentinel(NULLをUNIQUE indexで
// 使うとPostgres上「distinct」になり重複排除にならないため、
// migration側もこの値をNOT NULL制約の実際の値として使う)。
export const NO_MATCHING_POLICY_ID = "none";

export interface PermissionPolicyRule {

  id: string;

  // "*" は「どのkindでもmatchする」wildcard(SOR-51指示: 個別actorId
  // までは登録しない、Actor Registry未実装のため)。
  subjectKind: ExecutionActorKind | "*";

  // Executionの観測元(CanonicalExecution.provider、SOR-51 M-0時点では
  // Slack app_mention等、providerそのものが対象systemであるケースの
  // ための既存field。MCP経由(provider="mcp")等、観測元と実際の対象
  // systemが異なる場合はtargetProviderを使う(下記)。
  provider: ExecutionProvider | "*";

  // SOR-51 M-0(Notion Permission Registry、加算的field): 実際の対象
  // system(CanonicalExecution.targetProvider)でmatchしたい場合に設定
  // する。未設定(undefined)のruleはこのfieldを一切見ない——既存の
  // Slack rule(providerのみで判定)の挙動を変えない。MCP経由でobserve
  // されたNotion実行はprovider="mcp"・targetProvider="notion"となる
  // (core/tact-execution/adapters/notion/normalizeNotionMcpExecution.ts)
  // ため、Notion向けruleはこちらを使う。
  targetProvider?: ExecutionProvider | "*";

  resourceType: string | "*";

  actionCategory: ExecutionActionCategory | "*";

  // SOR-51 M-0: "approval_required"はallowed/deniedのどちらでもない、
  // 独立した3番目のpermission mode(PermissionDecisionStatus参照)。
  decision: "allowed" | "denied" | "approval_required";

  reasonCode: string;

  // SOR-51 M-0(加算的field、既定false): このruleがmatchするために
  // Subject.id(actorId、「test principal」等)が既知である必要がある
  // 場合にtrueを設定する。未設定のruleはこの要件を課さない(既存
  // Slack ruleの挙動を変えない)——unknown principalはmatch失敗へ倒し、
  // 推測でmatchさせない(SOR-51指示、Notion M-0 binding)。
  requiresKnownActorId?: boolean;

  // 同上、CanonicalExecution.agentId(「Claude Test Agent」等)が既知で
  // ある必要がある場合。
  requiresKnownAgentId?: boolean;

  // SOR-51 M-0(加算的field): connection/account scopeを明示的に
  // 制限したいruleのみ設定する。未設定/"*"は「どのconnectionでも
  // match」——M-0のNotion permission matrixはconnection単位で分岐
  // しないため、この時点で登録するruleはこのfieldを使わない
  // (将来必要になった時のための registry capability として用意する、
  // section3「connection/account scope」要件)。
  connectionId?: string | "*";

}

export interface PermissionDecision {

  executionId: string;

  status: PermissionDecisionStatus;

  reasonCode: string;

  // matchしたPermissionPolicyRule.id。matchしなかった場合は
  // NO_MATCHING_POLICY_ID。ドメイン層では「実際に何かpolicyが
  // matchしたか」を正直に表現するため、公開APIとしてはnullも許容する
  // (DB格納時のみsentinelへ変換する、store.ts参照)。
  policyId: string | null;

  evaluatorVersion: string;

  // 巨大なJSON dump禁止(絶対条件)。findSuspiciousExecutionMetadataKeys()
  // と同じguardをvalidation側で適用する。
  metadata?: JsonValue | null;

  evaluatedAt: string;

  // SOR-47(Permission Registry v1-minimal、Historical explainability):
  // 静的allowlist経由のdecision(evaluatePermission())では常にnull/
  // undefined。Registry経由のdecision(evaluatePermissionWithRules())
  // のみ、実際にmatchしたtact_execution_permission_rules行のidと、
  // match時点でのその行のrevisionを持つ——rule行が後で編集/削除
  // されても、このdecisionが「当時何にmatchしたか」を説明できる
  // ようにするため(現在のmutable rule行を参照しない、絶対条件)。
  registryRuleId?: string | null;

  registryRuleRevision?: number | null;

}

// =========================
// Permission Registry v1-minimal (SOR-47)
// =========================
//
// core/tact-execution/permission/policy.tsの静的PermissionPolicyRule
// (application層のみに存在するhardcoded allowlist)とは別の、DB-backed・
// tenant-scopedなrule。supabase/migrations/
// 20261030000000_create_tact_execution_permission_rules.sqlに対応する
// domain型。既存PermissionPolicyRuleは変更しない(cutoverまでは
// 並行稼働、Phase1では未接続)。
//
// "*" wildcard(静的allowlist側の表現)ではなく、DB列の実際の型に
// 合わせてnull = wildcardとする(nullable columnとして素直に表現
// できるため、boundary層(registryStore.ts)でのみ相互変換する)。
export interface PermissionRegistryRule {

  id: string;

  // null = system default/fallback rule(全tenantへ適用され得る、
  // tenant-specific ruleに常に劣後する)。非null = tenant-specific
  // rule(そのuserにのみ適用される)。
  userId: string | null;

  identifier: string;

  // 行の内容が変わるたびに増分する(registryStore.ts参照)。
  revision: number;

  subjectKind: ExecutionActorKind | null;

  // Human Owner指示section1「Principal/Agent scope」: 特定の
  // principal/agentへ限定したいruleのみ設定する。既存の
  // requiresKnownActorId/requiresKnownAgentId(既知でありさえすれば
  // よい)とは独立した、より厳格な追加条件。
  actorId: string | null;

  agentId: string | null;

  provider: ExecutionProvider | null;

  targetProvider: ExecutionProvider | null;

  resourceType: string | null;

  actionCategory: ExecutionActionCategory | null;

  decision: "allowed" | "denied" | "approval_required";

  reasonCode: string;

  requiresKnownActorId: boolean;

  requiresKnownAgentId: boolean;

  // account scopeという別fieldは設けない(repository realityの調査
  // 結果、tact_connectionsに独立したaccount列が存在しないため。
  // connectionId matchingがそのままaccount scopeを兼ねる、SOR-47
  // revised design section7参照)。
  connectionId: string | null;

  // 同一tier内でのmatch順のヒント(一意性は強制しない)。実際の
  // ambiguity検出はregistryEvaluate.ts側で行う。
  priority: number;

  // 半開区間[validFrom, validUntil)。nullは各方向で無制限。
  validFrom: string | null;

  validUntil: string | null;

  enabled: boolean;

  createdAt: string;

  updatedAt: string;

}

// admin/user CRUD boundary(app/api/tact/permission-rules/)からのみ
// 使う入力型。userId/identifier以外は全てoptional(未指定=wildcard/
// 既定値)。
export interface PermissionRegistryRuleInput {

  identifier: string;

  subjectKind?: ExecutionActorKind | null;

  actorId?: string | null;

  agentId?: string | null;

  provider?: ExecutionProvider | null;

  targetProvider?: ExecutionProvider | null;

  resourceType?: string | null;

  actionCategory?: ExecutionActionCategory | null;

  decision: "allowed" | "denied" | "approval_required";

  reasonCode: string;

  requiresKnownActorId?: boolean;

  requiresKnownAgentId?: boolean;

  connectionId?: string | null;

  priority?: number;

  validFrom?: string | null;

  validUntil?: string | null;

}

// update時はidentifier/decision/reasonCodeを含む任意のfieldを部分的に
// 変更できる(PATCH意味論)。enabled切り替え(disable)もこの型を使う。
export type PermissionRegistryRuleUpdateInput = Partial<PermissionRegistryRuleInput> & {
  enabled?: boolean;
};

export interface EvaluatePermissionInput {

  execution: CanonicalExecution;

}
