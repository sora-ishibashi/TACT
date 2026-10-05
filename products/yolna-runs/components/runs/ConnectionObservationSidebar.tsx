"use client";

import { useMemo, useState } from "react";
import { ClearIcon, SearchIcon } from "@/components/icons/RunsIcons";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { filterCoverageServiceDetails, summarizeCoverageByClassification, summarizeCoverageByProvider, type CoverageClassification, type CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { ExecutionProvider } from "@tact/runs-core/tact-execution/types";

type CategoryFilter = { kind: "all" } | { kind: "classification"; classification: CoverageClassification } | { kind: "provider"; provider: ExecutionProvider };
const chipClass = (selected: boolean) => `rounded-full px-2.5 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6] ${selected ? "bg-[#E6F2F2] font-semibold text-[#172E95]" : "bg-[#F7F7F7] text-[#626161] hover:text-[#171717]"}`;

export function ConnectionObservationSidebar({ details, state, selectedSurfaceId, onSelect }: { details: CoverageServiceDetailView[]; state: PresentationStateKind | null; selectedSurfaceId: string | null; onSelect: (surfaceId: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const classificationOptions = useMemo(() => summarizeCoverageByClassification(details), [details]);
  const providerOptions = useMemo(() => summarizeCoverageByProvider(details), [details]);
  const visible = useMemo(() => filterCoverageServiceDetails(details, { search, classification: category.kind === "classification" ? category.classification : undefined, provider: category.kind === "provider" ? category.provider : undefined }), [details, search, category]);

  return <SecondarySidebar title="接続・観測" summary={state ? undefined : `表示中 ${visible.length}件`}>
    {state ? <PresentationState kind={state} /> : <>
      <div className="relative mb-3"><SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 text-[#8A8A8A]" /><input aria-label="接続・観測を検索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="検索" className="h-9 w-full rounded-lg border border-[#D9D9D9] py-1 pl-8 pr-8 text-[12px] text-[#171717] outline-none focus-visible:border-[#18B5A6] focus-visible:ring-1 focus-visible:ring-[#18B5A6]" />{search && <button type="button" onClick={() => setSearch("")} aria-label="接続・観測検索をクリア" title="接続・観測検索をクリア" className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-[#8A8A8A] outline-none hover:bg-[#F2F2F2] focus-visible:ring-2 focus-visible:ring-[#18B5A6]"><ClearIcon /></button>}</div>
      <div className="mb-3 flex flex-wrap gap-1"><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={chipClass(category.kind === "all")}>すべて {details.length}</button>{classificationOptions.map((option) => <button key={option.id} type="button" onClick={() => setCategory({ kind: "classification", classification: option.id as CoverageClassification })} aria-pressed={category.kind === "classification" && category.classification === option.id} className={chipClass(category.kind === "classification" && category.classification === option.id)}>{option.label} {option.count}</button>)}</div>
      {providerOptions.length > 0 && <details className="mb-3 border-b border-[#E5E5E5] pb-3"><summary className="cursor-pointer text-[11px] text-[#626161] outline-none focus-visible:ring-2 focus-visible:ring-[#18B5A6]">サービスで絞り込む</summary><div className="mt-2 flex flex-wrap gap-1">{providerOptions.map((option) => <button key={option.id} type="button" onClick={() => setCategory({ kind: "provider", provider: option.id as ExecutionProvider })} aria-pressed={category.kind === "provider" && category.provider === option.id} className={chipClass(category.kind === "provider" && category.provider === option.id)}>{option.label} {option.count}</button>)}</div></details>}
      {visible.length === 0 ? <PresentationState kind="empty" /> : <div className="flex flex-col">{visible.map((detail) => <button key={detail.surfaceId} type="button" onClick={() => onSelect(detail.surfaceId)} aria-current={selectedSurfaceId === detail.surfaceId ? "page" : undefined} className={`border-l-2 px-2 py-2 text-left text-[12px] outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#18B5A6] ${selectedSurfaceId === detail.surfaceId ? "border-[#172E95] bg-[#E6F2F2] text-[#171717]" : "border-transparent text-[#626161] hover:bg-[#F7F7F7]"}`}><span className="block truncate font-medium">{detail.source}</span><span className={`mt-0.5 block text-[11px] font-normal ${detail.classification === "PARTIAL" ? "text-[#B7791F]" : detail.classification === "OUTAGE" ? "text-[#C53F4B]" : "text-[#8A8A8A]"}`}>{detail.classificationLabel}</span></button>)}</div>}
    </>}
  </SecondarySidebar>;
}
