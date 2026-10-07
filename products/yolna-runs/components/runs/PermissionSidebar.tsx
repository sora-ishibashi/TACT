"use client";

import { useMemo, useState } from "react";
import { ClearIcon, SearchIcon } from "@/components/icons/RunsIcons";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import {
  filterPermissionScopes,
  summarizePermissionScopesByAgent,
  summarizePermissionScopesByService,
  type PermissionScopeView,
} from "@tact/runs-core/tact-runs-view/permissionManagement";
import type { ExecutionProvider } from "@tact/runs-core/tact-execution/types";

type CategoryFilter =
  | { kind: "all" }
  | { kind: "needs_confirmation" }
  | { kind: "agent"; agentId: string | null }
  | { kind: "service"; service: ExecutionProvider | null };

const chipClass = (selected: boolean) => `rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-runs-focus ${selected ? "bg-runs-selected font-semibold text-runs-interactive" : "bg-runs-hover text-runs-text-secondary hover:text-runs-text"}`;

export function PermissionSidebar({ scopes, state, selectedScopeKey, onSelect }: { scopes: PermissionScopeView[]; state: PresentationStateKind | null; selectedScopeKey: string | null; onSelect: (scopeKey: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const agentOptions = useMemo(() => summarizePermissionScopesByAgent(scopes), [scopes]);
  const serviceOptions = useMemo(() => summarizePermissionScopesByService(scopes), [scopes]);
  const needsConfirmationCount = useMemo(() => scopes.filter((scope) => scope.hasConflict).length, [scopes]);
  const visible = useMemo(() => filterPermissionScopes(scopes, { search, needsConfirmationOnly: category.kind === "needs_confirmation", agentId: category.kind === "agent" ? category.agentId : undefined, service: category.kind === "service" ? category.service : undefined }), [scopes, search, category]);

  return <SecondarySidebar title="権限" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <label className="mb-3 grid gap-1.5 text-xs font-medium text-runs-text"><span>権限を検索</span><span className="relative"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-runs-muted" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="AI・サービスで検索" className="runs-focus h-9 w-full rounded-lg border border-runs-border bg-runs-surface py-1 pl-8 pr-8 text-xs text-runs-text placeholder:text-runs-muted" />{search && <button type="button" onClick={() => setSearch("")} aria-label="権限検索をクリア" title="権限検索をクリア" className="runs-focus absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-runs-muted hover:bg-runs-hover"><ClearIcon /></button>}</span></label>
      <div className="mb-3 flex flex-wrap gap-1"><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={chipClass(category.kind === "all")}>すべて {scopes.length}</button><button type="button" onClick={() => setCategory({ kind: "needs_confirmation" })} aria-pressed={category.kind === "needs_confirmation"} className={chipClass(category.kind === "needs_confirmation")}>要確認 {needsConfirmationCount}</button></div>
      {(agentOptions.length > 0 || serviceOptions.length > 0) && <details className="mb-3 border-b border-runs-border-subtle pb-3"><summary className="cursor-pointer text-xs text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">その他の絞り込み</summary>{agentOptions.length > 0 && <div className="mt-2"><p className="mb-1 text-xs font-semibold text-runs-muted">AI</p><div className="flex flex-wrap gap-1">{agentOptions.map((option) => <button key={option.agentId ?? "unspecified"} type="button" onClick={() => setCategory({ kind: "agent", agentId: option.agentId })} aria-pressed={category.kind === "agent" && category.agentId === option.agentId} className={chipClass(category.kind === "agent" && category.agentId === option.agentId)}>{option.label} {option.count}</button>)}</div></div>}{serviceOptions.length > 0 && <div className="mt-3"><p className="mb-1 text-xs font-semibold text-runs-muted">サービス</p><div className="flex flex-wrap gap-1">{serviceOptions.map((option) => <button key={option.service ?? "unspecified"} type="button" onClick={() => setCategory({ kind: "service", service: option.service })} aria-pressed={category.kind === "service" && category.service === option.service} className={chipClass(category.kind === "service" && category.service === option.service)}>{option.label} {option.count}</button>)}</div></div>}</details>}
      {visible.length === 0 ? <PresentationState kind="empty" /> : <div className="flex flex-col">{visible.map((scope) => <button key={scope.scopeKey} type="button" onClick={() => onSelect(scope.scopeKey)} aria-current={selectedScopeKey === scope.scopeKey ? "page" : undefined} className={`border-l-2 px-2 py-2 text-left text-xs outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${selectedScopeKey === scope.scopeKey ? "border-runs-interactive bg-runs-selected text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover"}`}><span className="block truncate font-medium" title={`${scope.agentDisplayLabel} / ${scope.serviceDisplayLabel}`}>{scope.agentDisplayLabel} / {scope.serviceDisplayLabel}</span><span className={`mt-1 block text-xs ${scope.hasConflict ? "text-runs-warning" : ""}`}>{scope.hasConflict ? "要確認あり" : `登録ルール ${scope.registeredRules.length}件`}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
