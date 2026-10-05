import type { ReactNode } from "react";
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) { return <header className="flex items-center justify-between gap-3 border-b border-[#E5E5E5] pb-2"><h1 className="text-[20px] font-semibold leading-7 text-[#171717]">{title}</h1>{actions}</header>; }
export function DrawerContainer({ children, className = "" }: { children: ReactNode; className?: string }) { return <div className={`fixed inset-y-0 left-0 z-30 w-[min(320px,calc(100vw-24px))] overflow-hidden bg-white shadow-xl lg:static lg:shadow-none ${className}`}>{children}</div>; }
/** Mount only when a detail screen requests it; never rendered by the shell itself. */
export function InspectorPanel({ children }: { children: ReactNode }) { return <aside aria-label="詳細パネル" className="fixed inset-y-0 right-0 z-40 w-[min(480px,100vw)] overflow-y-auto border-l border-[#D9D9D9] bg-white shadow-xl">{children}</aside>; }
