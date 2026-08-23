// =========================
// TACT Core — Public Entry Point (STEP175/176/177)
// =========================
//
// core/tact-core/配下の型・境界を一括で参照できるようにする入口。
// STEP175時点ではDB接続を持つ実装は提供しない
// (mockCoreCapability.tsのみ、in-memoryの型契約確認用)。
// STEP176でcapabilities/registry.ts(名前ベースの能力呼び出し境界)を
// 追加した。STEP177でKnowledge/Example/Memoryの取得契約(scope/query/
// limit)を強化したが、公開エントリーポイントの構成自体は変更していない。
//
// 依存方向の確認(STEP175絶対条件10、STEP176絶対条件9): このファイル、
// および core/tact-core/配下のどのファイルも、core/workflow・
// core/agents・core/planner・core/brain・core/llm・core/evidence・
// core/context・core/conversation・core/auth・core/tact-research
// (STEP176で新設)を一切importしていない(Legacy Workflow Engine・
// 個々の能力実装への依存を作らないことをコード上でも保証する)。

export * from "./types";
export * from "./context/types";
export * from "./users/types";
export * from "./projects/types";
export * from "./memory/types";
export * from "./knowledge/types";
export * from "./execution/types";
export { createMockCoreCapability } from "./mockCoreCapability";
export * from "./capabilities/registry";
