"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  Boxes, ChevronLeft, ChevronRight, ClipboardList, Code2, FolderSearch,
  House, LogIn, LogOut, Menu, Plug, Settings, ShieldCheck, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import TactSidebarItem from "./TactSidebarItem";

const DEFAULT_EXPANDED_WIDTH = 224;
const MIN_EXPANDED_WIDTH = 200;
const MAX_EXPANDED_WIDTH = 360;
const COLLAPSED_WIDTH = 64;
const SIDEBAR_WIDTH_STORAGE_KEY = "tact.sidebar.width";

export type TactNavigationItemId =
  | "home" | "works" | "approvals" | "connections" | "research" | "core" | "code" | "settings";

type NavigationItem = { id: TactNavigationItemId; label: string; icon: LucideIcon };

const primaryItems: readonly NavigationItem[] = [
  { id: "home", label: "ホーム", icon: House },
  { id: "works", label: "ワーク", icon: ClipboardList },
  { id: "approvals", label: "承認", icon: ShieldCheck },
  { id: "connections", label: "接続", icon: Plug },
];

const workspaceItems: readonly NavigationItem[] = [
  { id: "research", label: "リサーチ", icon: FolderSearch },
  { id: "core", label: "コア", icon: Boxes },
  { id: "code", label: "コード", icon: Code2 },
];

const settingsItem: NavigationItem = { id: "settings", label: "設定", icon: Settings };

type Props = {
  activeItem: TactNavigationItemId;
  onSelect: (item: TactNavigationItemId) => void;
  userEmail?: string | null;
  onSignOut: () => void | Promise<void>;
};

function clampExpandedWidth(width: number): number {
  return Math.min(MAX_EXPANDED_WIDTH, Math.max(MIN_EXPANDED_WIDTH, width));
}

function NavigationList({ activeItem, collapsed = false, onSelect }: Pick<Props, "activeItem" | "onSelect"> & { collapsed?: boolean }) {
  const renderItem = (item: NavigationItem) => (
    <TactSidebarItem key={item.id} {...item} active={activeItem === item.id} collapsed={collapsed} onSelect={(id) => onSelect(id as TactNavigationItemId)} />
  );

  return (
    <nav aria-label="TACT ナビゲーション" className="space-y-1">
      <div className="space-y-1">{primaryItems.map(renderItem)}</div>
      <div className="my-3 border-t border-[#D9D9D9]" />
      <div className="space-y-1">{workspaceItems.map(renderItem)}</div>
      <div className="my-3 border-t border-[#D9D9D9]" />
      {renderItem(settingsItem)}
    </nav>
  );
}

function AccountArea({ collapsed = false, userEmail, onSignOut }: Pick<Props, "userEmail" | "onSignOut"> & { collapsed?: boolean }) {
  if (!userEmail) {
    return (
      <a href="/login" className={`rounded-[6px] text-xs text-[#626161] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${collapsed ? "flex h-9 items-center justify-center px-2" : "block px-3 py-2"}`} aria-label={collapsed ? "ログイン" : undefined} title={collapsed ? "ログイン" : undefined}>
        {collapsed ? <LogIn aria-hidden="true" size={16} /> : "ログイン"}
      </a>
    );
  }

  return (
    <div className={collapsed ? "flex justify-center" : "px-3"}>
      {!collapsed && <p className="truncate text-xs text-[#626161]" title={userEmail}>{userEmail}</p>}
      <button type="button" onClick={() => void onSignOut()} className={`mt-1 text-xs text-[#626161] transition-colors duration-150 ease-out hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${collapsed ? "h-8 w-8 rounded-[6px]" : "rounded-[2px]"}`} aria-label={collapsed ? "ログアウト" : undefined} title={collapsed ? "ログアウト" : undefined}>
        {collapsed ? <LogOut aria-hidden="true" size={16} /> : "ログアウト"}
      </button>
    </div>
  );
}

