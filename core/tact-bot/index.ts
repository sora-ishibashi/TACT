// =========================
// TACT Bot — Public Entry Point (BOT-P1 / BOT-P2)
// =========================
//
// core/tact-bot/配下の型・関数を一括で参照できるようにする入口
// (core/tact-context-source/index.ts・core/tact-research/index.ts等、
// 既存core/tact-*モジュールのbarrel export patternをそのまま踏襲)。
//
// 依存方向の確認(BOT-P1絶対条件): core/tact-bot/配下のどのファイルも、
// core/workflow・core/agents・core/planner・core/conversation
// (Legacy/Frozen)を一切importしない。
//
// BOT-P2で追加したserver専用実装(identity/supabaseIdentityStore.ts・
// identity/supabaseIdentityResolver.ts・conversationLink/
// supabaseConversationLinkStore.ts・connector/conversationConnector.ts)
// は、意図的にこのbarrelへ含めない
// (core/tact-context-source/index.tsがBrowser固有のbrowserAdapter.ts/
// handleStore.tsを意図的に除外している設計判断と同じ理由——これらは
// core/database/supabaseServiceRole.ts(@supabase/supabase-js)や
// core/tact-conversation(Orchestrator/Research/Artifact一式)へ依存する
// server専用codeであり、この汎用barrelを将来client側から安全に
// importできる状態を保つため)。利用する場合は、server専用の呼び出し元
// (将来のBot webhook route等)から個別pathで直接importすること。

export * from "./types";
export * from "./adapters/types";
export * from "./identity/resolver";
export * from "./context/buildBotContext";
export * from "./connector/types";
export * from "./connector/notConnectedConnector";
export * from "./gateway/receiveMessage";
export * from "./gateway/executeBotActions";
