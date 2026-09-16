"use client";

// Legacy compatibility component for older entry points. The current TACT shell
// uses TactSidebar as its sole global navigation and does not mount this component.

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type TactSection = "home" | "research" | "core" | "code" | "settings";

type NavItem = {
  id: TactSection | string;
  label: string;
  enabled: boolean;
};

const TACT_ICON_SRC = "/brand/tact-icon.svg";
const TACT_WORDMARK_SRC = "/brand/tact-logo.svg";

const NAV_ITEMS: NavItem[] = [
  { id: "research", label: "Research", enabled: true },
  { id: "core", label: "Core", enabled: true },
  { id: "code", label: "Code", enabled: true },
  // PRODUCT-P1: Connection UX(Gmail/Slack管理)。
  { id: "settings", label: "設定", enabled: true },
  { id: "meeting", label: "Meeting", enabled: false },
  { id: "bot", label: "Bot", enabled: false },
  { id: "design", label: "Design", enabled: false },
];

type Props = {
  active: TactSection;
  onSelect: (section: TactSection) => void;
};

export default function ProductLauncher({ active, onSelect }: Props) {

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // メニュー外クリック・Escapeで閉じる(素朴なdropdown、新しいUIライブラリは追加しない)
  useEffect(() => {

    if (!open) {
      return;
    }

    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };

  }, [open]);

  const activeItem = NAV_ITEMS.find((item) => item.id === active);

  return (

    <div ref={containerRef} className="relative w-full">

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1 transition duration-150 ease-out hover:bg-[#E6F2F2]"
      >
        <Image
          src={TACT_ICON_SRC}
          alt=""
          width={48}
          height={48}
          className="h-10 w-10 shrink-0"
          unoptimized
        />

<span className="flex min-w-0 flex-1 flex-nowrap items-center gap-2">
  <Image
    src={TACT_WORDMARK_SRC}
    alt="tact"
    width={58}
    height={22}
    className="h-5 w-auto shrink-0"
    unoptimized
  />

  {activeItem && (
    <span className="ml-1 truncate text-[13px] font-medium leading-[18px] text-[#8A8A8A]">
      {activeItem.label}
    </span>
  )}
</span>
        <ChevronDown
          aria-hidden="true"
          className={`shrink-0 text-[#626161] transition-transform duration-150 ease-out ${open ? "rotate-180" : ""}`}
          size={16}
          strokeWidth={2}
        />
      </button>

      {open && (

        <div
          role="menu"
          className="absolute left-0 top-full z-[60] mt-1 w-48 overflow-hidden rounded-xl border border-[#D9D9D9] bg-white py-1 shadow-[0_4px_16px_rgba(17,34,120,0.12)] transition duration-150 ease-out"
        >

          {NAV_ITEMS.map((item) => (

            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={!item.enabled}
              onClick={() => {
                if (!item.enabled) {
                  return;
                }
                onSelect(item.id as TactSection);
                setOpen(false);
              }}
              title={item.enabled ? item.label : `${item.label}(準備中)`}
              className={`flex h-8 w-full items-center gap-2 rounded-[10px] px-3 text-left text-[13px] leading-[18px] transition duration-150 ease-out ${
                item.enabled
                  ? active === item.id
                    ? "bg-[#E6F2F2] font-medium text-[#172E95]"
                    : "text-[#112278] hover:bg-[#E6F2F2]"
                  : "cursor-not-allowed bg-[#F2F2F2] text-[#8A8A8A]"
              }`}
            >
              <span className="flex-1">{item.label}</span>
              {!item.enabled && (
                <span className="text-[10px] text-[#8A8A8A]">準備中</span>
              )}
            </button>

          ))}

        </div>

      )}

    </div>

  );

}
