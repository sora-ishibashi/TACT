"use client";

// =========================
// ProductLauncher (Phase: Research UI再設計、MenuBar.tsxを置き換え → UIレイアウト刷新でサイドバー用ブランド表示へ)
// =========================
//
// 背景: これまでMenuBar.tsxが左端に常時表示される縦型プロダクト一覧
// (Research/Core/Code/Meeting/Bot/Design)を描画していたが、これにより
// 「TACTの中でResearchを開いている」という階層感がなく、TACTとResearchが
// 常に二重に見え、かつ左端の縦バーがスペースを取りすぎていた。
//
// 変更: 左端の常時表示ナビゲーションを廃止し、「TACT」をプロダクト
// ランチャー(クリックでResearch/Core/Code等を選べるドロップダウン)として
// 扱う。選択肢のデータ(NAV_ITEMS)・有効/無効フラグ・遷移ロジック
// (onSelect)は元のMenuBar.tsxから変更していない。
//
// 通常時はメニューが閉じているため、選択中のUI(例: Research)がレイアウトの
// ほぼ全幅を使える。
//
// UIレイアウト刷新(TactShellのヘッダー廃止・左サイドバー化): これまでは
// ヘッダー左上に横並びで表示していたが、TactShell側の左サイドバーに
// 組み込むため、縦積みのブランド表示に変更した。
//   [TACTアイコン] TACT(文字ロゴ画像)
//                  Research(選択中プロダクト名、小さく・薄く)
// 「TACTロゴ」(public/brand/tact-icon.svg、アイコン/シンボルマーク)と
// 「TACT文字ロゴ」(public/brand/tact-logo.svg、「TACT」のワードマーク画像、
// 元々あった素材)の2つの正式ブランド素材をどちらも使う。文字ロゴが既に
// 「TACT」の文字を表現しているため、隣に重ねてテキストの「TACT」は
// 表示しない。選択中プロダクト名(Research等)はブランド名(TACT)より
// 小さく・薄い色でその下に表示し、「TACTという環境の中でResearchを
// 使っている」という階層が伝わるようにする。スラッシュ区切りの二重表記や
// 絵文字・仮アイコンは使わない。各プロダクトを表す虫眼鏡・脳・工具などの
// フリー絵文字アイコン(旧NAV_ITEMS.icon)も、プロダクト用の正式ロゴでは
// ないため引き続き使わず、ドロップダウン内はプロダクト名のテキストのみで
// 表現する。

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type TactSection = "research" | "core" | "code";

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
