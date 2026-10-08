"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "@/components/icons/RunsIcons";
import { useRunsShell } from "./AppShell";

/** Contextual desktop sidecar; it becomes a modal only in narrow layout. */
export function DetailPeek({ title, children, footer, onClose, inlineOnWide = false }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; inlineOnWide?: boolean }) {
  const { layoutMode } = useRunsShell();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const narrow = layoutMode === "narrow";
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (narrow) closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("keydown", closeOnEscape); returnFocusRef.current?.focus(); };
  }, [narrow]);

  const panel = <aside role={narrow ? "dialog" : "complementary"} aria-modal={narrow || undefined} aria-label={title} className={`runs-peek-enter fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-runs-border bg-runs-raised shadow-[var(--runs-shadow)] md:w-[min(480px,calc(100vw-24px))] ${inlineOnWide ? "min-[1440px]:static min-[1440px]:w-[min(480px,36vw)] min-[1440px]:min-w-[360px] min-[1440px]:shadow-none" : ""}`}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-runs-border-subtle px-5 py-3"><h2 className="min-w-0 break-words text-lg font-semibold text-runs-text">{title}</h2><button ref={closeButtonRef} type="button" onClick={onClose} title={`${title}を閉じる`} className="runs-focus inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary hover:bg-runs-hover hover:text-runs-text" aria-label={`${title}を閉じる`}><CloseIcon /></button></header>
    <div className="tact-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5">{children}</div>
    {footer && <footer className="shrink-0 border-t border-runs-border-subtle px-5 py-4">{footer}</footer>}
  </aside>;

  return narrow ? <div className="fixed inset-0 z-50 bg-[var(--runs-overlay)]"><button type="button" className="absolute inset-0 cursor-default" aria-label={`${title}を閉じる`} onClick={onClose} />{panel}</div> : panel;
}
