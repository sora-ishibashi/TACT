"use client";

import { createContext, useContext, useState, type ComponentType, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import SettingsView from "@/components/runs/SettingsView";
import {
  ActivityIcon,
  AiIcon,
  AttentionIcon,
  CloseIcon,
  CoverageIcon,
  HomeIcon,
  MenuIcon,
  PermissionIcon,
  SettingsIcon,
  type RunsIconProps,
  WorkIcon,
} from "@/components/icons/RunsIcons";

export type RunsSection = "home" | "work" | "attention" | "activity" | "agent" | "permission" | "coverage" | "settings";
type ShellContextValue = { section: RunsSection; setSection: (section: RunsSection) => void };
const ShellContext = createContext<ShellContextValue | null>(null);
export function useRunsShell(): ShellContextValue { const context = useContext(ShellContext); if (!context) throw new Error("useRunsShell must be used inside RunsAppShell"); return context; }

const navigation: Array<{ id: RunsSection; label: string; icon: ComponentType<RunsIconProps>; group?: string }> = [
  { id: "home", label: "ホーム", icon: HomeIcon },
  { id: "work", label: "Work", icon: WorkIcon },
  { id: "attention", label: "要確認", icon: AttentionIcon },
  { id: "activity", label: "実行記録", icon: ActivityIcon },
  { id: "agent", label: "AI", icon: AiIcon, group: "運用" },
  { id: "permission", label: "権限", icon: PermissionIcon },
  { id: "coverage", label: "接続・観測", icon: CoverageIcon },
  { id: "settings", label: "設定", icon: SettingsIcon },
];

export default function RunsAppShell({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<RunsSection>("home");
  const [open, setOpen] = useState(false);
  const { user, signOut } = useAuth();
  const openSection = (next: RunsSection) => { setSection(next); setOpen(false); };
  return <ShellContext.Provider value={{ section, setSection }}><div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-runs-surface">
    {open && <button aria-label="ナビゲーションを閉じる" className="fixed inset-0 z-20 bg-[var(--runs-overlay)] min-[1200px]:hidden" onClick={() => setOpen(false)} />}
    <aside className={`fixed inset-y-0 left-0 z-30 flex w-[196px] flex-col border-r border-runs-border-subtle bg-runs-surface p-3 transition-transform duration-200 motion-reduce:transition-none min-[1200px]:static min-[1200px]:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="mb-5 flex items-center justify-between px-2 pt-1"><span className="text-base font-semibold text-runs-text">Yolna Runs</span><button type="button" title="ナビゲーションを閉じる" className="flex h-9 w-9 items-center justify-center rounded-md text-runs-text-secondary outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus min-[1200px]:hidden" onClick={() => setOpen(false)} aria-label="ナビゲーションを閉じる"><CloseIcon /></button></div>
      <nav aria-label="主なナビゲーション" className="flex flex-col gap-0.5">{navigation.map((item, index) => { const NavigationIcon = item.icon; return <div key={item.id} className={item.group && index > 0 ? "mt-4" : ""}>{item.group && <p className="mb-1 px-2 text-xs font-medium tracking-wide text-runs-muted">{item.group}</p>}<button type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => openSection(item.id)} className={`flex w-full items-center gap-2 rounded-md border-l-2 px-2.5 py-2 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus ${section === item.id ? "border-runs-interactive bg-runs-selected font-semibold text-runs-text" : "border-transparent text-runs-text-secondary hover:bg-runs-hover hover:text-runs-text"}`}><NavigationIcon className="shrink-0" /><span>{item.label}</span></button></div>; })}</nav>
      <div className="mt-auto border-t border-runs-border-subtle px-2 pt-3"><p className="truncate text-xs text-runs-text-secondary" title={user?.email}>{user?.email}</p><button type="button" onClick={() => signOut()} className="runs-focus mt-2 rounded-sm text-xs text-runs-text-secondary hover:text-runs-text">ログアウト</button></div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"><header className="flex h-12 shrink-0 items-center border-b border-runs-border-subtle px-3 min-[1200px]:hidden"><button type="button" onClick={() => setOpen(true)} title="ナビゲーションを開く" aria-label="ナビゲーションを開く" className="flex h-9 w-9 items-center justify-center rounded-md text-runs-text outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-runs-focus"><MenuIcon /></button><span className="ml-2 text-sm font-semibold text-runs-text">Yolna Runs</span></header>{section === "settings" ? <SettingsView email={user?.email ?? ""} onSignOut={signOut} onOpenPermission={() => openSection("permission")} onOpenCoverage={() => openSection("coverage")} onOpenAgent={() => openSection("agent")} /> : children}</div>
  </div></ShellContext.Provider>;
}
