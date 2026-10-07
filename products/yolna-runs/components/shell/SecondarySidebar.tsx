"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CloseIcon } from "@/components/icons/RunsIcons";
import { DrawerContainer } from "./ShellContainers";

export type SecondaryListItem = { id: string; label: string; count?: number };
export type SecondarySidebarProps = { title: string; children: ReactNode; summary?: string };
export type FilterSidebarContract = { groups: readonly string[]; hasActiveFilters: boolean; onClear: () => void };
export type MixedSidebarContract = { categories: readonly SecondaryListItem[]; selectedId: string | null; onSelect: (id: string | null) => void };
export type TargetSidebarContract = { search: string; onSearch: (value: string) => void; items: readonly SecondaryListItem[]; selectedId: string | null; onSelect: (id: string) => void };

export function SecondarySidebar({ title, summary, children }: SecondarySidebarProps) {
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); queueMicrotask(() => openButtonRef.current?.focus()); };

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); queueMicrotask(() => openButtonRef.current?.focus()); } };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [open]);

  return <>
    <button ref={openButtonRef} type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-controls={drawerId} className="mb-4 inline-flex h-9 w-fit items-center rounded-md border border-runs-border bg-runs-surface px-3 text-sm text-runs-text outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus lg:hidden">{title}</button>
    {open ? <button aria-label="補助ナビゲーションを閉じる" onClick={close} className="fixed inset-0 z-40 bg-[var(--runs-overlay)] lg:hidden" /> : null}
    <DrawerContainer className={`border-r border-runs-border-subtle transition-transform duration-200 ease-out motion-reduce:transition-none lg:w-[264px] lg:min-w-[264px] lg:max-w-[264px] lg:shrink-0 ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
      <div id={drawerId} className="flex h-full min-h-0 flex-col"><div className="flex shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-5"><div className="min-w-0"><h2 className="text-base font-semibold text-runs-text">{title}</h2>{summary ? <p className="mt-1 text-xs text-runs-text-secondary">{summary}</p> : null}</div><button type="button" title={`${title}を閉じる`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus lg:hidden" onClick={close} aria-label={`${title}を閉じる`}><CloseIcon /></button></div><div className="tact-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-5">{children}</div></div>
    </DrawerContainer>
  </>;
}
