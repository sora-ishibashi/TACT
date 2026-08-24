"use client";

// =========================
// TactShell (STEP215、Phase72でBeta Entry UXを追加)
// =========================
//
// 新TACT UIのトップレベル構造。app/page.tsxから描画される、
// 新TACTの既定(通常利用経路)の入口。
//
// 基本レイアウト(STEP215で指定された必須ルール):
//   - 左端: メニューバー(MenuBar) — 将来のTACT派生機能への導線
//   - 中央: TACTとの対話(ResearchSection/CoreSectionの左半分)
//   - 右: TACTが生み出したもの(同・右半分)
//
// 重要: このコンポーネント自体はcore/agents・core/workflow・
// core/planner・core/conversationのいずれにも依存しない
// (grep確認済み)。旧TACT(components/TactInterface.tsx等)は
// app/legacy/page.tsxへ退避済みで、削除していない。
//
// Phase72 Section3/6/7: 認証状態に応じたUI表示として、既存
// AuthProvider(STEP132)のuser/signOutをヘッダーへ表示するだけの
// 最小Entry制御を追加した(新しいAuthentication Contextは作らない)。
// また、Betaでは既存のCanonical Conversation Architecture
// (ConversationSection)を主要な入口として扱うため、既定表示Sectionを
// "conversation"にした(Research/Coreの実装・挙動は無変更)。

import { useState } from "react";

import MenuBar, { TactSection } from "./MenuBar";
import ResearchSection from "./ResearchSection";
import CoreSection from "./CoreSection";
import ConversationSection from "./ConversationSection";
import { useAuth } from "@/components/auth/AuthProvider";

export default function TactShell() {

  const [section, setSection] = useState<TactSection>("conversation");

  const { user, signOut } = useAuth();

  return (

    <div className="flex h-screen w-full bg-white">

      <MenuBar active={section} onSelect={setSection} />

      <div className="flex min-w-0 flex-1 flex-col">

        <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-5">

          <span className="text-sm font-semibold text-gray-900">
            TACT
          </span>

          <div className="flex items-center gap-3">

            {user ? (

              <div className="flex items-center gap-2">
                <span
                  className="max-w-[160px] truncate text-xs text-gray-400"
                  title={user.email ?? undefined}
                >
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  ログアウト
                </button>
              </div>

            ) : (

              <a
                href="/login"
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                ログイン
              </a>

            )}

            <a
              href="/legacy"
              className="text-xs text-gray-400 hover:text-gray-600"
              title="旧TACT UI(複数Agent Workflow、Frozen Legacy)"
            >
              旧UIを見る
            </a>

          </div>

        </header>

        <div className="flex min-h-0 flex-1">

          {section === "research" && <ResearchSection />}
          {section === "core" && <CoreSection />}
          {section === "conversation" && <ConversationSection />}

        </div>

      </div>

    </div>

  );

}
