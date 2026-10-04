"use client";

import { useMemo, useState } from "react";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";

export type WorkListItem = { workId: string; title: string | null; status: string; lastActivity: string | null; executionCount: number; attentionCount: number };
type WorkFilter = "all" | "attention" | "activity";

export function WorkSidebar({ items, state, selectedWorkId, search, onSearch, onSelect }: { items: WorkListItem[]; state: PresentationStateKind | null; selectedWorkId: string | null; search: string; onSearch: (value: string) => void; onSelect: (workId: string) => void }) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const visible = useMemo(() => items.filter((item) => {
    const matchesSearch = (item.title ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase());
    if (!matchesSearch) return false;
    if (filter === "attention") return item.attentionCount > 0;
    if (filter === "activity") return item.lastActivity !== null;
    return true;
  }), [filter, items, search]);

  return <SecondarySidebar title="仕事" summary={state ? undefined : `表示中 ${visible.length} 件`}>
    {state ? <PresentationState kind={state} /> : <>
      <input aria-label="仕事を検索" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="仕事を検索" className="mb-3 h-9 w-full rounded border border-[#D9D9D9] px-2 text-[12px]" />
      <div className="mb-2 flex flex-wrap gap-1 text-[12px]">
        <button type="button" onClick={() => setFilter("all")} aria-pressed={filter === "all"} className="rounded px-2 py-1 text-[#112278]">すべて ({items.length})</button>
        <button type="button" onClick={() => setFilter("attention")} aria-pressed={filter === "attention"} className="rounded px-2 py-1 text-[#112278]">要確認あり</button>
        <button type="button" onClick={() => setFilter("activity")} aria-pressed={filter === "activity"} className="rounded px-2 py-1 text-[#112278]">活動記録あり</button>
      </div>
      {items.length === 0 ? <PresentationState kind="empty" /> : <div className="flex flex-col gap-1">{visible.map((item) => <button key={item.workId} type="button" onClick={() => onSelect(item.workId)} aria-current={selectedWorkId === item.workId ? "page" : undefined} className={`rounded px-2 py-2 text-left text-[12px] ${selectedWorkId === item.workId ? "bg-[#E6F2F2] text-[#112278]" : "text-[#626161] hover:bg-[#F2F2F2]"}`}><span className="block truncate font-medium">{item.title ?? "記録なし"}</span><span className="mt-1 block text-[11px]">{item.attentionCount > 0 ? `要確認 ${item.attentionCount}件` : item.lastActivity ? "活動記録あり" : "活動記録なし"}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
