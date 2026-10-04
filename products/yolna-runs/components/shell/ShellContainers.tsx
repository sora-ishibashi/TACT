import type { ReactNode } from "react";
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) { return <header className="flex items-center justify-between gap-3 border-b border-[#F2F2F2] pb-3"><h1 className="text-[24px] font-medium leading-[32px] text-[#112278]">{title}</h1>{actions}</header>; }
export function DrawerContainer({ children }: { children: ReactNode }) { return <div className="fixed inset-y-0 left-0 z-30 w-[min(320px,calc(100vw-24px))] overflow-y-auto bg-white shadow-xl lg:static lg:w-auto lg:shadow-none">{children}</div>; }
/** Mount only when a detail screen requests it; never rendered by the shell itself. */
export function InspectorPanel({ children }: { children: ReactNode }) { return <aside aria-label="詳細パネル" className="fixed inset-y-0 right-0 z-40 w-[min(480px,100vw)] overflow-y-auto border-l border-[#D9D9D9] bg-white shadow-xl">{children}</aside>; }
