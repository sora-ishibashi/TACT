"use client";

import { useMemo, useState } from "react";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import { filterCoverageServiceDetails, summarizeCoverageByClassification, summarizeCoverageByProvider, type CoverageClassification, type CoverageServiceDetailView } from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { ExecutionProvider } from "@tact/runs-core/tact-execution/types";

type CategoryFilter = { kind: "all" } | { kind: "classification"; classification: CoverageClassification } | { kind: "provider"; provider: ExecutionProvider };
const filterClass = (selected: boolean) => `w-full rounded px-2 py-1.5 text-left text-[12px] ${selected ? "bg-[#F2F4FB] font-semibold text-[#171717]" : "text-[#626161] hover:bg-[#F7F7F7]"}`;

export function ConnectionObservationSidebar({ details, state, selectedSurfaceId, onSelect }: { details: CoverageServiceDetailView[]; state: PresentationStateKind | null; selectedSurfaceId: string | null; onSelect: (surfaceId: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });
  const classificationOptions = useMemo(() => summarizeCoverageByClassification(details), [details]);
  const providerOptions = useMemo(() => summarizeCoverageByProvider(details), [details]);
  const visible = useMemo(() => filterCoverageServiceDetails(details, { search, classification: category.kind === "classification" ? category.classification : undefined, provider: category.kind === "provider" ? category.provider : undefined }), [details, search, category]);
  return <SecondarySidebar title="接続・観測" summary={state ? undefined : `表示中 ${visible.length} 件`}>
    {state ? <PresentationState kind={state} /> : <><input aria-label="接続・観測を検索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="検索" className="mb-4 h-8 w-full rounded border border-[#D9D9D9] px-2 text-[12px]" />
      <section><p className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-[#8A8A8A]">状態</p><button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className={filterClass(category.kind === "all")}>すべて <span className="float-right tabular-nums">{details.length}</span></button>{classificationOptions.map((option) => <button key={option.id} type="button" onClick={() => setCategory({ kind: "classification", classification: option.id as CoverageClassification })} aria-pressed={category.kind === "classification" && category.classification === option.id} className={filterClass(category.kind === "classification" && category.classification === option.id)}>{option.label}<span className="float-right tabular-nums">{option.count}</span></button>)}</section>
      {providerOptions.length > 0 && <section className="mt-4 border-t border-[#E5E5E5] pt-4"><p className="mb-1 px-2 text-[10px] font-semibold tracking-wide text-[#8A8A8A]">サービス</p>{providerOptions.map((option) => <button key={option.id} type="button" onClick={() => setCategory({ kind: "provider", provider: option.id as ExecutionProvider })} aria-pressed={category.kind === "provider" && category.provider === option.id} className={filterClass(category.kind === "provider" && category.provider === option.id)}>{option.label}<span className="float-right tabular-nums">{option.count}</span></button>)}</section>}
      <section className="mt-4 border-t border-[#E5E5E5] pt-4"><p className="mb-1 text-[10px] font-semibold tracking-wide text-[#8A8A8A]">観測対象</p>{visible.length === 0 ? <PresentationState kind="empty" /> : <div className="flex flex-col gap-0.5">{visible.map((detail) => <button key={detail.surfaceId} type="button" onClick={() => onSelect(detail.surfaceId)} aria-current={selectedSurfaceId === detail.surfaceId ? "page" : undefined} className={filterClass(selectedSurfaceId === detail.surfaceId)}><span className="block truncate">{detail.source}</span><span className="mt-0.5 block text-[11px] font-normal text-[#8A8A8A]">{detail.classificationLabel}</span></button>)}</div>}</section>
    </>}</SecondarySidebar>;
}