export default function TactSidebar({ activeItem, onSelect, userEmail, onSignOut }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(DEFAULT_EXPANDED_WIDTH);
  const [widthLoaded, setWidthLoaded] = useState(false);
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: DEFAULT_EXPANDED_WIDTH });

  useEffect(() => {
    const restoreWidth = window.setTimeout(() => {
      try {
        const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
        if (Number.isFinite(savedWidth)) setExpandedWidth(clampExpandedWidth(savedWidth));
      } catch {
        // Local storage can be unavailable in private or restricted browser contexts.
      } finally {
        setWidthLoaded(true);
      }
    }, 0);

    return () => window.clearTimeout(restoreWidth);
  }, []);

  useEffect(() => {
    if (!widthLoaded) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(expandedWidth));
    } catch {
      // Width persistence is optional and must never prevent navigation.
    }
  }, [expandedWidth, widthLoaded]);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  useEffect(() => {
    if (!resizing) return;
    const previousUserSelect = document.body.style.userSelect;
    const updateWidth = (event: PointerEvent) => {
      setExpandedWidth(clampExpandedWidth(resizeStartRef.current.width + event.clientX - resizeStartRef.current.x));
    };
    const finishResize = () => setResizing(false);

    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", updateWidth);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", updateWidth);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
    };
  }, [resizing]);

  const selectFromMobile = (item: TactNavigationItemId) => {
    onSelect(item);
    setMobileOpen(false);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    resizeStartRef.current = { x: event.clientX, width: expandedWidth };
    setResizing(true);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setExpandedWidth((width) => clampExpandedWidth(width - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setExpandedWidth((width) => clampExpandedWidth(width + step));
    } else if (event.key === "Home") {
      event.preventDefault();
      setExpandedWidth(MIN_EXPANDED_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setExpandedWidth(MAX_EXPANDED_WIDTH);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setMobileOpen(true)} aria-controls="tact-mobile-navigation" aria-expanded={mobileOpen} aria-label="TACT ナビゲーションを開く" className="fixed right-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-[6px] border border-[#D9D9D9] bg-white text-[#112278] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] lg:hidden">
        <Menu aria-hidden="true" size={19} strokeWidth={2} />
      </button>

      <aside id="tact-desktop-navigation" aria-label="TACT ナビゲーション" style={{ width: collapsed ? COLLAPSED_WIDTH : expandedWidth }} className={`relative hidden h-full shrink-0 flex-col border-r border-[#D9D9D9] bg-white py-3 ${resizing ? "" : "transition-[width] duration-150 ease-out"} lg:flex`}>
        <div className={`flex px-2 ${collapsed ? "flex-col items-center gap-2" : "h-10 items-center justify-between"}`}>
          <div className={`flex min-w-0 items-center ${collapsed ? "justify-center" : "gap-2"}`}>
            <Image src="/brand/tact-icon.svg" alt="TACT" width={32} height={32} className="h-8 w-8 shrink-0" unoptimized />
            {!collapsed && <Image src="/brand/tact-logo.svg" alt="tact" width={58} height={22} className="h-5 w-auto" unoptimized />}
          </div>
          <button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"} title={collapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-[#626161] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]">
            {collapsed ? <ChevronRight aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={18} />}
          </button>
        </div>
        <div className={`flex-1 ${collapsed ? "mt-4 px-2" : "mt-5 px-2"}`}>
          <NavigationList activeItem={activeItem} collapsed={collapsed} onSelect={onSelect} />
        </div>
        <div className="border-t border-[#D9D9D9] pt-2"><AccountArea collapsed={collapsed} userEmail={userEmail} onSignOut={onSignOut} /></div>
        {!collapsed && (
          <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label="サイドバーの幅を調整" aria-controls="tact-desktop-navigation" aria-valuemin={MIN_EXPANDED_WIDTH} aria-valuemax={MAX_EXPANDED_WIDTH} aria-valuenow={expandedWidth} aria-valuetext={`${expandedWidth}px`} onPointerDown={startResize} onKeyDown={resizeWithKeyboard} className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize touch-none bg-transparent outline-none transition-[width,background-color] hover:w-1.5 hover:bg-[#18B5A6] focus:w-1.5 focus:bg-[#18B5A6]" />
        )}
      </aside>

      {mobileOpen && (
        <>
          <button type="button" aria-label="TACT ナビゲーションを閉じる" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-black/30 lg:hidden" />
          <aside id="tact-mobile-navigation" role="dialog" aria-modal="true" aria-label="TACT ナビゲーション" className="fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[calc(100vw-2rem)] flex-col border-r border-[#D9D9D9] bg-white px-3 py-3 shadow-[0_4px_16px_rgba(17,34,120,0.12)] lg:hidden">
            <div className="flex h-10 items-center justify-between px-1"><div className="flex items-center gap-2"><Image src="/brand/tact-icon.svg" alt="TACT" width={32} height={32} className="h-8 w-8" unoptimized /><Image src="/brand/tact-logo.svg" alt="tact" width={58} height={22} className="h-5 w-auto" unoptimized /></div><button type="button" onClick={() => setMobileOpen(false)} aria-label="TACT ナビゲーションを閉じる" className="flex h-9 w-9 items-center justify-center rounded-[6px] text-[#626161] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"><X aria-hidden="true" size={19} strokeWidth={2} /></button></div>
            <div className="mt-5 flex-1"><NavigationList activeItem={activeItem} onSelect={selectFromMobile} /></div>
            <div className="border-t border-[#D9D9D9] pt-2"><AccountArea userEmail={userEmail} onSignOut={onSignOut} /></div>
          </aside>
        </>
      )}
    </>
  );
}
