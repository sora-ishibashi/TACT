"use client";

import { useMemo, useState } from "react";
import { ClearIcon, SearchIcon } from "@/components/icons/RunsIcons";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { filterCoverageServiceDetails, summarizeCoverageByClassification, summarizeCoverageByProvider, type CoverageClassification, type CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { ExecutionProvider } from "@tact/runs-core/tact-execution/types";

type CategoryFilter = { kind: "all" } | { kind: "classification"; classification: CoverageClassification } | { kind: "provider"; provider: ExecutionProvider };
const chipClass = (selected: boolean) => `rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-runs-focus ${selected ? "bg-runs-selected font-semibold text-runs-interactive" : "bg-runs-hover text-runs-text-secondary hover:text-runs-text"}`;

export function ConnectionObservationSidebar({ details, state, selectedSurfaceId, onSelect }: { details: CoverageServiceDetailView[]; state: PresentationStateKind | null; selectedSurfaceId: string | null; onSelect: (surfaceId: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const classificationOptions = useMemo(() => summarizeCoverageByClassification(details), [details]);
  const providerOptions = useMemo(() => summarizeCoverageByProvider(details), [details]);
  const visible = useMemo(() => filterCoverageServiceDetails(details, { search, classification: category.kind === "classification" ? category.classification : undefined, provider: category.kind === "provider" ? category.provider : undefined }), [details, search, category]);

  return <SecondarySidebar title="接続・観測" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <label className="mb-3 grid gap-1.5 text-xs font-medium text-runs-text"><span>接続・観測を検索</span><span className="relative"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-runs-muted" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="サービス名で検索" className="runs-focus h-9 w-full rounded-lg border border-runs-border bg-runs-surface py-1 pl-8 pr-8 text-xs text-runs-text placeholder:text-runs-muted" />{search && <button type="button" onClick={() => setSearch("")} aria-label="接続・観測検索をクリア" title="接続・観測検索をクリア" className="runs-focus absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-runs-muted hover:bg-runs-hover"><ClearIcon /></button>}</span></label>
      <div className="mb-3 flex flex-wrap gap-1"><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={chipClass(category.kind === "all")}>すべて {details.length}</button>{classificationOptions.map((option) => <button key={option.id} type="button" onClick={() => setCategory({ kind: "classification", classification: option.id as CoverageClassification })} aria-pressed={category.kind === "classification" && category.classification === option.id} className={chipClass(category.kind === "classification" && category.classification === option.id)}>{option.label} {option.count}</button>)}</div>
      {providerOptions.length > 0 && <details className="mb-3 border-b border-runs-border-subtle pb-3"><summary className="cursor-pointer text-xs text-runs-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-runs-focus">サービスで絞り込む</summary><div className="mt-2 flex flex-wrap gap-1">{providerOptions.map((option) => <button key={option.id} type="button" onClick={() => setCategory({ kind: "provider", provider: option.id as ExecutionProvider })} aria-pressed={category.kind === "provider" && category.provider === option.id} className={chipClass(category.kind === "provider" && category.provider === option.id)}>{option.label} {option.count}</button>)}</div></details>}
      {visible.length === 0 ? <PresentationState kind="empty" /> : <div className="flex flex-col">{visible.map((detail) => <button key={detail.surfaceId} type="button" onClick={() => onSelect(detail.surfaceId)} aria-current={selectedSurfaceId === detail.surfaceId ? "page" : undefined} className={`border-l-2 px-2 py-2 text-left text-xs outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${selectedSurfaceId === detail.surfaceId ? "border-runs-interactive bg-runs-selected text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover"}`}><span className="block truncate font-medium" title={detail.source}>{detail.source}</span><span className={`mt-0.5 block text-xs font-normal ${detail.classification === "PARTIAL" ? "text-runs-warning" : detail.classification === "OUTAGE" ? "text-runs-danger" : "text-runs-muted"}`}>{detail.classificationLabel}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
