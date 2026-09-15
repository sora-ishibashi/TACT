"use client";

import type { LucideIcon } from "lucide-react";

type Props = {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed?: boolean;
  onSelect: (id: string) => void;
};

export default function TactSidebarItem({
  id,
  label,
  icon: Icon,
  active,
  collapsed = false,
  onSelect,
}: Props) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={`flex h-9 w-full items-center rounded-[6px] text-left text-[13px] font-medium leading-[18px] transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${
        collapsed ? "justify-center px-2" : "gap-2 px-3"
      } ${
        active ? "bg-[#E6F2F2] text-[#172E95]" : "text-[#112278] hover:bg-[#E6F2F2]"
      }`}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={2} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
}
