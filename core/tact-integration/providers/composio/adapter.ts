import {
  ComposioError,
  ComposioConnectedAccountNotFoundError,
  ComposioToolNotFoundError,
  ComposioToolVersionRequiredError,
  ComposioToolExecutionError,
  ComposioSharedAccessDeniedError,
} from "@composio/core";
import {
  getComposioClient,
  getGmailToolkitVersion,
  getSlackToolkitVersion,
  toComposioUserId,
} from "./client";
import { mapSlackActionToComposioTool, mapComposioListChannelsResultToCanonical } from "./mappings/slack";
import {
  mapComposioGmailSearchResultToCanonical,
  mapGmailActionToComposioTool,
} from "./mappings/gmail";
import type {
  IntegrationExecutionRequest,
  IntegrationExecutionResult,
  IntegrationExecutionError,
  IntegrationProvider,
} from "../../types";

// =========================
// TACT Integration — Composio Adapter (Architecture Migration Phase C1)
// =========================
//
// core/tact-integration/gateway.tsから呼ばれる、唯一のComposio実装。
// @composio/coreのimportはこのfile(および同じproviders/composio/
// 配下)だけに閉じ込める(絶対条件、Section5)。
//
// 絶対条件(Section20、Protected-write retry safety): 現在の公式SDK
// (@composio/core@0.18.1)は`tools.execute()`を明示的に
// "non-idempotent write"として扱い、SDK内部でこの呼び出し専用の
// retry無効化クライアント(clientWithoutRetries)を使っている
// ("a silent retry after a read timeout can duplicate the side
// effect"というSDK自身のコメント、@composio/core/src/models/Tools.ts
// で確認済み)。同コメントは「backend-honored idempotency keyは
// 別途trackingされている」=現時点では未提供とも明記している。
// したがって、このAdapterはtools.execute()を1回だけ呼び、いかなる
// 状況でも自動retryを行わない(呼び出し元のcore/tact-integration/
// execution.tsも同様)。

// =========================
// Provider diagnostic observability (LIVE-1A: Composio Error Cause
// Observability)
// =========================
//
// Root cause(READ-ONLY AUDIT、node_modules/@composio/core/src/errors/
// ToolErrors.tsのhandleToolExecutionError()確認済み): 認識済みerror
// code(現状1803=ConnectedAccountNotFoundのみ)以外の全ての失敗は、
// SDK自身によって`Error executing the tool ${tool}`という定型文へ
// 丸められる。ただしSDKはその際`cause: actualError`を保持しており
// (ComposioError.ts、Object.definePropertyでenumerable own propertyと
// して設定される)、causeがHTTP layerの`BadRequestError`ならさらに
// `statusCode`も同じ仕組みで保持される。これまでのnormalizeComposioError()
// はerror.message/name/codeしか読んでおらず、SDKが用意したこの
// diagnostic情報を自ら捨てていた。
//
// 絶対条件(最重要、Slack-facing安全設計は変更しない): ここで組み立てる
// providerDetailsはIntegrationExecutionError.providerDetails
// (core/tact-integration/types.ts、既存の「診断用の付随情報、
// Canonical layerの判断には使わない」field)へそのまま渡るだけの
// developer/audit専用データであり、core/tact-conversation/
// orchestration.tsのformatIntegrationReadFailureAnswer()や
// OrchestrationResult.integrationReadFailure(service/operation/
// statusのみ)には一切伝播しない——呼び出し元(core/tact-integration/
// execution.ts)がこれをTaskExecutionSummary/OrchestrationResultへ
// 転記することもない(絶対条件、下記emitAuditEvent呼び出しの
// detailsのみが対象)。
//
// Provider固有の識別子(connectedAccountId等)をcore/tact-integration/
// types.tsへ持ち込まないという既存絶対条件(Phase C1指示Section7)は
// 維持する——この型はこのfile(Composio provider実装)だけが持つ。
export interface ComposioProviderDiagnostics {

  provider: "composio";

  errorName?: string;

  providerCode?: string;

  statusCode?: number;

  causeName?: string;

  causeMessage?: string;

