// =========================
// TACT Integration — Canonical Domain Types
// (Architecture Migration Phase C1: Integration Gateway Foundation +
// Composio Adapter)
// =========================
//
// Phase C0 Architecture Decisionの帰結: TACTはIntegration Gateway・
// Canonical Connection referenceを所有し、SaaS OAuth・credential
// storage・token refresh・SaaS API差分・Tool schema・Tool execution・
// trigger infrastructureは可能な限り外部Providerへ委託する
// (Phase C1の最初のProvider実装はComposio)。
//
// 絶対条件(Phase C1指示Section7): Composio固有の識別子
// (composioUserId・composioConnectedAccountId・composioToolSlug・
// composioLogId等)をこのファイルへ一切持ち込まない。Canonical
// actionは`service`+`operation`という抽象形のみを持ち、Provider固有
// のTool slugへの変換はcore/tact-integration/providers/composio/配下
// でのみ行う(絶対条件5: Composio SDK importをprovider layer外へ
// 拡散させない)。
//
// TACT architecture = Composio architectureにしない。将来
// TACT Integration Gatewayの下にMCP/Pipedream/Merge/Native等を
// 追加・交換できるよう、この型はどのProviderにも依存しない形で
// 設計する。

// =========================
// Canonical Action (Provider非依存)
// =========================

// Phase C1ではSlackのみ(絶対条件: 巨大なIntegrationを一度に作らない)。
export type IntegrationService = "slack" | "gmail";

export interface IntegrationAction {

  service: IntegrationService;

  // 自由文字列(例: "send_message")。Provider Tool slugそのものでは
  // ない——Composio Adapter内部でのみ、Provider固有のTool slug
  // (例: "SLACK_SEND_MESSAGE")へ変換する。
  operation: string;

  input: Record<string, unknown>;

}

// =========================
// Canonical Read Result (Architecture Migration Phase C2.2)
// =========================
//
// service="slack", operation="list_channels"のprovider raw response
// (Composio tool result)から変換される、canonical(Provider非依存)な
// 最小shape。絶対条件(ユーザー指示Section7): raw metadata・paging
// internals・team internals・Composio固有field・execution log ID等を
// 一切含めない。channel idは内部監査用途にのみ保持し、Bot visible
// resultでは原則nameのみを使う(表示都合の判断はcore/tact-conversation
// /core/tact-bot境界が行う、このfileはcanonical dataの形だけを持つ)。
//
// Architecture Migration Phase C2.2a(schema verification、live Composio
// metadata APIで一次確認済み)確認済み事実: Composio SLACK_LIST_ALL_
// CHANNELSのoutput schema上、ChannelItem.required = ["id", "created"]
// のみ——nameはoptional("Not present for DM channels")。schemaを正と
// し、nameもrequiredではなくoptionalへ修正する(idのみschema上
// requiredなのでrequiredのまま維持)。raw→canonical変換の実装は
// core/tact-integration/providers/composio/mappings/slack.tsの
// mapComposioListChannelsResultToCanonical()を参照(Phase C2.2bで完成)。
export interface SlackChannelSummary {

  id: string;

  name?: string;

  isPrivate?: boolean;

}

export interface SlackListChannelsResult {

  channels: SlackChannelSummary[];

}

// Gmail read results are deliberately compact and provider-neutral.  In
// particular, no raw headers, HTML, attachments, or provider metadata cross
// this boundary.
export interface GmailMessageSummary {
  messageId: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  snippet?: string;
  bodyText?: string;
}

export interface GmailSearchMessagesResult {
  messages: GmailMessageSummary[];
}

// =========================
// Integration Execution Request/Result (Gateway/Provider契約)
// =========================
//
// 絶対条件: connectionIdはTACT Canonical Connection.idであり、
// Provider側の接続参照(Composio connected account id等)はこの型に
// 直接持たせない——Provider Adapterが自分でConnectionを解決するの
// ではなく、Execution Boundary(core/tact-integration/execution.ts)が
// Connection ownershipを確認した上でproviderConnectionRef(resolved
// value)を渡す(絶対条件: Gateway/Adapter自体はSupabase/Connection
// storeへ依存しない、Providerを純粋なexecution層に保つ)。

export interface IntegrationExecutionRequest {

  userId: string;

  workId: string;

  taskId?: string | null;

  approvalId?: string | null;

  // TACT Canonical Connection.id(監査・trace用)。
  connectionId: string;

  // Execution Boundaryが解決済みの、Provider側の接続参照。Provider
  // Adapterはこれをそのまま使うだけで、Connection storeへは一切
  // 問い合わせない。
  providerConnectionRef: string;

  action: IntegrationAction;

}

export type IntegrationErrorCode =
  | "connection_missing"
  | "authentication_error"
  | "invalid_action"
  | "provider_execution_failed"
  | "temporary_failure"
  | "authorization_denied";

export interface IntegrationExecutionError {

  code: IntegrationErrorCode;

  message: string;

  // Phase C1絶対条件(Section20): protected writeへ自動retryを
  // 一切行わないため、この値がtrueであっても、このGateway/Adapter
  // 自身が再試行することは無い。将来、Provider側でbackend-honored
  // idempotency keyが提供された時点で、呼び出し元(上位layer/人間)が
  // この値を判断材料として使うための情報にとどめる。
  retryable: boolean;

  // Provider固有の詳細(Composio raw error等)。Canonical layerの
  // 判断には使わない、あくまで診断用の付随情報。
  providerDetails?: Record<string, unknown>;

}

export type IntegrationExecutionResult =
  | {
      status: "completed";
      providerExecutionRef?: string | null;
      output?: unknown;
    }
  | {
      status: "failed";
      error: IntegrationExecutionError;
      providerExecutionRef?: string | null;
    };

export interface IntegrationProvider {

  execute(request: IntegrationExecutionRequest): Promise<IntegrationExecutionResult>;

}

// =========================
// Canonical Connection (最小Connection foundation)
// =========================
//
// 絶対条件(Phase C1指示Section8): token/access token/refresh token/
// OAuth secretは一切保存しない。credential本体はProvider
// (Composio)側が保持し、TACTはprovider/providerConnectionRefという
// 「論理的な参照」だけを持つ。

export type ConnectionStatus = "pending" | "active" | "failed" | "revoked";

export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  "pending",
  "active",
  "failed",
  "revoked",
];

// Phase C1で唯一のProvider実装。将来MCP/Pipedream/Merge/Native等を
// 追加する場合はこのunionへ値を足すだけでよい(Work/Task/Approvalの
// canonical typeには一切影響しない、Integration infrastructure領域
// だけに隔離された変更)。
export type ConnectionProviderKind = "composio";

export interface Connection {

  id: string;

  userId: string;

  service: IntegrationService;

  status: ConnectionStatus;

  provider: ConnectionProviderKind;

  // Provider側の接続参照(例: Composio connected account id)。
  // credential/token本体ではない。
  providerConnectionRef: string;

  // Provider固有の非機密メタデータ(例: Composio側の詳細status)。
  // 絶対条件: secret/token/credentialをここへ入れない
  // (アプリケーション層のtest/レビューで担保する、DB制約では
  // 強制できないjsonbの自由形式であるため)。
  metadata?: Record<string, unknown> | null;

  createdAt: string;

  updatedAt: string;

}
