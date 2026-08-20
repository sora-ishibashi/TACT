"use client";

// =========================
// useDraggable (STEP42 / TACT Design)
// =========================
//
// TACT Designの Floating AI Button / AI Panel が共通で必要とする
// 「ドラッグで自由に動かせる、かつ画面外へ完全にはみ出さない」
// 挙動をまとめた小さなフック。ウィンドウマネージャーのような
// 高度な機能(スナップ・複数ウィンドウの重なり管理等)は持たない、
// 最小限の実装に留める。
//
// TACT本体(core/・既存components/)には一切依存しない
// (TACT DesignはTACTから独立したUIとして実装するため)。
//
// 初期位置の扱いについて(重要):
// initial に null を渡すと、「JSでは位置を制御しない(CSSの
// 既定位置に任せる)」状態になる。これは、windowサイズに依存する
// 初期位置をuseEffect+setStateで計算するとHydration Mismatch/
// このプロジェクトのeslint(react-hooks/set-state-in-effect)に
// 抵触するための回避策。実際にドラッグが始まった瞬間
// (=クライアント側でのみ発生するイベント)に、要素の実際の
// 描画位置(getBoundingClientRect)を読み取ってJS制御へ切り替える。
// これによりwindowへ一切依存しない、SSR安全な初期描画を保てる。

import { useCallback, useEffect, useRef, useState } from "react";

export interface Position {
  x: number;
  y: number;
}

interface ElementSize {
  width: number;
  height: number;
}

// 画面外へドラッグしても、要素の一部(このpx数)は必ず画面内に
// 残るようにする。
const MIN_VISIBLE_PX = 48;

function clampPosition(
  pos: Position,
  size: ElementSize
): Position {

  if (typeof window === "undefined") return pos;

  const maxX = window.innerWidth - MIN_VISIBLE_PX;
  const maxY = window.innerHeight - MIN_VISIBLE_PX;

  const minX = -(size.width - MIN_VISIBLE_PX);
  const minY = -(size.height - MIN_VISIBLE_PX);

  return {
    x: Math.min(Math.max(pos.x, minX), maxX),
    y: Math.min(Math.max(pos.y, minY), maxY),
  };

}

export function useDraggable(
  initial: Position | null,
  size: ElementSize
) {

  const [position, setPosition] =
    useState<Position | null>(initial);

  const draggingRef = useRef(false);
  const offsetRef = useRef<Position>({ x: 0, y: 0 });
  // クリックとドラッグを区別するため、ポインタの総移動量を記録する。
  const movedRef = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {

      draggingRef.current = true;
      movedRef.current = 0;

      // 初回ドラッグ時(position === null)は、要素の実際の描画位置
      // (CSSの既定位置)から出発する。以降はJS制御の座標を使う。
      const currentPos =
        position ??
        (() => {

          const rect =
            (e.currentTarget as HTMLElement).getBoundingClientRect();

          return { x: rect.left, y: rect.top };

        })();

      offsetRef.current = {
        x: e.clientX - currentPos.x,
        y: e.clientY - currentPos.y,
      };

      if (position === null) {
        setPosition(currentPos);
      }

      (e.currentTarget as Element).setPointerCapture(e.pointerId);

    },
    [position]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {

      if (!draggingRef.current) return;

      const next = {
        x: e.clientX - offsetRef.current.x,
        y: e.clientY - offsetRef.current.y,
      };

      movedRef.current +=
        Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);

      setPosition(clampPosition(next, size));

    },
    [size]
  );

  // 呼び出し側が「これはドラッグだったか、単なるクリックだったか」を
  // 判定できるよう、release時に真偽値を返す。
  const onPointerUp = useCallback(
    (e: React.PointerEvent): boolean => {

      draggingRef.current = false;

      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // ブラウザによってはreleasePointerCaptureが失敗することがあるが、
        // ドラッグ自体の動作には影響しないため無視する。
      }

      return movedRef.current > 4;

    },
    []
  );

  // STEP42要件: ブラウザリサイズ時の位置補正。
  // JS制御下(position !== null)になっている場合のみ再クランプする
  // (CSS任せの間はCSS自体が画面内に収まる前提のため不要)。
  useEffect(() => {

    function handleResize() {

      setPosition((prev) =>
        prev === null ? prev : clampPosition(prev, size)
      );

    }

    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);

  }, [size]);

  return {
    position,
    setPosition,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };

}
