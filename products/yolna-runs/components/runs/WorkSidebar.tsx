"use client";

import { useMemo, useState } from "react";
import { ClearIcon, SearchIcon } from "@/components/icons/RunsIcons";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { AttentionIndicator } from "./StatusIndicator";

export type WorkListItem = { workId: string; title: string | null; status: string; lastActivity: string | null; executionCount: number; attentionCount: number };
type WorkFilter = "all" | "attention" | "activity";
const filterLabel: Record<WorkFilter, string> = { all: "すべて", attention: "要確認", activity: "活動あり" };

export function WorkSidebar({ items, state, selectedWorkId, search, onSearch, onSelect }: { items: WorkListItem[]; state: PresentationStateKind | null; selectedWorkId: string | null; search: string; onSearch: (value: string) => void; onSelect: (workId: string) => void }) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const visible = useMemo(() => items.filter((item) => { const matchesSearch = (item.title ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase()); return matchesSearch && (filter === "all" || filter === "attention" ? item.attentionCount > 0 || filter === "all" : item.lastActivity !== null); }), [filter, items, search]);
  const countFor = (kind: WorkFilter) => kind === "all" ? items.length : kind === "attention" ? items.filter((item) => item.attentionCount > 0).length : items.filter((item) => item.lastActivity !== null).length;

  return <SecondarySidebar title="Work" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <div className="relative mb-3"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-[#8A8A8A]" /><input aria-label="Workを検索" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="検索" className="h-9 w-full rounded-lg border border-[#D9D9D9] py-1 pl-8 pr-8 text-[12px] text-[#171717] outline-none focus-visible:border-[#18B5A6] focus-visible:ring-1 focus-visible:ring-[#18B5A6]" />{search && <button type="button" onClick={() => onSearch("")} aria-label="Work検索をクリア" title="Work検索をクリア" className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-[#8A8A8A] outline-none hover:bg-[#F2F2F2] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><ClearIcon /></button>}</div>
      <div className="mb-3 flex flex-wrap gap-1">{(["all", "attention", "activity"] as WorkFilter[]).map((kind) => <button key={kind} type="button" onClick={() => setFilter(kind)} aria-pressed={filter === kind} className={`rounded-full px-2.5 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6] ${filter === kind ? "bg-[#E6F2F2] font-semibold text-[#172E95]" : "bg-[#F7F7F7] text-[#626161] hover:text-[#171717]"}`}>{filterLabel[kind]} {countFor(kind)}</button>)}</div>
      {items.length === 0 ? <PresentationState kind="empty" /> : <div className="border-t border-[#E5E5E5] pt-2">{visible.map((item) => <button key={item.workId} type="button" onClick={() => onSelect(item.workId)} aria-current={selectedWorkId === item.workId ? "page" : undefined} className={`w-full border-l-2 px-2 py-2 text-left text-[12px] outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6] ${selectedWorkId === item.workId ? "border-[#172E95] bg-[#E6F2F2] text-[#171717]" : "border-transparent text-[#626161] hover:bg-[#F7F7F7]"}`}><span className="block truncate font-medium">{item.title ?? "名前のないWork"}</span>{item.attentionCount > 0 ? <span className="mt-1 block text-[11px]"><AttentionIndicator label={`要確認 ${item.attentionCount}件`} /></span> : <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-[#8A8A8A]"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${item.lastActivity ? "bg-[#64748B]" : "border border-[#8A8A8A]"}`} />{item.lastActivity ? "活動あり" : "活動なし"}</span>}</button>)}</div>}
    </>}
  </SecondarySidebar>;
}
