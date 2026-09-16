"use client";

export const SETTINGS_CATEGORIES = [
  { id: "general", label: "General" },
  { id: "scheduling", label: "Scheduling" },
  { id: "connections", label: "Connections" },
  { id: "notifications", label: "Notifications" },
  { id: "workspace", label: "Data & Workspace" },
  { id: "security", label: "Security" },
  { id: "advanced", label: "Advanced" },
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];

type Props = {
  active: SettingsCategory;
  onSelect: (category: SettingsCategory) => void;
};

export default function SettingsNav({ active, onSelect }: Props) {
  return (
    <nav aria-label="Settings categories" className="space-y-1">
      {SETTINGS_CATEGORIES.map((category) => (
        <button
          key={category.id}
          type="button"
          onClick={() => onSelect(category.id)}
          aria-current={active === category.id ? "page" : undefined}
          className={`flex h-9 w-full items-center rounded-[6px] px-3 text-left text-[13px] font-medium leading-[18px] transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-[#18B5A6] ${
            active === category.id
              ? "bg-[#E6F2F2] text-[#172E95]"
              : "text-[#112278] hover:bg-[#E6F2F2]"
          }`}
        >
          {category.label}
        </button>
      ))}
    </nav>
  );
}
