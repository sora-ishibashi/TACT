// =========================
// mockAssetLibrary (STEP140)
// =========================
//
// 外部API接続(Canva Connect API / Microsoft Graph等)より前に、
// 「PowerPoint/Canvaに既に存在する素材をTACTが参照できた」という
// 状態だけをローカルでシミュレーションするためのMockデータ。
//
// 重要: これは新しい画像・イラスト・写真素材を生成するものでは
// ない。あくまで「ユーザーが既に持っている素材が、将来こういう形の
// AssetReferenceとしてTACTから見えるはずだ」という参照情報の例示
// であり、画像バイナリ・実際のプレビュー画像は一切含まない
// (previewはthumbnailUrl省略=DocumentRendererがテキストラベルで
// 代替表示する)。
//
// 外部API接続後は、この配列を実際のCanva Connect API /
// Microsoft Graph APIからの取得結果に差し替える想定。

import { AssetReference } from "./types";

export const mockAssets: AssetReference[] = [

  {
    id: "asset-001",
    source: "canva",
    type: "logo",
    sourceReference: {
      canvaDesignId: "DAF-mock-001",
      canvaAssetId: "canva-asset-logo-001",
    },
    metadata: {
      title: "会社ロゴ（ブルー版）",
      tags: ["ロゴ", "logo", "会社", "ブランド"],
      dimensions: { width: 512, height: 512 },
      extractedText: "会社ロゴ",
    },
  },

  {
    id: "asset-002",
    source: "powerpoint",
    type: "chart",
    sourceReference: {
      driveId: "mock-drive-001",
      fileId: "mock-file-quarterly-report",
      slideIndex: 3,
      shapeId: "shape-chart-01",
    },
    metadata: {
      title: "四半期売上グラフ",
      tags: ["グラフ", "売上", "四半期", "chart"],
      dimensions: { width: 800, height: 500 },
      extractedText: "四半期売上推移 グラフ",
    },
  },

  {
    id: "asset-003",
    source: "powerpoint",
    type: "image",
    sourceReference: {
      driveId: "mock-drive-001",
      fileId: "mock-file-store-photos",
      slideIndex: 1,
      shapeId: "shape-image-01",
    },
    metadata: {
      title: "東京本店 外観写真",
      tags: ["店舗", "写真", "東京", "本店", "外観"],
      dimensions: { width: 1200, height: 800 },
      extractedText: "東京本店の外観写真",
    },
  },

  {
    id: "asset-004",
    source: "canva",
    type: "icon",
    sourceReference: {
      canvaDesignId: "DAF-mock-002",
      canvaAssetId: "canva-asset-icon-002",
    },
    metadata: {
      title: "チームアイコン",
      tags: ["アイコン", "icon", "チーム", "人物"],
      dimensions: { width: 128, height: 128 },
      extractedText: "チームを表すアイコン",
    },
  },

  {
    id: "asset-005",
    source: "uploaded",
    type: "template",
    sourceReference: {
      uploadedFileId: "uploaded-template-001",
    },
    metadata: {
      title: "社内標準テンプレート（表紙）",
      tags: ["テンプレート", "template", "表紙", "社内標準"],
      dimensions: { width: 1920, height: 1080 },
      extractedText: "社内標準の表紙テンプレート",
    },
  },

  {
    id: "asset-006",
    source: "powerpoint",
    type: "shape",
    sourceReference: {
      driveId: "mock-drive-001",
      fileId: "mock-file-diagram-parts",
      slideIndex: 5,
      shapeId: "shape-diagram-01",
    },
    metadata: {
      title: "プロセス図形（矢印フロー）",
      tags: ["図形", "フロー", "プロセス", "矢印"],
      dimensions: { width: 900, height: 300 },
      extractedText: "プロセスフローを示す矢印図形",
    },
  },

];
