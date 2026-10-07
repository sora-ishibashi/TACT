import type { ReactNode } from "react";
export { PageHeader } from "@/components/ui/RunsPrimitives";
export function DrawerContainer({ children, className = "" }: { children: ReactNode; className?: string }) { return <div className={`fixed inset-y-0 left-0 z-50 w-[min(320px,calc(100vw-24px))] overflow-hidden bg-runs-surface shadow-[var(--runs-shadow)] ${className}`}>{children}</div>; }
/** Mount only when a detail screen requests it; never rendered by the shell itself. */
export function InspectorPanel({ children }: { children: ReactNode }) { return <aside aria-label="詳細パネル" className="fixed inset-y-0 right-0 z-40 w-[min(480px,100vw)] overflow-y-auto border-l border-runs-border bg-runs-raised shadow-[var(--runs-shadow)]">{children}</aside>; }
