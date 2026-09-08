// =========================
// TACT Runtime — Public Entry Point
// (Fast Port P5a: Provider-Neutral Runtime Adapter Foundation)
// =========================
//
// 依存方向: core/tact-runtime/はどこにも依存しない(型定義のみ、
// import文自体が空であることが構造的な証拠——core/tact-work/・
// core/tact-integration/・core/tact-orchestrator/のいずれからも
// importしない)。逆に、P5b以降でこのモジュールをimportするのは
// core/tact-integration/(将来のRuntime経由execution)側になる想定
// (一方向依存、他のtact-*モジュールと同じパターン)。
//
// P5a時点でこのbarrelをimportする本番コードは存在しない
// (tests/tact/runtime/配下のtestからのみ参照される、意図的な
// unused foundation)。
export * from "./types";
