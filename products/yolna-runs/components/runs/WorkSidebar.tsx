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
      <label className="mb-3 grid gap-1.5 text-xs font-medium text-runs-text"><span>Workを検索</span><span className="relative"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-runs-muted" /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="名前で検索" className="runs-focus h-9 w-full rounded-lg border border-runs-border bg-runs-surface py-1 pl-8 pr-8 text-xs text-runs-text placeholder:text-runs-muted" />{search && <button type="button" onClick={() => onSearch("")} aria-label="Work検索をクリア" title="Work検索をクリア" className="runs-focus absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-runs-muted hover:bg-runs-hover"><ClearIcon /></button>}</span></label>
      <div className="mb-3 flex flex-wrap gap-1">{(["all", "attention", "activity"] as WorkFilter[]).map((kind) => <button key={kind} type="button" onClick={() => setFilter(kind)} aria-pressed={filter === kind} className={`rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-runs-focus ${filter === kind ? "bg-runs-selected font-semibold text-runs-interactive" : "bg-runs-hover text-runs-text-secondary hover:text-runs-text"}`}>{filterLabel[kind]} {countFor(kind)}</button>)}</div>
      {items.length === 0 ? <PresentationState kind="empty" /> : <div className="border-t border-runs-border-subtle pt-2">{visible.map((item) => <button key={item.workId} type="button" onClick={() => onSelect(item.workId)} aria-current={selectedWorkId === item.workId ? "page" : undefined} className={`w-full border-l-2 px-2 py-2 text-left text-xs outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${selectedWorkId === item.workId ? "border-runs-interactive bg-runs-selected text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover"}`}><span className="block truncate font-medium" title={item.title ?? "名前のないWork"}>{item.title ?? "名前のないWork"}</span>{item.attentionCount > 0 ? <span className="mt-1 block text-xs"><AttentionIndicator label={`要確認 ${item.attentionCount}件`} /></span> : <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-runs-muted"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${item.lastActivity ? "bg-runs-info" : "border border-runs-muted"}`} />{item.lastActivity ? "活動あり" : "活動なし"}</span>}</button>)}</div>}
    </>}
  </SecondarySidebar>;
}
