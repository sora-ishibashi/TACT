"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import RunsSection from "@/components/runs/RunsSection";
import RunsAppShell from "@/components/shell/AppShell";

// =========================
// Yolna Runs — standalone root page (SOR-135 Phase 2)
// =========================
//
// Mounts the same RunsSection used by the root Yolna application's
// TactShell (section="runs"), minus Research/Core/Code/ProductLauncher/
// Settings — this application has no other section to switch to.
// RunsSection itself already handles its own unauthenticated state; this
// page only adds the minimal top bar (product name + sign out) that
// TactShell would otherwise have provided.

export default function RunsHomePage() {

  const { user, signOut } = useAuth();

  return (
    <div className="flex h-screen min-h-0 flex-col">

      <header className="flex items-center justify-between border-b border-[#F2F2F2] px-6 py-4">
        <span className="text-[15px] font-medium text-[#112278]">Yolna Runs</span>
        {user && (
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-[#8A8A8A]">{user.email}</span>
            <button
              type="button"
              onClick={() => signOut()}
              className="text-[12px] text-[#626161] transition duration-150 ease-out hover:text-[#112278]"
            >
              ログアウト
            </button>
          </div>
        )}
      </header>

      {user ? (
        <RunsAppShell><RunsSection /></RunsAppShell>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-5">
          <p className="text-[13px] leading-[18px] text-[#626161]">ログイン後にRunsを確認できます。</p>
          <Link href="/login" className="text-[13px] text-[#18B5A6] underline">
            ログイン
          </Link>
        </div>
      )}

    </div>
  );

}
