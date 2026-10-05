"use client";

import { useMemo, useState } from "react";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { AttentionIndicator } from "./StatusIndicator";

export type WorkListItem = { workId: string; title: string | null; status: string; lastActivity: string | null; executionCount: number; attentionCount: number };
type WorkFilter = "all" | "attention" | "activity";
const filterLabel: Record<WorkFilter, string> = { all: "すべて", attention: "要確認あり", activity: "活動あり" };

export function WorkSidebar({ items, state, selectedWorkId, search, onSearch, onSelect }: { items: WorkListItem[]; state: PresentationStateKind | null; selectedWorkId: string | null; search: string; onSearch: (value: string) => void; onSelect: (workId: string) => void }) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const visible = useMemo(() => items.filter((item) => { const matchesSearch = (item.title ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase()); return matchesSearch && (filter === "all" || filter === "attention" ? item.attentionCount > 0 || filter === "all" : item.lastActivity !== null); }), [filter, items, search]);
  const countFor = (kind: WorkFilter) => kind === "all" ? items.length : kind === "attention" ? items.filter((item) => item.attentionCount > 0).length : items.filter((item) => item.lastActivity !== null).length;
  return <SecondarySidebar title="仕事" summary={state ? undefined : `表示中 ${visible.length} 件`}>{state ? <PresentationState kind={state} /> : <><input aria-label="仕事を検索" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="検索" className="mb-4 h-8 w-full rounded border border-[#D9D9D9] px-2 text-[12px]" /><p className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-[#8A8A8A]">表示</p><div className="mb-4">{(["all", "attention", "activity"] as WorkFilter[]).map((kind) => <button key={kind} type="button" onClick={() => setFilter(kind)} aria-pressed={filter === kind} className={`w-full rounded px-2 py-1.5 text-left text-[12px] ${filter === kind ? "bg-[#F2F4FB] font-semibold text-[#171717]" : "text-[#626161] hover:bg-[#F7F7F7]"}`}>{filterLabel[kind]}<span className="float-right tabular-nums">{countFor(kind)}</span></button>)}</div>{items.length === 0 ? <PresentationState kind="empty" /> : <div className="border-t border-[#E5E5E5] pt-3">{visible.map((item) => <button key={item.workId} type="button" onClick={() => onSelect(item.workId)} aria-current={selectedWorkId === item.workId ? "page" : undefined} className={`w-full rounded px-2 py-2 text-left text-[12px] ${selectedWorkId === item.workId ? "bg-[#F2F4FB] text-[#171717]" : "text-[#626161] hover:bg-[#F7F7F7]"}`}><span className="block truncate font-medium">{item.title ?? "名前のない仕事"}</span>{item.attentionCount > 0 ? <span className="mt-1 block text-[11px]"><AttentionIndicator label={`要確認 ${item.attentionCount} 件`} /></span> : <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-[#8A8A8A]"><span aria-hidden="true">{item.lastActivity ? "◦" : "○"}</span>{item.lastActivity ? "活動あり" : "活動なし"}</span>}</button>)}</div>}</>}</SecondarySidebar>;
}
