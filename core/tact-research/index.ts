// =========================
// TACT Research — Public Entry Point (STEP176/180)
// =========================
//
// 依存方向の確認(STEP176絶対条件9): このファイル、および
// core/tact-research/配下のどのファイルも、core/tact-coreを
// 逆方向にimportされていない(core/tact-core側からはこのモジュールへ
// 一切参照が無い)。Legacy Workflow Engine
// (core/workflow・core/agents・core/planner・core/brain・
// core/conversation・core/auth)は一切importしていない。
//
// STEP180: core/llm(低レベル単発実行関数runLLM)・core/evidence・
// core/tools/search・core/tools/pipelineは「CODE/SEARCH/LLMの
// 最小構成」として明示的に再利用している(Legacy Workflowの
// オーケストレーション本体とは区別される、共有インフラ層)。

export * from "./types";
export { runResearch } from "./runResearch";
// Architecture Migration Phase A(Capability Invocation Decoupling):
// core/tact-bootstrap.tsがCapability Registryへ"research"として
// 登録するのは、runResearch()自身ではなくこのAdapter。
export {
  runResearchCapability,
  mapResearchResultToCapabilityResult,
} from "./capabilityAdapter";
