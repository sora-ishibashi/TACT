"use client";

// =========================
// ConnectionObservationSidebar (SOR-187)
// =========================
//
// 検索・すべて・正常・一部観測不可・停止・異常・不明・serviceのfilterと、
// Observation Surfaceのselectable listを提供する。classification判定・
// count導出は一切ここに無い——
// core/tact-runs-view/coverageManagement.tsのpure関数へ完全委譲する
// (絶対条件「No business logic in React」)。

import { useMemo, useState } from "react";
import { SecondarySidebar } from "@/components/shell/SecondarySidebar";
import { PresentationState, type PresentationStateKind } from "@/components/shell/PresentationState";
import {
  filterCoverageServiceDetails,
  summarizeCoverageByClassification,
  summarizeCoverageByProvider,
  type CoverageClassification,
  type CoverageServiceDetailView,
} from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { ExecutionProvider } from "@tact/runs-core/tact-execution/types";

type CategoryFilter =
  | { kind: "all" }
  | { kind: "classification"; classification: CoverageClassification }
  | { kind: "provider"; provider: ExecutionProvider };

export function ConnectionObservationSidebar({ details, state, selectedSurfaceId, onSelect }: {
  details: CoverageServiceDetailView[];
  state: PresentationStateKind | null;
  selectedSurfaceId: string | null;
  onSelect: (surfaceId: string) => void;
}) {

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>({ kind: "all" });

  const classificationOptions = useMemo(() => summarizeCoverageByClassification(details), [details]);
  const providerOptions = useMemo(() => summarizeCoverageByProvider(details), [details]);

  const visible = useMemo(() => filterCoverageServiceDetails(details, {
    search,
    classification: category.kind === "classification" ? category.classification : undefined,
    provider: category.kind === "provider" ? category.provider : undefined,
  }), [details, search, category]);

  return (
    <SecondarySidebar title="接続・観測" summary={state ? undefined : `表示中 ${visible.length} 件`}>
      {state ? <PresentationState kind={state} /> : <>

        <input
          aria-label="接続・観測を検索"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="検索"
          className="mb-3 h-9 w-full rounded border border-[#D9D9D9] px-2 text-[12px]"
        />

        <div className="mb-3 flex flex-wrap gap-1 text-[12px]">
          <button type="button" onClick={() => setCategory({ kind: "all" })} aria-pressed={category.kind === "all"} className="rounded px-2 py-1 text-[#112278]">
            すべて ({details.length})
          </button>
          {classificationOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setCategory({ kind: "classification", classification: option.id as CoverageClassification })}
              aria-pressed={category.kind === "classification" && category.classification === option.id}
              className="rounded px-2 py-1 text-[#112278]"
            >
              {option.label} ({option.count})
            </button>
          ))}
        </div>

        {providerOptions.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 text-[11px] text-[#8A8A8A]">サービス別</p>
            <div className="flex flex-col gap-1">
              {providerOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setCategory({ kind: "provider", provider: option.id as ExecutionProvider })}
                  aria-pressed={category.kind === "provider" && category.provider === option.id}
                  className="rounded px-2 py-1 text-left text-[12px] text-[#112278]"
                >
                  {option.label} ({option.count})
                </button>
              ))}
            </div>
          </div>
        )}

        {visible.length === 0 ? <PresentationState kind="empty" /> : (
          <div className="flex flex-col gap-1">
            {visible.map((detail) => (
              <button
                key={detail.surfaceId}
                type="button"
                onClick={() => onSelect(detail.surfaceId)}
                aria-current={selectedSurfaceId === detail.surfaceId ? "page" : undefined}
                className={`rounded px-2 py-2 text-left text-[12px] ${selectedSurfaceId === detail.surfaceId ? "bg-[#E6F2F2] text-[#112278]" : "text-[#626161] hover:bg-[#F2F2F2]"}`}
              >
                <span className="block truncate font-medium">{detail.source}</span>
                <span className="mt-1 block text-[11px]">{detail.classificationLabel}</span>
              </button>
            ))}
          </div>
        )}

      </>}
    </SecondarySidebar>
  );

}
