"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import SettingsView from "@/components/runs/SettingsView";

export type RunsSection = "home" | "work" | "attention" | "activity" | "agent" | "permission" | "coverage" | "settings";
type ShellContextValue = { section: RunsSection; setSection: (section: RunsSection) => void };
const ShellContext = createContext<ShellContextValue | null>(null);
export function useRunsShell(): ShellContextValue { const context = useContext(ShellContext); if (!context) throw new Error("useRunsShell must be used inside RunsAppShell"); return context; }

const navigation: Array<{ id: RunsSection; label: string; group?: string }> = [
  { id: "home", label: "ホーム" }, { id: "work", label: "仕事" }, { id: "attention", label: "要確認" }, { id: "activity", label: "実行記録" },
  { id: "agent", label: "AI", group: "運用" }, { id: "permission", label: "権限" }, { id: "coverage", label: "接続・観測" }, { id: "settings", label: "設定" },
];

export default function RunsAppShell({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<RunsSection>("home");
  const [open, setOpen] = useState(false);
  const { user, signOut } = useAuth();
  const openSection = (next: RunsSection) => { setSection(next); setOpen(false); };
  return <ShellContext.Provider value={{ section, setSection }}><div className="flex min-h-0 flex-1 overflow-hidden bg-white">
    {open && <button aria-label="ナビゲーションを閉じる" className="fixed inset-0 z-20 bg-black/20 lg:hidden" onClick={() => setOpen(false)} />}
    <aside className={`fixed inset-y-0 left-0 z-30 flex w-[196px] flex-col border-r border-[#E5E5E5] bg-white p-3 transition-transform lg:static lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="mb-5 flex items-center justify-between px-2 pt-1"><span className="text-[15px] font-semibold text-[#171717]">Yolna Runs</span><button type="button" className="lg:hidden" onClick={() => setOpen(false)} aria-label="閉じる">×</button></div>
      <nav aria-label="主なナビゲーション" className="flex flex-col gap-0.5">{navigation.map((item, index) => <div key={item.id} className={item.group && index > 0 ? "mt-4" : ""}>{item.group && <p className="mb-1 px-2 text-[10px] font-medium tracking-wide text-[#8A8A8A]">{item.group}</p>}<button type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => openSection(item.id)} className={`w-full rounded-md border-l-2 px-2.5 py-1.5 text-left text-[13px] transition ${section === item.id ? "border-[#172E95] bg-[#F2F4FB] font-semibold text-[#171717]" : "border-transparent text-[#626161] hover:bg-[#F7F7F7] hover:text-[#171717]"}`}>{item.label}</button></div>)}</nav>
      <div className="mt-auto border-t border-[#E5E5E5] px-2 pt-3"><p className="truncate text-[12px] text-[#626161]">{user?.email}</p><button type="button" onClick={() => signOut()} className="mt-2 text-[12px] text-[#626161] hover:text-[#171717]">ログアウト</button></div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col"><header className="flex h-12 items-center border-b border-[#E5E5E5] px-3 lg:hidden"><button type="button" onClick={() => setOpen(true)} aria-label="ナビゲーションを開く" className="rounded p-2 text-[#171717]">☰</button><span className="ml-2 text-[14px] font-semibold text-[#171717]">Yolna Runs</span></header>{section === "settings" ? <SettingsView email={user?.email ?? ""} onSignOut={signOut} onOpenPermission={() => openSection("permission")} onOpenCoverage={() => openSection("coverage")} onOpenAgent={() => openSection("agent")} /> : children}</div>
  </div></ShellContext.Provider>;
}
