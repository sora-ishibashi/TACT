"use client";

// =========================
// FloatingAIButton (STEP42 / TACT Design)
// =========================
//
// 資料編集画面の上に常時浮かぶ、小さなAI呼び出しボタン。
// 「Claude Codeのデザイン版」という距離感を目指し、
// ・常時画面を占有しない
// ・ドラッグで自由に動かせる
// ・クリックでAI Panelの開閉を切り替える
// ・画面外へ完全にはみ出さない
// ことだけを担う。アイコンデザインは今回作り込まず、
// 差し替えやすいよう1箇所(BUTTON_ICON)にまとめている。
//
// 初期位置はCSS(Tailwindのbottom/right)に任せ、windowサイズに
// 依存する計算はドラッグ開始時にだけ行う(useDraggable.ts参照。
// Hydration Mismatch回避のため)。

import { useDraggable } from "./useDraggable";

export const BUTTON_SIZE = 56;

// 後からアイコンデザインを差し替えやすいよう、絵文字1つに
// 留めている(本格的なロゴ・アイコンはTACT Design側の
// 将来のデザインタスクとする)。
const BUTTON_ICON = "✨";

type Props = {
  isOpen: boolean;
  onToggle: () => void;
};

export default function FloatingAIButton({
  isOpen,
  onToggle,
}: Props) {

  const {
    position,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = useDraggable(null, {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
  });

  function handlePointerUp(e: React.PointerEvent) {

    const wasDrag = onPointerUp(e);

    // ドラッグ操作ではなく、その場でのクリックだった場合のみ
    // パネルの開閉を切り替える。
    if (!wasDrag) {
      onToggle();
    }

  }

  return (

    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={handlePointerUp}
      aria-label={
        isOpen ? "TACT Designパネルを閉じる" : "TACT Designを開く"
      }
      style={{
        position: "fixed",
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        // STEP42: パネルより手前、他の全UIより前面に表示する。
        zIndex: 2147483000,
        touchAction: "none",
        ...(position
          ? { left: position.x, top: position.y }
          : {}),
      }}
      className={
        "flex items-center justify-center rounded-full text-2xl shadow-lg " +
        "transition-transform hover:scale-105 active:scale-95 " +
        "cursor-grab active:cursor-grabbing select-none " +
        (position ? "" : "bottom-6 right-6") +
        " " +
        (isOpen
          ? "bg-gray-900 text-white ring-2 ring-white"
          : "bg-white text-gray-800 ring-1 ring-gray-200")
      }
    >
      {BUTTON_ICON}
    </button>

  );

}
