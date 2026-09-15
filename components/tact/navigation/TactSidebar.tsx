"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Code2,
  FolderSearch,
  House,
  LogIn,
  LogOut,
  Menu,
  Plug,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import TactSidebarItem from "./TactSidebarItem";

export type TactNavigationItemId =
  | "home"
  | "works"
  | "approvals"
  | "connections"
  | "research"
  | "core"
  | "code"
  | "settings";

type NavigationItem = {
  id: TactNavigationItemId;
  label: string;
  icon: LucideIcon;
};

const primaryItems: readonly NavigationItem[] = [
  { id: "home", label: "Home", icon: House },
  { id: "works", label: "Works", icon: ClipboardList },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "connections", label: "Connections", icon: Plug },
];

const workspaceItems: readonly NavigationItem[] = [
  { id: "research", label: "Research", icon: FolderSearch },
  { id: "core", label: "Core", icon: Boxes },
  { id: "code", label: "Code", icon: Code2 },
];

const settingsItem: NavigationItem = { id: "settings", label: "Settings", icon: Settings };

type Props = {
  activeItem: TactNavigationItemId;
  onSelect: (item: TactNavigationItemId) => void;
  userEmail?: string | null;
  onSignOut: () => void | Promise<void>;
};

function NavigationList({
  activeItem,
  collapsed = false,
  onSelect,
}: Pick<Props, "activeItem" | "onSelect"> & { collapsed?: boolean }) {
  const renderItem = (item: NavigationItem) => (
    <TactSidebarItem
      key={item.id}
      {...item}
      active={activeItem === item.id}
      collapsed={collapsed}
      onSelect={(id) => onSelect(id as TactNavigationItemId)}
    />
  );

  return (
    <nav aria-label="TACT navigation" className="space-y-1">
      <div className="space-y-1">{primaryItems.map(renderItem)}</div>
      <div className="my-3 border-t border-[#D9D9D9]" />
      <div className="space-y-1">{workspaceItems.map(renderItem)}</div>
      <div className="my-3 border-t border-[#D9D9D9]" />
      {renderItem(settingsItem)}
    </nav>
  );
}

function AccountArea({
  collapsed = false,
  userEmail,
  onSignOut,
}: Pick<Props, "userEmail" | "onSignOut"> & { collapsed?: boolean }) {
  if (!userEmail) {
    return (
      <a
        href="/login"
        className={`rounded-[6px] text-xs text-[#626161] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${
          collapsed ? "flex h-9 items-center justify-center px-2" : "block px-3 py-2"
        }`}
        aria-label={collapsed ? "Log in" : undefined}
        title={collapsed ? "Log in" : undefined}
      >
        {collapsed ? <LogIn aria-hidden="true" size={16} /> : "Log in"}
      </a>
    );
  }

  return (
    <div className={collapsed ? "flex justify-center" : "px-3"}>
      {!collapsed && <p className="truncate text-xs text-[#626161]" title={userEmail}>{userEmail}</p>}
      <button
        type="button"
        onClick={() => void onSignOut()}
        className={`mt-1 text-xs text-[#626161] transition-colors duration-150 ease-out hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${
          collapsed ? "h-8 w-8 rounded-[6px]" : "rounded-[2px]"
        }`}
        aria-label={collapsed ? "Log out" : undefined}
        title={collapsed ? "Log out" : undefined}
      >
        {collapsed ? <LogOut aria-hidden="true" size={16} /> : "Log out"}
      </button>
    </div>
  );
}

export default function TactSidebar({ activeItem, onSelect, userEmail, onSignOut }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  const selectFromMobile = (item: TactNavigationItemId) => {
    onSelect(item);
    setMobileOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-controls="tact-mobile-navigation"
        aria-expanded={mobileOpen}
        aria-label="Open TACT navigation"
        className="fixed right-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-[6px] border border-[#D9D9D9] bg-white text-[#112278] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] focus:outline-none focus:ring-2 focus:ring-[#18B5A6] lg:hidden"
      >
        <Menu aria-hidden="true" size={19} strokeWidth={2} />
      </button>

      <aside
        aria-label="TACT navigation"
        className={`hidden h-full shrink-0 flex-col border-r border-[#D9D9D9] bg-white py-3 transition-[width] duration-150 ease-out lg:flex ${
          collapsed ? "w-16 px-2" : "w-56 px-2"
        }`}
      >
        <div className={`flex h-10 items-center ${collapsed ? "justify-center" : "gap-2 px-2"}`}>
          <Image src="/brand/tact-icon.svg" alt="TACT" width={32} height={32} className="h-8 w-8 shrink-0" unoptimized />
          {!collapsed && <Image src="/brand/tact-logo.svg" alt="tact" width={58} height={22} className="h-5 w-auto" unoptimized />}
        </div>
        <div className="mt-5 flex-1">
          <NavigationList activeItem={activeItem} collapsed={collapsed} onSelect={onSelect} />
        </div>
        <div className="border-t border-[#D9D9D9] pt-2">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex h-9 w-full items-center justify-center rounded-[6px] text-[#626161] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]"
          >
            {collapsed ? <ChevronRight aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={18} />}
          </button>
          <div className="mt-2 border-t border-[#D9D9D9] pt-2">
            <AccountArea collapsed={collapsed} userEmail={userEmail} onSignOut={onSignOut} />
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <>
          <button type="button" aria-label="Close TACT navigation" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-black/30 lg:hidden" />
          <aside id="tact-mobile-navigation" role="dialog" aria-modal="true" aria-label="TACT navigation" className="fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[calc(100vw-2rem)] flex-col border-r border-[#D9D9D9] bg-white px-3 py-3 shadow-[0_4px_16px_rgba(17,34,120,0.12)] lg:hidden">
            <div className="flex h-10 items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Image src="/brand/tact-icon.svg" alt="TACT" width={32} height={32} className="h-8 w-8" unoptimized />
                <Image src="/brand/tact-logo.svg" alt="tact" width={58} height={22} className="h-5 w-auto" unoptimized />
              </div>
              <button type="button" onClick={() => setMobileOpen(false)} aria-label="Close TACT navigation" className="flex h-9 w-9 items-center justify-center rounded-[6px] text-[#626161] transition-colors duration-150 ease-out hover:bg-[#E6F2F2] hover:text-[#112278] focus:outline-none focus:ring-2 focus:ring-[#18B5A6]">
                <X aria-hidden="true" size={19} strokeWidth={2} />
              </button>
            </div>
            <div className="mt-5 flex-1">
              <NavigationList activeItem={activeItem} onSelect={selectFromMobile} />
            </div>
            <div className="border-t border-[#D9D9D9] pt-2">
              <AccountArea userEmail={userEmail} onSignOut={onSignOut} />
            </div>
          </aside>
        </>
      )}
    </>
  );
}
