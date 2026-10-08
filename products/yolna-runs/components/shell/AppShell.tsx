"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ActivityIcon, AttentionIcon, CloseIcon, CogIcon, HomeIcon, ManagementIcon, MenuIcon, type RunsIconProps, WorkIcon } from "@/components/icons/RunsIcons";

export type RunsSection = "home" | "work" | "attention" | "activity" | "management" | "settings";
export type ShellLayoutMode = "wide" | "medium" | "narrow";
export type ShellOverlay = "none" | "primary" | "secondary" | "peek";
type ShellContextValue = { section: RunsSection; setSection: (section: RunsSection) => void; layoutMode: ShellLayoutMode; overlay: ShellOverlay; openOverlay: (overlay: Exclude<ShellOverlay, "none">, trigger?: HTMLElement | null) => void; closeOverlay: () => void };
const ShellContext = createContext<ShellContextValue | null>(null);

export function useRunsShell(): ShellContextValue {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useRunsShell must be used inside RunsAppShell");
  return context;
}

const mainNavigation: Array<{ id: Exclude<RunsSection, "settings">; label: string; icon: ComponentType<RunsIconProps> }> = [
  { id: "home", label: "ホーム", icon: HomeIcon },
  { id: "work", label: "Work", icon: WorkIcon },
  { id: "attention", label: "要確認", icon: AttentionIcon },
  { id: "activity", label: "実行記録", icon: ActivityIcon },
  { id: "management", label: "管理", icon: ManagementIcon },
];

function NavigationButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: ComponentType<RunsIconProps>; label: string; onClick: () => void }) {
  return <button type="button" aria-current={active ? "page" : undefined} onClick={onClick} className={`flex w-full items-center gap-2 rounded-md border-l-2 px-2.5 py-2 text-left text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${active ? "border-runs-interactive bg-runs-selected font-semibold text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover hover:text-runs-text"}`}><Icon className="h-5 w-5 shrink-0" /><span>{label}</span></button>;
}

export default function RunsAppShell({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<RunsSection>("home");
  const [layoutMode, setLayoutMode] = useState<ShellLayoutMode>("wide");
  const [overlay, setOverlay] = useState<ShellOverlay>("none");
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const overlayTriggerRef = useRef<HTMLElement | null>(null);
  const { user } = useAuth();

  const openSection = (next: RunsSection) => { setSection(next); setOverlay("none"); };
  const openOverlay = useCallback((next: Exclude<ShellOverlay, "none">, trigger?: HTMLElement | null) => { overlayTriggerRef.current = trigger ?? null; setOverlay(next); }, []);
  const closeOverlay = useCallback(() => { const trigger = overlayTriggerRef.current; setOverlay("none"); queueMicrotask(() => trigger?.focus()); }, []);

  useEffect(() => {
    const update = () => { const next = window.innerWidth >= 1200 ? "wide" : window.innerWidth >= 768 ? "medium" : "narrow"; setLayoutMode(next); if (next === "wide") setOverlay("none"); };
    queueMicrotask(update); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => { if (overlay === "none") return; const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeOverlay(); }; window.addEventListener("keydown", onEscape); return () => window.removeEventListener("keydown", onEscape); }, [closeOverlay, overlay]);

  return <ShellContext.Provider value={{ section, setSection, layoutMode, overlay, openOverlay, closeOverlay }}><div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-runs-base">
    {overlay !== "none" ? <button aria-label="オーバーレイを閉じる" className="fixed inset-0 z-40 bg-[var(--runs-overlay)] min-[1200px]:hidden" onClick={closeOverlay} /> : null}
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-[208px] flex-col border-r border-runs-border-subtle bg-runs-surface px-3 py-4 transition-transform duration-200 ease-out motion-reduce:transition-none min-[1200px]:static min-[1200px]:translate-x-0 ${overlay === "primary" ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="mb-6 flex h-9 items-center justify-between px-2"><span className="text-sm font-semibold tracking-tight text-runs-text">Yolna Runs</span><button type="button" title="ナビゲーションを閉じる" className="flex h-9 w-9 items-center justify-center rounded-md text-runs-text-secondary outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus min-[1200px]:hidden" onClick={closeOverlay} aria-label="ナビゲーションを閉じる"><CloseIcon /></button></div>
      <nav aria-label="主なナビゲーション" className="flex flex-col gap-1">{mainNavigation.map((item) => <NavigationButton key={item.id} active={section === item.id} icon={item.icon} label={item.label} onClick={() => openSection(item.id)} />)}</nav>
      <div className="mt-auto"><nav aria-label="補助ナビゲーション" className="border-b border-runs-border-subtle pb-3"><NavigationButton active={section === "settings"} icon={CogIcon} label="設定" onClick={() => openSection("settings")} /></nav><div className="flex min-w-0 items-center gap-2 px-2 pb-1 pt-4"><span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-runs-hover text-xs font-semibold text-runs-text">{user?.email?.slice(0, 1).toUpperCase() ?? "?"}</span><p className="min-w-0 flex-1 truncate text-xs font-medium text-runs-text" title={user?.email}>{user?.email ?? ""}</p></div></div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"><header className="flex h-12 shrink-0 items-center border-b border-runs-border-subtle bg-runs-surface px-3 min-[1200px]:hidden"><button ref={openButtonRef} type="button" onClick={() => openOverlay("primary", openButtonRef.current)} title="ナビゲーションを開く" aria-label="ナビゲーションを開く" className="flex h-9 w-9 items-center justify-center rounded-md text-runs-text outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus"><MenuIcon /></button><span className="ml-2 text-sm font-semibold text-runs-text">Yolna Runs</span></header>{children}</div>
  </div></ShellContext.Provider>;
}
