"use client";

import { useEffect, useRef } from "react";
import type { ActivityFilterOptions, ActivityItemFilters } from "@tact/runs-core/tact-runs-view";
import { CloseIcon } from "@/components/icons/RunsIcons";
import ActivityFilters from "./ActivityFilters";

export function ActivityFilterSheet({ open, filters, options, onChange, onClose }: { open: boolean; filters: ActivityItemFilters; options: ActivityFilterOptions; onChange: (filters: ActivityItemFilters) => void; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose, open]);

  if (!open) return null;
  return <div className="fixed inset-0 z-50">
    <button type="button" aria-label="フィルタを閉じる" className="absolute inset-0 bg-[var(--runs-overlay)]" onClick={onClose} />
    <aside role="dialog" aria-modal="true" aria-label="実行記録のフィルタ" className="absolute inset-y-0 right-0 flex w-[min(400px,calc(100vw-24px))] flex-col border-l border-runs-border bg-runs-surface shadow-[var(--runs-shadow)] max-[767px]:w-full">
      <header className="flex items-center justify-between border-b border-runs-border-subtle px-4 py-3"><h2 className="text-base font-semibold text-runs-text">実行記録のフィルタ</h2><button ref={closeButtonRef} type="button" onClick={onClose} aria-label="フィルタを閉じる" title="フィルタを閉じる" className="runs-focus inline-flex h-9 w-9 items-center justify-center rounded-md text-runs-text-secondary hover:bg-runs-hover"><CloseIcon /></button></header>
      <div className="tact-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5"><ActivityFilters filters={filters} options={options} onChange={onChange} /></div>
    </aside>
  </div>;
}
