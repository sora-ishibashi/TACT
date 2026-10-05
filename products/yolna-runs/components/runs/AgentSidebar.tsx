"use client";

import { useMemo, useState } from "react";
import { ClearIcon, SearchIcon } from "@/components/icons/RunsIcons";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import {
  filterAgentManagementItems,
  summarizeAgentManagementByTargetSystem,
  summarizeAgentManagementEvidence,
  type AgentIdentityEvidence,
  type AgentManagementItemView,
} from "@tact/runs-core/tact-runs-view/agentManagement";

type CategoryFilter =
  | { kind: "all" }
  | { kind: "evidence"; evidence: AgentIdentityEvidence }
  | { kind: "target_system"; label: string };

function evidenceJapanese(evidence: AgentIdentityEvidence): string {
  switch (evidence) {
    case "execution_observed": return "実行記録あり";
    case "permission_scoped": return "権限設定あり";
  }
}

function formatLastActivity(value: string | null): string {
  if (!value) return "実行記録がありません";
  try { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return value; }
}

const chipClass = (selected: boolean) => `rounded-full px-2.5 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6] ${selected ? "bg-[#E6F2F2] font-semibold text-[#172E95]" : "bg-[#F7F7F7] text-[#626161] hover:text-[#171717]"}`;

export function AgentSidebar({ items, state, selectedAgentId, onSelect }: { items: AgentManagementItemView[]; state: PresentationStateKind | null; selectedAgentId: string | null; onSelect: (agentId: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const targetSystemOptions = useMemo(() => summarizeAgentManagementByTargetSystem(items), [items]);
  const evidenceSummary = useMemo(() => summarizeAgentManagementEvidence(items), [items]);
  const visible = useMemo(() => filterAgentManagementItems(items, { search, evidence: category.kind === "evidence" ? category.evidence : undefined, targetSystemLabel: category.kind === "target_system" ? category.label : undefined }), [items, search, category]);

  return <SecondarySidebar title="AI" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <div className="relative mb-3"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-[#8A8A8A]" /><input aria-label="AI識別子を検索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="AI識別子で検索" className="h-9 w-full rounded-lg border border-[#D9D9D9] py-1 pl-8 pr-8 text-[12px] text-[#171717] outline-none focus-visible:border-[#18B5A6] focus-visible:ring-1 focus-visible:ring-[#18B5A6]" />{search && <button type="button" onClick={() => setSearch("")} aria-label="AI検索をクリア" title="AI検索をクリア" className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-[#8A8A8A] outline-none hover:bg-[#F2F2F2] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><ClearIcon /></button>}</div>
      <div className="mb-3 flex flex-wrap gap-1"><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={chipClass(category.kind === "all")}>すべて {items.length}</button><button type="button" onClick={() => setCategory({ kind: "evidence", evidence: "execution_observed" })} aria-pressed={category.kind === "evidence" && category.evidence === "execution_observed"} className={chipClass(category.kind === "evidence" && category.evidence === "execution_observed")}>実行あり {evidenceSummary.executionObservedCount}</button><button type="button" onClick={() => setCategory({ kind: "evidence", evidence: "permission_scoped" })} aria-pressed={category.kind === "evidence" && category.evidence === "permission_scoped"} className={chipClass(category.kind === "evidence" && category.evidence === "permission_scoped")}>権限あり {evidenceSummary.permissionScopedCount}</button></div>
      {targetSystemOptions.length > 0 && <details className="mb-3 border-b border-[#E5E5E5] pb-3"><summary className="cursor-pointer text-[11px] text-[#626161] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6]">サービスで絞り込む</summary><div className="mt-2 flex flex-wrap gap-1">{targetSystemOptions.map((option) => <button key={option.label} type="button" onClick={() => setCategory({ kind: "target_system", label: option.label })} aria-pressed={category.kind === "target_system" && category.label === option.label} className={chipClass(category.kind === "target_system" && category.label === option.label)}>{option.label} {option.count}</button>)}</div></details>}
      {visible.length === 0 ? <PresentationState kind="empty">AIとして識別できる実行記録・権限設定はまだありません。</PresentationState> : <div className="flex flex-col">{visible.map((item) => <button key={item.agentId} type="button" onClick={() => onSelect(item.agentId)} aria-current={selectedAgentId === item.agentId ? "page" : undefined} className={`border-l-2 px-2 py-2 text-left text-[12px] outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6] ${selectedAgentId === item.agentId ? "border-[#172E95] bg-[#E6F2F2] text-[#171717]" : "border-transparent text-[#626161] hover:bg-[#F7F7F7]"}`}><span className="block truncate font-medium">{item.agentId}</span><span className="mt-1 block text-[11px]">{item.identityEvidence.map(evidenceJapanese).join(" / ")}{item.activeAttentionCount > 0 ? ` · 要確認 ${item.activeAttentionCount}件` : ""}</span><span className="mt-0.5 block text-[11px] text-[#8A8A8A]">{formatLastActivity(item.lastActivityAt)}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
