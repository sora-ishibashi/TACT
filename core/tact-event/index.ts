// =========================
// TACT Event — Public Entry Point (EVENT-P1b/P1c)
// =========================
//
// 依存方向: core/tact-event/はcore/tact-work/(ExternalEvent/EventWait型・
// store.tsのCRUD/RPC wrapper・resume.tsのrequestTaskResume())へ依存する。
// EVENT-P1c(resume.ts/flow.ts)からはさらにcore/tact-conversation/
// (executePreparedTaskResume())へも依存する——"existing canonical
// resume seam"の実体がそこにあるための、既存実行境界の再利用に
// すぎない新しい一方向の依存(core/tact-event/resume.tsのfile冒頭
// コメント参照)。いずれの方向についても、core/tact-work/・
// core/tact-conversation/側からcore/tact-eventへの参照は無い。
//
// provider adapter/route(EVENT-P1d以降)がこのbarrelを経由して
// processExternalEventArrival()/beginEventWait()を呼び出す想定——
// core/tact-event自身はHTTP/署名検証/provider固有parsingを一切
// 持たない(EVENT-P1a Architecture Audit Section M)。

export * from "./types";
export * from "./validate";
export * from "./ingest";
// EVENT-P1c: atomic match+claim → 既存canonical resume seam。
export * from "./resume";
export * from "./wait";
export * from "./flow";
