"use client";

// =========================
// SettingsSection (PRODUCT-P1: Connection UX)
// =========================
//
// TACT Settings画面のトップレベル。PRODUCT-P1時点ではConnections
// (Gmail/Slack)だけを持つ(絶対条件: Notion/Drive/Calendar等へは
// 今回拡張しない)。将来の設定項目(通知設定等)を追加する場合も、
// この下へsection単位で増やせる構造にしておく——CoreSection/
// CodeSectionと同じ「1つのTactSection = 1つのtop-level component」
// という既存構造にそのまま従う。

import ConnectionsPanel from "./connections/ConnectionsPanel";

export default function SettingsSection() {

  return (

    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5">

      <h1 className="text-[24px] font-medium leading-[32px] text-[#112278]">設定</h1>

      <div className="mt-6 max-w-xl">
        <ConnectionsPanel />
      </div>

    </div>

  );

}
