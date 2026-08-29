// =========================
// canvasConstants (TACT Design: PowerPoint資料編集基盤)
// =========================
//
// CanvasEditor(直接編集用の固定サイズCanvas)とpptxExport
// (px → inch変換)が共有する、スライド1枚分のピクセルサイズ。
//
// 96px = 1inch(CSSの標準px-per-inch)を基準に、PowerPointの標準的な
// 16:9レイアウト(pptxgenjsの既定LAYOUT_16x9 = 10 x 5.625inch)と
// ちょうど一致する960x540pxを採用する。
//
// 既存DocumentRenderer.tsx(読み取り専用、STEP47〜)のPAGE_WIDTH=680は
// 「レポートを読みやすく表示する」ための値であり、実際のPowerPoint
// スライド寸法とは無関係(コンテンツ量に応じて高さが伸縮する設計)。
// CanvasEditorは実際のスライド1枚を表す固定サイズのCanvasのため、
// 意図的に別の値を使う(既存DocumentRendererの値は変更しない)。

export const SLIDE_WIDTH_PX = 960;
export const SLIDE_HEIGHT_PX = 540;

export const PX_PER_INCH = 96;

export function pxToInch(px: number): number {
  return px / PX_PER_INCH;
}
