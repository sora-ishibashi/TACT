// =========================
// TACT Integration — Public Entry Point
// (Architecture Migration Phase C1: Integration Gateway Foundation +
// Composio Adapter)
// =========================
//
// 依存方向: core/tact-integration/はcore/tact-work(Approval/Run/Task/
// Work store、Phase B1〜B3で確立済み)へ依存する(execution.ts・
// propose.ts)。core/tact-work側からcore/tact-integrationへの参照は
// 一切無い(一方向依存)。
//
// core/tact-integration/providers/composio/配下だけが@composio/core
// をimportする(絶対条件、Section5)。このbarrel自体もComposio SDKの
// 型を再exportしない——呼び出し元が知るのはこのファイルが公開する
// Provider非依存の型(IntegrationAction/IntegrationExecutionRequest/
// Result/Connection等)だけ。
//
// Bot/Web/Conversation層は、このモジュールの
// executeIntegrationAction()/executeApprovedIntegrationAction()/
// proposeIntegrationAction()/Connection CRUDだけを呼ぶ想定であり、
// core/tact-integration/providers/composio/配下を直接importしては
// ならない。

export * from "./types";
export * from "./connection";
export * from "./gateway";
export * from "./propose";
export * from "./execution";
// Architecture Migration Phase C2.1b: Capability Registry(core/tact-core/
// capabilities/registry.ts)へ登録する"integration.slack.send_message"
// capability本体。core/tact-bootstrap.tsだけがこのexportを使う想定
// (research/designと同じ配線パターン)。
export * from "./capability";
