"use client";

import { PageHeader } from "@/components/ui/RunsPrimitives";

export default function SettingsView({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return <div className="max-w-2xl"><PageHeader title="設定" /><section className="mt-6 border-t border-runs-border-subtle pt-5"><h2 className="text-base font-semibold text-runs-text">アカウント</h2><dl className="mt-4 space-y-1"><dt className="text-xs font-medium text-runs-text-secondary">メールアドレス</dt><dd className="break-all text-sm text-runs-text">{email}</dd></dl><button type="button" onClick={onSignOut} className="runs-focus mt-5 rounded-md border border-runs-border bg-runs-surface px-3 py-2 text-sm font-medium text-runs-text transition-colors duration-100 hover:bg-runs-hover">ログアウト</button></section></div>;
}