  // IntegrationExecutionError.providerDetails(core/tact-integration/
  // types.ts)がRecord<string, unknown>として定義されているため
  // (絶対条件: Canonical layerはComposio固有のnamed fieldを知らない、
  // 単なる不透明な診断bagとして扱う)、この具象型もそこへ構造的に
  // 代入できる必要がある——上記の named fieldsが実際に設定される
  // 値の全て(このfile自身がこれ以外のkeyを追加することは無い)。
  [key: string]: unknown;

}

const PROVIDER_DIAGNOSTIC_TEXT_MAX_LENGTH = 300;
const REDACTED = "[redacted]";

// 最小限のvalue-level sanitizer(絶対条件: 汎用redaction engineは
// 作らない、core/tact-work/audit.tsのfindSuspiciousKeys()と同じ
// 「機械的・最小限」という設計思想を踏襲するが、あちらはkey名だけを
// 見る guardであり、causeMessageという1つの自由文字列fieldの中身
// までは見ない——このfileだけの狭いscopeで、既知のsecret-shapedな
// パターンだけを対象にする)。
//
// knownSecretsには、この呼び出しで実際に使ったconnectedAccountId
// (=TACT自身が既に知っている値)を渡す——推測のパターンマッチに
// 頼らず、確実にexact stringとして除去できるもっとも安全な経路。
function sanitizeProviderDiagnosticText(text: string, knownSecrets: readonly string[] = []): string {

  let sanitized = text;

  for (const secret of knownSecrets) {

    if (secret) {
      sanitized = sanitized.split(secret).join(REDACTED);
    }

  }

  sanitized = sanitized
    // "Authorization: Bearer xxx" / "Bearer xxx"
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    // "Authorization: <scheme> <value>"(Basic/Digest等、Bearer以外の
    // schemeも含む)。値側に空白を含みうる(例: "Basic dXNlcjpwYXNz"は
    // 空白を含まないが、一般形として想定する)ため、行末までを対象に
    // する(`.`は改行にマッチしないため、次の行の非secret情報までは
    // 巻き込まない)。
    .replace(/\bAuthorization\s*[:=]\s*.+/gi, `Authorization: ${REDACTED}`)
    // key=value / "key": "value" 形の既知secret-shaped field名
    // (access_token/refresh_token/api_key/client_secret/
    // connected_account_id)。
    .replace(
      /\b(access_token|refresh_token|api[_-]?key|client_secret|connected_account_id)\b\s*[:=]\s*["']?[^"'\s,}]+["']?/gi,
      (_match, key: string) => `${key}=${REDACTED}`
    );

  return sanitized.length > PROVIDER_DIAGNOSTIC_TEXT_MAX_LENGTH
    ? `${sanitized.slice(0, PROVIDER_DIAGNOSTIC_TEXT_MAX_LENGTH)}…`
    : sanitized;

}

// ComposioErrorが動的に保持するstatusCode(SDK公式.d.tsには型として
// 公開されていないが、ComposioError.ts自身がObject.defineProperty()
// でenumerable own propertyとして設定することを確認済み)を、`any`を
// 使わずに安全に読み取るための最小限の型。
interface ComposioErrorWithStatusCode {
  statusCode?: unknown;
}

// error(ComposioError系インスタンス)から、developer/audit診断専用の
// 安全な要約を組み立てる。raw cause objectそのものは一切保持しない
// (causeNameとcauseMessage[sanitize済み]という2つの文字列だけを
// 転記する)。
function buildComposioProviderDetails(
  error: ComposioError,
  knownSecrets: readonly string[] = []
): ComposioProviderDiagnostics {

  const details: ComposioProviderDiagnostics = {
    provider: "composio",
    errorName: error.name,
    providerCode: error.code,
  };

  const statusCode = (error as unknown as ComposioErrorWithStatusCode).statusCode;

  if (typeof statusCode === "number") {
    details.statusCode = statusCode;
  }

  // Error.cause(ES2022、lib "esnext"で型として利用可能)。SDKが
  // 保持しているraw causeオブジェクトそのものはここで止め、
  // name/messageという2つの安全なstring要約だけを取り出す。
  const cause = error.cause;

  if (cause instanceof Error) {
    details.causeName = cause.name;
    details.causeMessage = sanitizeProviderDiagnosticText(cause.message, knownSecrets);
  }

  return details;

}

