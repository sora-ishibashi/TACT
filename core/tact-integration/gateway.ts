import { composioIntegrationProvider } from "./providers/composio/adapter";
import type {
  IntegrationExecutionRequest,
  IntegrationExecutionResult,
  IntegrationProvider,
} from "./types";

// =========================
// TACT Integration Gateway (Architecture Migration Phase C1)
// =========================
//
// Work/Task/Approval/Bot/Conversationのどの層も、この
// executeIntegrationAction()だけを呼ぶ。Composio(または将来の
// MCP/Pipedream/Merge/Native)への分岐はこのGatewayの内側だけに
// 閉じ込め、呼び出し元へ`if (provider === "composio")`のような分岐
// を一切持ち込ませない(絶対条件、Phase C1指示Section24)。
//
// Phase C1ではProviderがComposioのみのため、Gateway自体もルーティング
// ロジックを持たない単純な委譲(deps.provider.execute()を呼ぶだけ)
// にとどめる——将来複数Providerを持つ段階になった時点で、
// action.service/Connection.providerに基づく選択ロジックをこの
// ファイル内だけに追加すればよい(Work/Task/Approval/Bot/Conversation
// 層への影響ゼロ)。
//
// テスト容易性のため、実際のProvider実装をConstructor/Parameter
// Injectionで差し替え可能にする(既定値はComposio、他の
// core/tact-work/core/tact-integrationモジュールと同じDIパターン)。

export interface IntegrationGatewayDeps {

  provider: IntegrationProvider;

}

const defaultDeps: IntegrationGatewayDeps = {
  provider: composioIntegrationProvider,
};

export async function executeIntegrationAction(
  request: IntegrationExecutionRequest,
  deps: IntegrationGatewayDeps = defaultDeps
): Promise<IntegrationExecutionResult> {

  return deps.provider.execute(request);

}
