"use client";

import { useEffect, type ReactNode } from "react";

/** Presentation-only detail surface shared by Runs list views. */
export function DetailPeek({ title, children, footer, onClose }: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="fixed inset-0 z-40 bg-black/20 md:left-auto md:bg-transparent">
    <aside role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full flex-col border-l border-[#D9D9D9] bg-white shadow-xl md:ml-auto md:w-[min(480px,calc(100vw-24px))]">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[#E5E5E5] px-5 py-4"><h2 className="text-[18px] font-semibold text-[#171717]">{title}</h2><button type="button" onClick={onClose} className="rounded px-2 py-1 text-[13px] text-[#626161] hover:bg-[#F7F7F7] hover:text-[#171717]" aria-label={`${title}を閉じる`}>閉じる</button></header>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5">{children}</div>
      {footer && <footer className="shrink-0 border-t border-[#E5E5E5] px-5 py-4">{footer}</footer>}
    </aside>
  </div>;
}
