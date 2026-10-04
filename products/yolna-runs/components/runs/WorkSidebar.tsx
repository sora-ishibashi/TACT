"use client";
import { useState } from "react";

import { SecondarySidebar } from "@/components/shell/SecondarySidebar";

export type WorkListItem = { workId: string; title: string | null; status: string; lastActivity: string | null; executionCount: number; attentionCount: number };

export function WorkSidebar({ items, selectedWorkId, search, onSearch, onSelect }: { items: WorkListItem[]; selectedWorkId: string | null; search: string; onSearch: (value: string) => void; onSelect: (workId: string) => void }) {
  const [filter, setFilter] = useState<"all" | "attention" | "recent">("all");
  const visible = items.filter((item) => (item.title ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (filter === "all" || filter === "attention" ? item.attentionCount > 0 : item.lastActivity !== null));
  return <SecondarySidebar title="仕事" summary={`表示中 ${visible.length} 件`}>
    <input aria-label="仕事を検索" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="仕事を検索" className="mb-3 h-9 w-full rounded border border-[#D9D9D9] px-2 text-[12px]" />
    <div className="mb-2 flex flex-wrap gap-1 text-[12px]"><button type="button" onClick={() => setFilter("all")} aria-pressed={filter === "all"} className="rounded px-2 py-1 text-[#112278]">すべて ({items.length})</button><button type="button" onClick={() => setFilter("attention")} aria-pressed={filter === "attention"} className="rounded px-2 py-1 text-[#112278]">要確認あり</button><button type="button" onClick={() => setFilter("recent")} aria-pressed={filter === "recent"} className="rounded px-2 py-1 text-[#112278]">最近更新</button></div>
    <div className="flex flex-col gap-1">{visible.map((item) => <button key={item.workId} type="button" onClick={() => onSelect(item.workId)} aria-current={selectedWorkId === item.workId ? "page" : undefined} className={`rounded px-2 py-2 text-left text-[12px] ${selectedWorkId === item.workId ? "bg-[#E6F2F2] text-[#112278]" : "text-[#626161] hover:bg-[#F2F2F2]"}`}><span className="block truncate font-medium">{item.title ?? "記録なし"}</span><span className="mt-1 block text-[11px]">{item.attentionCount > 0 ? `要確認 ${item.attentionCount}件` : item.lastActivity ? "最近更新" : "活動記録なし"}</span></button>)}</div>
  </SecondarySidebar>;
}
