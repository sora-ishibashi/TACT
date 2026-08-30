// =========================
// TACT Bot — Core Connector Boundary (BOT-P1)
// =========================
//
// TACT Core / Orchestratorへの接続点(typed boundary)。
//
// BOT-P1で実Orchestrator接続を行わない理由(投資調査結果): 既存の
// Canonical Conversation経路(core/tact-conversation/orchestration.ts
// のrunConversationOrchestration())は、Conversation永続化
// (tact_conversations/tact_conversation_messages)にSupabase RLSを
// 効かせるため、認証済みuserのaccess token(core/auth/
// getAuthenticatedUser.tsが検証するSupabase Auth JWT)を要求する。
// 一方Bot側は現時点でexternalUserId⇄tactUserIdの永続的な
// identity mappingを持たず(identity/resolver.ts参照)、Slack/LINE
// event起点でそのようなaccess tokenを得る手段も無い。これを無理に
// 繋ぐには、新しいDB table(identity mapping)またはservice-level
// 認証経路の新設が必要になり、「既存の中核Workflow/API/DBを大きく
// 変更する必要がある場合は、無理に変更せずtyped boundaryで止める」
// という方針に該当するため、BOT-P1ではこのinterfaceの定義までに
// 留める。
//
// なお core/tact-orchestrator/commander.tsのrunOrchestration()自体は
// (OrchestrationRequest.userIdがoptionalであり、実装内部で使う
// createSupabaseCoreCapability()もSupabase Auth JWTを要求しない
// ため)技術的にはaccess token無しで呼び出し可能だが、その経路は
// Conversation永続化・Artifact Mutation・Clarification再実行等
// (core/tact-conversation側の責務)を経由しない「素のOrchestrator
// 実行」に留まる。BOT-P2で「Conversation経由で繋ぐか、Orchestrator
// 直結にするか」を、identity mapping設計と合わせて決定する
// (詳細はcore/tact-bot/README.md参照)。
//
// BotCoreConnector自体はタスク分解・Product選択・Research/Design判断
// 等を一切行わない(絶対条件)。BotContextを受け取り、Coreへ委譲し、
// 結果をBotAction[]へ変換して返すだけの境界。

import type { BotAction, BotContext } from "../types";

export interface BotCoreConnector {

  handle(context: BotContext): Promise<BotAction[]>;

}
