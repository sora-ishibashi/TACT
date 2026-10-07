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

const chipClass = (selected: boolean) => `rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-runs-focus ${selected ? "bg-runs-selected font-semibold text-runs-interactive" : "bg-runs-hover text-runs-text-secondary hover:text-runs-text"}`;

export function AgentSidebar({ items, state, selectedAgentId, onSelect }: { items: AgentManagementItemView[]; state: PresentationStateKind | null; selectedAgentId: string | null; onSelect: (agentId: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const targetSystemOptions = useMemo(() => summarizeAgentManagementByTargetSystem(items), [items]);
  const evidenceSummary = useMemo(() => summarizeAgentManagementEvidence(items), [items]);
  const visible = useMemo(() => filterAgentManagementItems(items, { search, evidence: category.kind === "evidence" ? category.evidence : undefined, targetSystemLabel: category.kind === "target_system" ? category.label : undefined }), [items, search, category]);

  return <SecondarySidebar title="AI" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <label className="mb-3 grid gap-1.5 text-xs font-medium text-runs-text"><span>AI識別子を検索</span><span className="relative"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-runs-muted" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="AI識別子で検索" className="runs-focus h-9 w-full rounded-lg border border-runs-border bg-runs-surface py-1 pl-8 pr-8 text-xs text-runs-text placeholder:text-runs-muted" />{search && <button type="button" onClick={() => setSearch("")} aria-label="AI検索をクリア" title="AI検索をクリア" className="runs-focus absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-runs-muted hover:bg-runs-hover"><ClearIcon /></button>}</span></label>
      <div className="mb-3 flex flex-wrap gap-1"><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={chipClass(category.kind === "all")}>すべて {items.length}</button><button type="button" onClick={() => setCategory({ kind: "evidence", evidence: "execution_observed" })} aria-pressed={category.kind === "evidence" && category.evidence === "execution_observed"} className={chipClass(category.kind === "evidence" && category.evidence === "execution_observed")}>実行あり {evidenceSummary.executionObservedCount}</button><button type="button" onClick={() => setCategory({ kind: "evidence", evidence: "permission_scoped" })} aria-pressed={category.kind === "evidence" && category.evidence === "permission_scoped"} className={chipClass(category.kind === "evidence" && category.evidence === "permission_scoped")}>権限あり {evidenceSummary.permissionScopedCount}</button></div>
      {targetSystemOptions.length > 0 && <details className="mb-3 border-b border-runs-border-subtle pb-3"><summary className="cursor-pointer text-xs text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">サービスで絞り込む</summary><div className="mt-2 flex flex-wrap gap-1">{targetSystemOptions.map((option) => <button key={option.label} type="button" onClick={() => setCategory({ kind: "target_system", label: option.label })} aria-pressed={category.kind === "target_system" && category.label === option.label} className={chipClass(category.kind === "target_system" && category.label === option.label)}>{option.label} {option.count}</button>)}</div></details>}
      {visible.length === 0 ? <PresentationState kind="empty">AIとして識別できる実行記録・権限設定はまだありません。</PresentationState> : <div className="flex flex-col">{visible.map((item) => <button key={item.agentId} type="button" onClick={() => onSelect(item.agentId)} aria-current={selectedAgentId === item.agentId ? "page" : undefined} className={`border-l-2 px-2 py-2 text-left text-xs outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${selectedAgentId === item.agentId ? "border-runs-interactive bg-runs-selected text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover"}`}><span className="block truncate font-medium" title={item.agentId}>{item.agentId}</span><span className="mt-1 block text-xs">{item.identityEvidence.map(evidenceJapanese).join(" / ")}{item.activeAttentionCount > 0 ? ` · 要確認 ${item.activeAttentionCount}件` : ""}</span><span className="mt-0.5 block text-xs text-runs-muted">{formatLastActivity(item.lastActivityAt)}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
