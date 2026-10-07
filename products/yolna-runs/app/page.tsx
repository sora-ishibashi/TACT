"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import RunsSection from "@/components/runs/RunsSection";
import RunsAppShell from "@/components/shell/AppShell";

export default function RunsHomePage() {
  const { user } = useAuth();
  return <div className="flex h-screen min-h-0 flex-col">
    {user ? <RunsAppShell><RunsSection /></RunsAppShell> : <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-5"><p className="text-sm leading-[18px] text-runs-text-secondary">ログイン後に Runs を確認できます。</p><Link href="/login" className="text-sm text-runs-interactive underline">ログイン</Link></div>}
  </div>;
}
