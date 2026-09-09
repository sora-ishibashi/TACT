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
export function normalizeComposioError(error: unknown): IntegrationExecutionError {

  if (error instanceof ComposioConnectedAccountNotFoundError) {

    return {
      code: "connection_missing",
      message: error.message,
      retryable: false,
      providerDetails: { name: error.name, code: error.code },
    };

  }

  if (error instanceof ComposioSharedAccessDeniedError) {

    return {
      code: "authorization_denied",
      message: error.message,
      retryable: false,
      providerDetails: { name: error.name, code: error.code },
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
      providerDetails: { name: error.name, code: error.code },
    };

  }

  if (error instanceof ComposioToolExecutionError) {

    return {
      code: "provider_execution_failed",
      message: error.message,
      retryable: false,
      providerDetails: { name: error.name, code: error.code },
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
      providerDetails: { name: error.name, code: error.code },
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

    return {
      status: "failed",
      error: normalizeComposioError(error),
    };

  }

}

export const composioIntegrationProvider: IntegrationProvider = {
  execute: executeComposio,
};
