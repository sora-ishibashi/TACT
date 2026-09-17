// =========================
// TACT Event — Public Entry Point (EVENT-P1b)
// =========================
//
// 依存方向: core/tact-event/はcore/tact-work/(ExternalEvent型・
// createExternalEvent()/findExternalEventBySourceAndExternalId())へ
// 依存する。core/tact-work側からcore/tact-eventへの参照は無い
// (一方向依存)。provider adapter/route(EVENT-P1d以降)がこの
// barrelを経由してingestExternalEvent()を呼び出す想定——
// core/tact-event自身はHTTP/署名検証/provider固有parsingを一切
// 持たない(EVENT-P1a Architecture Audit Section M)。

export * from "./types";
export * from "./validate";
export * from "./ingest";
