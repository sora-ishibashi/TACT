"use client";

import { useState, type ReactNode } from "react";
import { DrawerContainer } from "./ShellContainers";
export type SecondaryListItem = { id: string; label: string; count?: number };
export type SecondarySidebarProps = { title: string; children: ReactNode; summary?: string };
export type FilterSidebarContract = { groups: readonly string[]; hasActiveFilters: boolean; onClear: () => void };
export type MixedSidebarContract = { categories: readonly SecondaryListItem[]; selectedId: string | null; onSelect: (id: string | null) => void };
export type TargetSidebarContract = { search: string; onSearch: (value: string) => void; items: readonly SecondaryListItem[]; selectedId: string | null; onSelect: (id: string) => void };

export function SecondarySidebar({ title, summary, children }: SecondarySidebarProps) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)} className="mb-3 w-fit rounded border border-[#D9D9D9] px-3 py-2 text-[12px] text-[#171717] lg:hidden">{title}</button>{open && <button aria-label="補助パネルを閉じる" onClick={() => setOpen(false)} className="fixed inset-0 z-20 bg-black/20 lg:hidden" />}<DrawerContainer className={`border-r border-[#E5E5E5] p-4 transition-transform lg:w-[248px] lg:shrink-0 ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}><div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="text-[14px] font-semibold text-[#171717]">{title}</h2>{summary && <p className="mt-1 text-[12px] text-[#626161]">{summary}</p>}</div><button type="button" className="lg:hidden" onClick={() => setOpen(false)} aria-label="閉じる">×</button></div>{children}</DrawerContainer></>;
}
