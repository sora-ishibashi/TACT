"use client";

// =========================
// MenuBar (STEP215、Phase74でConversationセクションを廃止)
// =========================
//
// 新TACT UIの左端ナビゲーション。将来のTACT派生機能
// (Meeting/Code/Bot/Design等)への導線を「構造として」用意するが、
// 今回実装するのはResearch/Coreの2セクションのみ(絶対条件:
// 未実装機能を無理に作らない)。無効項目はクリックできない
// 「coming soon」表示に留める。
//
// Phase74 Section3: Phase70で追加した"conversation"独立Sectionは廃止
// した。「Conversationをトップレベルの独立機能として扱わない」という
// Phase74の方針により、Conversation機能はResearch Workspace
// (ResearchWorkspace.tsx)内の中央パネルとして再配置されている
// (components/tact/ResearchWorkspace.tsx参照)。

export type TactSection = "research" | "core";

type NavItem = {
  id: TactSection | string;
  label: string;
  icon: string;
  enabled: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "research", label: "Research", icon: "🔍", enabled: true },
  { id: "core", label: "Core", icon: "🧠", enabled: true },
  { id: "meeting", label: "Meeting", icon: "🗓️", enabled: false },
  { id: "code", label: "Code", icon: "🛠️", enabled: false },
  { id: "bot", label: "Bot", icon: "💬", enabled: false },
  { id: "design", label: "Design", icon: "🎨", enabled: false },
];

type Props = {
  active: TactSection;
  onSelect: (section: TactSection) => void;
};

export default function MenuBar({
  active,
  onSelect,
}: Props) {

  return (

    <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-gray-200 bg-gray-50 py-4">

      <div className="mb-3 text-lg" title="TACT">
        ✳️
      </div>

      {NAV_ITEMS.map((item) => (

        <button
          key={item.id}
          type="button"
          disabled={!item.enabled}
          onClick={() => item.enabled && onSelect(item.id as TactSection)}
          title={item.enabled ? item.label : `${item.label}(準備中)`}
          className={`flex w-12 flex-col items-center gap-0.5 rounded-lg py-2 text-[10px] transition ${
            item.enabled
              ? active === item.id
                ? "bg-black text-white"
                : "text-gray-600 hover:bg-gray-200"
              : "cursor-not-allowed text-gray-300"
          }`}
        >
          <span className="text-base leading-none">{item.icon}</span>
          <span>{item.label}</span>
        </button>

      ))}

      <div className="mt-auto flex w-12 flex-col items-center gap-0.5 py-2 text-[9px] text-gray-300">
        v0
      </div>

    </nav>

  );

}
