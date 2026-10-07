"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "@/components/icons/RunsIcons";

/** Presentation-only detail surface shared by Runs list views. */
export function DetailPeek({ title, children, footer, onClose }: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("keydown", closeOnEscape); returnFocusRef.current?.focus(); };
  }, []);

  return <div className="fixed inset-0 z-40 bg-[var(--runs-overlay)] md:bg-transparent">
    <button type="button" className="absolute inset-0 hidden cursor-default md:block" aria-label={`${title}を閉じる`} onClick={onClose} />
    <aside role="dialog" aria-modal="true" aria-label={title} className="runs-peek-enter relative ml-auto flex h-full w-full flex-col border-l border-runs-border bg-runs-raised shadow-[var(--runs-shadow)] md:w-[min(480px,calc(100vw-24px))]">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-runs-border-subtle px-5 py-3"><h2 className="min-w-0 break-words text-lg font-semibold text-runs-text">{title}</h2><button ref={closeButtonRef} type="button" onClick={onClose} title={`${title}を閉じる`} className="runs-focus inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-runs-text-secondary hover:bg-runs-hover hover:text-runs-text" aria-label={`${title}を閉じる`}><CloseIcon /></button></header>
      <div className="tact-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5">{children}</div>
      {footer && <footer className="shrink-0 border-t border-runs-border-subtle px-5 py-4">{footer}</footer>}
    </aside>
  </div>;
}