// Composio公式SDKのエラー階層(@composio/core/src/errors/配下、
// 0.18.1で確認済み)をProvider非依存のIntegrationExecutionErrorへ
// normalizeする。巨大なerror taxonomyは作らず、Phase C1指示Section23
// が明示する程度(connection missing/authentication/invalid action/
// provider execution failed/temporary failure/authorization denied)
// にとどめる。
//
// retryableは常にfalseとする(絶対条件: このSDKバージョンでは
// どのエラーがtransient/networkに起因するかを確信を持って判別できる
// 公式APIが確認できなかったため、安全側に倒す——「たぶん失敗したから
// 再送してよい」という判断を退屈な保守的判定へ倒すのではなく、
// 一切のretryable=trueを主張しない)。
// テスト容易性のためexportする(isTemporaryFailure()等、既存repository
// の一貫した方針と同じ理由——このロジック自体がエラー分類の中核であり、
// 実Composio呼び出し無しに直接検証できるようにする)。
//
// LIVE-1A(Composio Error Cause Observability): knownSecretsは呼び出し
// 元(executeComposio())がこの実行で実際に使ったconnectedAccountId
// 等、既に安全に把握している値を渡す引数(省略可、既存呼び出し元との
// 後方互換のためoptional)。causeMessageの中に万一この値が字面として
// 含まれていても確実に除去する。
export function normalizeComposioError(
  error: unknown,
  knownSecrets: readonly string[] = []
): IntegrationExecutionError {

  if (error instanceof ComposioConnectedAccountNotFoundError) {

    return {
      code: "connection_missing",
      message: error.message,
      retryable: false,
      providerDetails: buildComposioProviderDetails(error, knownSecrets),
    };

  }

  if (error instanceof ComposioSharedAccessDeniedError) {

    return {
      code: "authorization_denied",
      message: error.message,
      retryable: false,
      providerDetails: buildComposioProviderDetails(error, knownSecrets),
    };

  }

  if (
    error instanceof ComposioToolNotFoundError ||
    error instanceof ComposioToolVersionRequiredError
  ) {

    return {
      code: "invalid_action",
      message: error.message,
      retryable: false,
      providerDetails: buildComposioProviderDetails(error, knownSecrets),
    };

  }

  if (error instanceof ComposioToolExecutionError) {

    return {
      code: "provider_execution_failed",
      message: error.message,
      retryable: false,
      providerDetails: buildComposioProviderDetails(error, knownSecrets),
    };

  }

  if (error instanceof ComposioError) {

    // 上記のいずれにも該当しない、その他のComposio SDKエラー
    // (認証エラー・APIからの4xx/5xx等を含む@composio/clientの
    // 例外もComposioErrorへ正規化される、ComposioError.ts確認済み)。
    return {
      code: "provider_execution_failed",
      message: error.message,
      retryable: false,
      providerDetails: buildComposioProviderDetails(error, knownSecrets),
    };

  }

  return {
    code: "provider_execution_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };

}

// Composio公式SDKのtools.execute()戻り値のうち、このAdapterが実際に
// 使うfieldだけの最小型(SDK側の完全な型をここへ再エクスポートしない、
// 既存方針を踏襲)。
interface ComposioToolExecuteResult {

  successful: boolean;

  data?: unknown;

  error?: string | null;

  logId?: string | null;

}

// Architecture Migration Phase C2.2b: tools.execute()のraw結果から
// IntegrationExecutionResultを組み立てる部分だけを、実Composioクライアント
// 構築(client.tools.execute()自体)から独立してテストできるよう切り出す
// (normalizeComposioError()と同じ「テスト容易性のためexportする」既存
// 方針)。list_channelsに限り、raw Composio/Slack response(result.data)
// をmapComposioListChannelsResultToCanonical()でcanonical
// SlackListChannelsResultへ変換してからoutputへ格納する(絶対条件
// Section8: raw provider responseをcanonical domainへそのまま漏らさない)。
// send_message等その他のoperationは既存通りresult.dataをそのまま
// outputへ渡す(write pathの既存result behaviorを不必要に変更しない、
// 絶対条件Section9)。
export function buildExecutionResultFromToolResult(
  action: IntegrationExecutionRequest["action"],
  result: ComposioToolExecuteResult
): IntegrationExecutionResult {

  if (!result.successful) {

    return {
      status: "failed",
      error: {
        code: "provider_execution_failed",
        message: result.error ?? "Composio tool execution reported successful=false",
        retryable: false,
      },
      providerExecutionRef: result.logId ?? null,
    };

  }

  if (action.operation === "list_channels") {

    const canonicalized = mapComposioListChannelsResultToCanonical(result.data);

    if (!canonicalized.ok) {

      return {
        status: "failed",
        error: {
          code: "provider_execution_failed",
          message: canonicalized.reason,
          retryable: false,
        },
        providerExecutionRef: result.logId ?? null,
      };

    }

    return {
      status: "completed",
      providerExecutionRef: result.logId ?? null,
      output: canonicalized.result,
    };

  }

  if (action.service === "gmail" && action.operation === "search_messages") {

    const canonicalized = mapComposioGmailSearchResultToCanonical(result.data);

    if (!canonicalized.ok) {
      return {
        status: "failed",
        error: {
          code: "provider_execution_failed",
          message: canonicalized.reason,
          retryable: false,
        },
        providerExecutionRef: result.logId ?? null,
      };
    }

    return {
      status: "completed",
      providerExecutionRef: result.logId ?? null,
      output: canonicalized.result,
    };

  }

  return {
    status: "completed",
    providerExecutionRef: result.logId ?? null,
    output: result.data,
  };

}

async function executeComposio(
  request: IntegrationExecutionRequest
): Promise<IntegrationExecutionResult> {

  const client = getComposioClient();

  if (!client) {

    return {
      status: "failed",
      error: {
        code: "authentication_error",
        message: "Composio is not configured (COMPOSIO_API_KEY missing)",
        retryable: false,
      },
    };

  }

  if (request.action.service !== "slack" && request.action.service !== "gmail") {

    return {
      status: "failed",
      error: {
        code: "invalid_action",
        message: `Composio Adapterは現時点でservice="slack"のみ対応しています(渡された値: "${request.action.service}")`,
        retryable: false,
      },
    };

  }

  const mapped =
    request.action.service === "slack"
      ? mapSlackActionToComposioTool(request.action)
      : mapGmailActionToComposioTool(request.action);

  if (!mapped.ok) {

    return {
      status: "failed",
      error: {
        code: "invalid_action",
        message: mapped.reason,
        retryable: false,
      },
    };

  }

  const toolkitVersion =
    request.action.service === "slack" ? getSlackToolkitVersion() : getGmailToolkitVersion();

  try {

    // 絶対条件(Section20): 1回だけ呼ぶ。このtry/catchブロックの中で
    // 自ら再試行することは無い。
    const result = await client.tools.execute(mapped.invocation.slug, {
      userId: toComposioUserId(request.userId),
      connectedAccountId: request.providerConnectionRef,
      arguments: mapped.invocation.arguments,
      version: toolkitVersion,
      // "latest"のままmanual executeするとComposioToolVersionRequiredError
      // を投げる公式仕様(Tools.ts確認済み)のため、COMPOSIO_SLACK_
      // TOOLKIT_VERSION未設定時(="latest")はこのflagで明示的に許可する。
      dangerouslySkipVersionCheck: toolkitVersion === "latest",
    });

    return buildExecutionResultFromToolResult(request.action, result);

  } catch (error) {

    // LIVE-1A: この呼び出しで実際に使ったconnectedAccountIdを
    // knownSecretsとして渡す——万一causeMessageの字面に含まれていても
    // 確実に除去する(推測パターンではなくexact stringでの除去)。
    const normalizedError = normalizeComposioError(error, [request.providerConnectionRef]);

    // LIVE-1A(絶対条件、最重要): raw error/raw cause objectそのものは
    // 一切console.errorしない——normalizeComposioError()が既に
    // sanitizeした安全な要約(providerDetails)だけをログへ出す
    // (Vercel log等、audit DBより広い読者へ露出しうる経路のため、
    // 二重にsafe boundaryを守る)。
    if (normalizedError.providerDetails) {
      console.error(
        "[tact-integration/composio] tool execution failed",
        normalizedError.providerDetails
      );
    }

    return {
      status: "failed",
      error: normalizedError,
    };

  }

}

export const composioIntegrationProvider: IntegrationProvider = {
  execute: executeComposio,
};
