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

const chipClass = (selected: boolean) => `rounded-full px-2.5 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6] ${selected ? "bg-[#E6F2F2] font-semibold text-[#172E95]" : "bg-[#F7F7F7] text-[#626161] hover:text-[#171717]"}`;

export function PermissionSidebar({ scopes, state, selectedScopeKey, onSelect }: { scopes: PermissionScopeView[]; state: PresentationStateKind | null; selectedScopeKey: string | null; onSelect: (scopeKey: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const agentOptions = useMemo(() => summarizePermissionScopesByAgent(scopes), [scopes]);
  const serviceOptions = useMemo(() => summarizePermissionScopesByService(scopes), [scopes]);
  const needsConfirmationCount = useMemo(() => scopes.filter((scope) => scope.hasConflict).length, [scopes]);
  const visible = useMemo(() => filterPermissionScopes(scopes, { search, needsConfirmationOnly: category.kind === "needs_confirmation", agentId: category.kind === "agent" ? category.agentId : undefined, service: category.kind === "service" ? category.service : undefined }), [scopes, search, category]);

  return <SecondarySidebar title="権限" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <div className="relative mb-3"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-[#8A8A8A]" /><input aria-label="権限を検索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="AI・サービスで検索" className="h-9 w-full rounded-lg border border-[#D9D9D9] py-1 pl-8 pr-8 text-[12px] text-[#171717] outline-none focus-visible:border-[#18B5A6] focus-visible:ring-1 focus-visible:ring-[#18B5A6]" />{search && <button type="button" onClick={() => setSearch("")} aria-label="権限検索をクリア" title="権限検索をクリア" className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-[#8A8A8A] outline-none hover:bg-[#F2F2F2] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><ClearIcon /></button>}</div>
      <div className="mb-3 flex flex-wrap gap-1"><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={chipClass(category.kind === "all")}>すべて {scopes.length}</button><button type="button" onClick={() => setCategory({ kind: "needs_confirmation" })} aria-pressed={category.kind === "needs_confirmation"} className={chipClass(category.kind === "needs_confirmation")}>要確認 {needsConfirmationCount}</button></div>
      {(agentOptions.length > 0 || serviceOptions.length > 0) && <details className="mb-3 border-b border-[#E5E5E5] pb-3"><summary className="cursor-pointer text-[11px] text-[#626161] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6]">その他の絞り込み</summary>{agentOptions.length > 0 && <div className="mt-2"><p className="mb-1 text-[10px] font-semibold text-[#8A8A8A]">AI</p><div className="flex flex-wrap gap-1">{agentOptions.map((option) => <button key={option.agentId ?? "unspecified"} type="button" onClick={() => setCategory({ kind: "agent", agentId: option.agentId })} aria-pressed={category.kind === "agent" && category.agentId === option.agentId} className={chipClass(category.kind === "agent" && category.agentId === option.agentId)}>{option.label} {option.count}</button>)}</div></div>}{serviceOptions.length > 0 && <div className="mt-3"><p className="mb-1 text-[10px] font-semibold text-[#8A8A8A]">サービス</p><div className="flex flex-wrap gap-1">{serviceOptions.map((option) => <button key={option.service ?? "unspecified"} type="button" onClick={() => setCategory({ kind: "service", service: option.service })} aria-pressed={category.kind === "service" && category.service === option.service} className={chipClass(category.kind === "service" && category.service === option.service)}>{option.label} {option.count}</button>)}</div></div>}</details>}
      {visible.length === 0 ? <PresentationState kind="empty" /> : <div className="flex flex-col">{visible.map((scope) => <button key={scope.scopeKey} type="button" onClick={() => onSelect(scope.scopeKey)} aria-current={selectedScopeKey === scope.scopeKey ? "page" : undefined} className={`border-l-2 px-2 py-2 text-left text-[12px] outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6] ${selectedScopeKey === scope.scopeKey ? "border-[#172E95] bg-[#E6F2F2] text-[#171717]" : "border-transparent text-[#626161] hover:bg-[#F7F7F7]"}`}><span className="block truncate font-medium">{scope.agentDisplayLabel} / {scope.serviceDisplayLabel}</span><span className={`mt-1 block text-[11px] ${scope.hasConflict ? "text-[#B7791F]" : ""}`}>{scope.hasConflict ? "要確認あり" : `登録ルール ${scope.registeredRules.length}件`}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
