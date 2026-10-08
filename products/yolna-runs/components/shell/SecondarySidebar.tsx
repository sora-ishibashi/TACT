"use client";

import { useId, type ReactNode } from "react";
import { CloseIcon, MenuIcon } from "@/components/icons/RunsIcons";
import { DrawerContainer } from "./ShellContainers";
import { useRunsShell } from "./AppShell";

export type SecondaryListItem = { id: string; label: string; count?: number };
export type SecondarySidebarProps = { title: string; children: ReactNode; summary?: string; persistent?: boolean; hideTrigger?: boolean; compact?: boolean };
export type FilterSidebarContract = { groups: readonly string[]; hasActiveFilters: boolean; onClear: () => void };
export type MixedSidebarContract = { categories: readonly SecondaryListItem[]; selectedId: string | null; onSelect: (id: string | null) => void };
export type TargetSidebarContract = { search: string; onSearch: (value: string) => void; items: readonly SecondaryListItem[]; selectedId: string | null; onSelect: (id: string) => void };

export function SecondarySidebar({ title, summary, children, persistent = true, hideTrigger = false, compact = false }: SecondarySidebarProps) {
  const { layoutMode, overlay, openOverlay, closeOverlay } = useRunsShell();
  const drawerId = useId();
  const persistentDesktop = persistent && layoutMode !== "narrow";
  const open = persistentDesktop || overlay === "secondary";

  return <>
    {!hideTrigger ? <button type="button" onClick={(event) => openOverlay("secondary", event.currentTarget)} aria-expanded={open} aria-controls={drawerId} aria-label={`${title}の一覧を開く`} title={`${title}の一覧を開く`} className={`runs-focus mb-4 inline-flex h-9 w-9 items-center justify-center rounded-md text-runs-text-secondary hover:bg-runs-hover ${persistent ? "min-[768px]:hidden" : ""}`}><MenuIcon /></button> : null}
    <DrawerContainer className={`border-r border-runs-border-subtle transition-transform duration-200 ease-out motion-reduce:transition-none ${persistent ? `min-[768px]:static ${compact ? "min-[768px]:w-[184px] min-[768px]:min-w-[184px] min-[768px]:max-w-[184px]" : "min-[768px]:w-[264px] min-[768px]:min-w-[264px] min-[768px]:max-w-[264px]"} min-[768px]:shrink-0 min-[768px]:shadow-none` : ""} ${open ? "translate-x-0" : "-translate-x-full"}`}>
      <div id={drawerId} className="flex h-full min-h-0 flex-col"><div className="flex shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-5"><div className="min-w-0"><h2 className="text-base font-semibold text-runs-text">{title}</h2>{summary ? <p className="mt-1 text-xs text-runs-text-secondary">{summary}</p> : null}</div><button type="button" title={`${title}を閉じる`} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus ${persistent ? "min-[768px]:hidden" : ""}`} onClick={closeOverlay} aria-label={`${title}を閉じる`}><CloseIcon /></button></div><div className="tact-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-5">{children}</div></div>
    </DrawerContainer>
  </>;
}
