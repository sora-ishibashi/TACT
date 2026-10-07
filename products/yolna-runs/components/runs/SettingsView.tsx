"use client";

import { ChevronRightIcon } from "@/components/icons/RunsIcons";

function NavigationRow({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="flex w-full items-center justify-between border-b border-runs-border-subtle py-3 text-left text-sm text-runs-text outline-none hover:bg-runs-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-runs-focus"><span>{label}</span><ChevronRightIcon className="text-runs-muted" /></button>; }

export default function SettingsView({ email, onSignOut, onOpenPermission, onOpenCoverage, onOpenAgent }: { email: string; onSignOut: () => void; onOpenPermission: () => void; onOpenCoverage: () => void; onOpenAgent: () => void }) {
  return <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6"><div className="max-w-2xl"><header className="border-b border-runs-border-subtle pb-2"><h1 className="text-xl font-semibold leading-7 text-runs-text">設定</h1></header><section className="py-5"><h2 className="text-sm font-semibold text-runs-text">運用</h2><div className="mt-2"><NavigationRow label="権限" onClick={onOpenPermission} /><NavigationRow label="接続・観測" onClick={onOpenCoverage} /><NavigationRow label="AI" onClick={onOpenAgent} /></div></section><section className="border-t border-runs-border-subtle py-5"><h2 className="text-sm font-semibold text-runs-text">アカウント</h2><p className="mt-2 text-sm text-runs-text-secondary">メールアドレス</p><p className="mt-1 truncate text-sm text-runs-text" title={email}>{email}</p><button type="button" onClick={onSignOut} className="runs-focus mt-4 rounded-sm text-sm font-medium text-runs-interactive hover:underline">ログアウト</button></section></div></main>;
}
