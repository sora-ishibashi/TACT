"use client";

// =========================
// TactShell (STEP215、Phase74でResearch Workspaceへ再構成、UIレイアウト刷新で左サイドバー化)
// =========================
//
// 新TACT UIのトップレベル構造。app/page.tsxから描画される、
// 新TACTの既定(通常利用経路)の入口。
//
// 基本レイアウト(左サイドバー刷新):
//   - 上部ヘッダーは廃止し、TACTロゴ・プロダクト名・アカウント表示を
//     左の縦型サイドバー(コンパクト、w-44)へ統合した。これまでは
//     ヘッダー(h-12、横幅全体)にProductLauncherとアカウント表示が
//     分かれていたが、二重のブランディング・余白を減らし、
//     「TACTという一つの環境の中でResearchを使っている」構造が
//     伝わるようにするため。
//   - 左サイドバー上部: ProductLauncher(TACTアイコン+TACT文字ロゴ+
//     選択中プロダクト名を起点に、クリックでResearch/Core/Code等を
//     選べるdropdownが開く)。選択肢データ(NAV_ITEMS)・有効/無効
//     フラグ・遷移ロジック(onSelect)はMenuBar.tsx時代から変更していない。
//   - 左サイドバー下部: アカウント表示(email/ログアウト/ログイン/旧UI)。
//     以前ヘッダー右側にあったものをそのまま移設しただけで、機能は
//     変更していない。
//   - 中央: 選択中のプロダクト(ResearchWorkspace/CoreSection/CodeSection)が
//     サイドバー分を除いた全幅を使って表示される。
//
// 重要: このコンポーネント自体はcore/agents・core/workflow・
// core/planner・core/conversationのいずれにも依存しない
// (grep確認済み)。旧TACT(components/TactInterface.tsx等)は
// app/legacy/page.tsxへ退避済みで、削除していない。
//
// Phase72 Section3/6/7: 認証状態に応じたUI表示として、既存
// AuthProvider(STEP132)のuser/signOutを表示するだけの
// 最小Entry制御を追加した(新しいAuthentication Contextは作らない)。
//
// Phase74 Section3/16: 「Conversationをトップレベルの独立機能として
// 扱わない」方針により、Phase70で追加した独立"conversation"Sectionを
// 廃止し、Research Workspace(ResearchWorkspace.tsx、Project=Folder・
// Chat History・Conversation Panel・Research Result/Knowledge Panelを
// 統合)を既定表示Sectionとして復元した。ConversationSection.tsx自体は
// 削除していない(認証・エラー処理・メッセージ表示ロジックは
// ResearchWorkspace.tsxへ移植・再利用済み)。

import { useState } from "react";

import ProductLauncher, { TactSection } from "./ProductLauncher";
import ResearchWorkspace from "@/components/research/ResearchWorkspace";
import CoreSection from "./CoreSection";
import CodeSection from "./CodeSection";
import { useAuth } from "@/components/auth/AuthProvider";

export default function TactShell() {

  const [section, setSection] = useState<TactSection>("research");

  const { user, signOut } = useAuth();

  return (

    <div className="flex h-screen w-full bg-white">

      {/* 左: コンパクトなサイドバー(TACTブランド+プロダクト切替+アカウント) */}
      <aside className={`flex h-full w-44 shrink-0 flex-col justify-between border-r border-[#D9D9D9] bg-white px-2 py-3 ${
        section === "research" ? "hidden" : ""
      }`}>

        <ProductLauncher active={section} onSelect={setSection} />

        <div className="flex flex-col items-start gap-1.5 px-1 pb-1">

          {user ? (

            <>
              <span
                className="max-w-full truncate text-xs text-[#626161]"
                title={user.email ?? undefined}
              >
                {user.email}
              </span>
              <button
                type="button"
                onClick={() => signOut()}
                className="text-xs text-[#626161] transition duration-150 ease-out hover:text-[#112278]"
              >
                ログアウト
              </button>
            </>

          ) : (

            <a
              href="/login"
              className="text-xs text-[#626161] transition duration-150 ease-out hover:text-[#112278]"
            >
              ログイン
            </a>

          )}

          <a
            href="/legacy"
            className="text-xs text-[#8A8A8A] transition duration-150 ease-out hover:text-[#626161]"
            title="旧TACT UI(複数Agent Workflow、Frozen Legacy)"
          >
            旧UIを見る
          </a>

        </div>

      </aside>

      <div className="flex min-h-0 flex-1">

        {section === "research" && (
          <ResearchWorkspace
            activeSection={section}
            onSelectSection={setSection}
          />
        )}
        {section === "core" && <CoreSection />}
        {section === "code" && <CodeSection />}

      </div>

    </div>

  );

}
