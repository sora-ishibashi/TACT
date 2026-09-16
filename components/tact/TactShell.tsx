"use client";

// TACTのグローバルシェル。TactSidebarが全プロダクトのナビゲーションと
// アカウント操作を提供し、このコンポーネントが選択中のセクションを表示する。
// ResearchWorkspaceは、ここで選ばれたResearchセクションのローカルな
// プロジェクト・履歴・会話・成果物だけを管理する。

import { useEffect, useState } from "react";

import ResearchWorkspace from "@/components/research/ResearchWorkspace";
import CoreSection from "./CoreSection";
import CodeSection from "./CodeSection";
import SettingsPreview from "./settings/SettingsPreview";
import HomeSection from "./preview/HomeSection";
import TactSidebar, { type TactNavigationItemId } from "./navigation/TactSidebar";
import { useAuth } from "@/components/auth/AuthProvider";

type TactSection = "home" | "research" | "core" | "code" | "settings";

const sectionForNavigationItem: Record<TactNavigationItemId, TactSection> = {
  home: "home",
  works: "home",
  approvals: "home",
  connections: "settings",
  research: "research",
  core: "core",
  code: "code",
  settings: "settings",
};

export default function TactShell() {

  const [section, setSection] = useState<TactSection>("home");
  const [activeNavigationItem, setActiveNavigationItem] = useState<TactNavigationItemId>("home");

  const { user, signOut } = useAuth();

  // PRODUCT-P1(Connection UX、OAuth Return Flow): Connection
  // Provisioning API(app/api/tact/connections/route.ts)がOAuth完了後の
  // callbackUrlとして"?section=settings"を指定する(core/tact-integration/
  // provisioning.tsが実際のconnectionId query paramを追加する)。
  // ここではsection切り替えの判断材料としてsection paramだけを読む
  // ——connectionId自体の読み取り・confirm実行はComponentsPanel.tsx
  // (ConnectionsPanel.tsx)自身の責務のまま(絶対条件: このfileへ
  // Connection業務ロジックを持ち込まない)。
  useEffect(() => {

    function applySectionFromReturnUrl() {

      if (typeof window === "undefined") {
        return;
      }

      const params = new URLSearchParams(window.location.search);

      if (params.get("section") === "settings") {
        setSection("settings");
        setActiveNavigationItem("settings");
      }

    }

    applySectionFromReturnUrl();

  }, []);

  const selectNavigationItem = (item: TactNavigationItemId) => {
    setActiveNavigationItem(item);
    setSection(sectionForNavigationItem[item]);
  };

  const homeMode = activeNavigationItem === "works" || activeNavigationItem === "approvals"
    ? activeNavigationItem
    : "home";

  return (

    <div className="flex h-screen min-w-0 w-full bg-white">

      <TactSidebar
        activeItem={activeNavigationItem}
        onSelect={selectNavigationItem}
        userEmail={user?.email}
        onSignOut={signOut}
      />

      <div className="flex min-h-0 flex-1">

        {section === "research" && <ResearchWorkspace />}
        {section === "home" && <HomeSection key={activeNavigationItem} mode={homeMode} />}
        {section === "core" && <CoreSection />}
        {section === "code" && <CodeSection />}
        {section === "settings" && (
          <SettingsPreview
            key={activeNavigationItem}
            initialCategory={activeNavigationItem === "connections" ? "connections" : "general"}
          />
        )}

      </div>

    </div>

  );

}
