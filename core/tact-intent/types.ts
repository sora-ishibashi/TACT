// =========================
// TACT Intent 型定義 (STEP216)
// =========================
//
// TACTの新しい入口に置く「交通整理」レイヤーの型。新TACT UI
// (components/tact/*)への入力1件ごとに、どの既存経路
// (chat / research / core_push)へ渡すべきかを表す。
//
// 拡張性(STEP216絶対条件): 将来meeting/code/bot/design等の意図が
// 増えることを想定し、Unionへ値を追加するだけで拡張できる形にする。
// 現時点ではSTEP215のMenuBar.tsxのTactSection("research"|"core")とは
// 別の概念(UIのタブ選択 vs 1メッセージごとの意図判定)であり、混同しない。
export type TactIntent = "chat" | "research" | "core_push";

// STEP212のDirect Push契約(type: "knowledge"|"memory"|"example")と
// 同じ型をここでも再利用する。Intent Routerがcore_pushと判定した際、
// どのtypeでPushするかを併せて持たせるための最小限のフィールド。
export type CorePushType = "knowledge" | "memory" | "example";

export interface IntentDecision {
  intent: TactIntent;

  // core_pushの場合のみ意味を持つ。Rule Routerは自然文からtypeを
  // 精密に判別しない(STEP216スコープ外の「自動分類」に踏み込まない
  // ため)。既定は"memory"固定(理由はruleRouter.ts内のコメント参照)。
  corePushType?: CorePushType;

  // デバッグ・テストの根拠表示用。UI表示や判定ロジックには使わない。
  reason: string;
}
