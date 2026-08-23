// =========================
// TACT Design — Public Entry Point (STEP178)
// =========================
//
// 依存方向の確認(STEP178絶対条件): このファイル、および
// core/tact-design/配下のどのファイルも、core/tact-coreを逆方向に
// importされていない(core/tact-core側からはこのモジュールへ一切
// 参照が無い)。Legacy Workflow Engine
// (core/workflow・core/agents・core/planner・core/brain・core/llm・
// core/evidence・core/conversation・core/auth)も一切importしていない。
// core/tact-research/index.tsと同じ構成。

export * from "./types";
export { runDesign } from "./runDesign";
