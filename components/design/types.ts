// =========================
// TACT Design 中間表現の型 (STEP43)
// =========================
//
// 目的: 「LLMが直接PowerPoint等を操作する」構造を避け、
//
//   ユーザーの自然言語
//   → DesignIntent(何を・どう・どこを・なぜ変えたいか)
//   → DocumentOperation(Document Modelに対する具体的な操作)
//   → Document Model(実際のドキュメントを変更する層。今回は未実装)
//
// という中間表現を経由させるための最小限の型を定義する。
//
// 重要: この段階ではPowerPoint固有の仕様(スライドマスター・
// プレースホルダー種別等)は持ち込まない。TACT Design独自の
// 抽象モデルとして設計し、将来的にPowerPoint/Google Slides等への
// Adapterを別途作れることを優先する。
//
// TACT本体(core/*)の型(Evidence・WorkflowContext等)には
// 一切依存しない。TACTの成果物(currentOutput)を将来Document
// Modelへ変換する場合も、変換用のAdapterを別途設けることを想定し、
// ここでは混在させない。

// =========================
// DesignIntent
// =========================
//
// ユーザーの自然言語入力を、構造化された「意図」へ変換したもの。
// まだ具体的な操作(DocumentOperation)ではない。
// 曖昧な入力(例:「もっと見やすくして」)も、confidenceを下げた
// 状態でIntentとして表現できるようにする(=構造化を諦めない)。

export type DesignIntentAction =
  // スタイル(強調・フォント・配色等)を変える
  | "changeStyle"
  // レイアウト・配置を変える(具体的な移動/サイズ変更を伴わない、
  // 一般的なレイアウト変更の要望に使う)
  | "changeLayout"
  // STEP46で追加。「右に移動して」等、要素の位置変更を明確に
  // 指す要望。changeLayoutより具体的なため、区別して扱う
  // (DocumentOperationTypeのmoveElementと1:1で対応させるため)。
  | "moveElement"
  // STEP46で追加。「大きくして」等、要素のサイズ変更を明確に
  // 指す要望。changeStyle(フォント等の見た目)とは区別する。
  | "resizeElement"
  // 情報量を減らす・要約する
  | "reduceContent"
  // 情報を追加する
  | "addContent"
  // STEP50で追加。「削除して/消して」等、要素そのものの削除を
  // 明確に指す要望(reduceContentはテキスト量の削減、こちらは
  // 要素自体の除去で意味が異なるため区別する)。
  | "deleteElement"
  // 構成・順序を整理し直す
  | "reorganize"
  // STEP140で追加。「既存のロゴを使って」「この資料の写真を配置して」
  // 等、新しい素材の生成ではなく既存素材(PowerPoint/Canva/
  // アップロード済み)の利用を明確に指す要望。addContent(テキストの
  // 追加)とは目的が異なるため区別する。
  | "useExistingAsset"
  // 上記に明確に当てはまらない、曖昧な改善要望
  | "unknown";

export interface DesignIntent {
  id: string;

  // 元のユーザー発言(追跡性のためそのまま保持する)。
  rawInput: string;

  action: DesignIntentAction;

  // 対象。現時点では自由記述(例:"title" / "slide-2" /
  // "document"全体)。将来Document Modelの実際のIDへ
  // 解決する層を別途設ける想定。
  target: string;

  // actionごとに意味が変わる、緩やかなパラメータ。
  // 例: changeStyleなら {emphasis: "stronger"}、
  //     reduceContentなら {reason: "情報量が多い"}
  parameters: Record<string, unknown>;

  // なぜこの意図だと判断したかの自然文の説明。
  reason: string;

  // 入力がどれだけ明確だったか。曖昧な依頼はlowにし、
  // 構造化自体は諦めない。
  confidence: "high" | "medium" | "low";

}

// =========================
// DocumentOperation
// =========================
//
// DesignIntentを、Document Modelに対する具体的な操作候補へ
// 変換したもの。STEP43では「操作案を生成する」ところまでで、
// 実際にDocument Modelへ適用する処理は実装しない
// (status は常に "proposed" のまま)。
//
// typeは将来のPowerPoint/Google Slides等への変換を見据え、
// ソフト固有の操作ではなく汎用的な語彙にしている。

// STEP140: 既存Assetの移動・リサイズ・削除は、専用のOperation type
// (resizeAsset/moveAsset/removeAsset)を新設せず、既存の
// moveElement/resizeElement/deleteElementをそのまま再利用する。
// AssetReferenceを持つDocumentElementも、位置・サイズ・削除という
// 観点では他のElementと同じ構造(position/size/id)を持つため、
// mockDesignAgent.tsのapplyChangesToElement/applyDeleteElementは
// element.typeやelement.assetの有無を見ずに動作でき、変更不要だった
// (実装前の調査で確認済み)。新設するのはplaceAsset(既存Assetを
// 検索・選択してDocument Modelへ新しく配置する)のみ。
export type DocumentOperationType =
  | "addText"
  | "replaceText"
  | "deleteText"
  | "moveElement"
  | "resizeElement"
  | "changeStyle"
  | "changeLayout"
  | "addElement"
  | "deleteElement"
  | "duplicateElement"
  // STEP140で追加。既存Asset(PowerPoint/Canva/アップロード済み)を
  // 検索・選択した結果をDocument Modelへ新しい要素として配置する。
  // AIが新しい画像・図形を生成することはない
  // (changes.assetは必ずAssetReference、= 既存素材への参照)。
  | "placeAsset";

// 将来Apply/Undo/Rejectへ発展させるための状態。
// STEP43時点では実際に"applied"になる処理は実装しない
// (UI上でユーザーが操作案を確認するところまで)。
export type DocumentOperationStatus =
  | "proposed"
  | "applied"
  | "rejected";

export interface DocumentOperation {
  id: string;

  type: DocumentOperationType;

  // 対象のDocumentElement.id(このSTEPではmockのDocument Modelを
  // 参照する)。
  targetId: string;

  // 操作の内容。type/対象要素ごとに意味が変わる緩やかな構造。
  changes: Record<string, unknown>;

  // どのDesignIntentから生成されたかの追跡用参照。
  sourceIntentId: string;

  status: DocumentOperationStatus;

}

// =========================
// Document Model(最小構造)
// =========================
//
// Document > Page > Element という抽象化。PowerPoint固有の概念
// (スライドマスター・プレースホルダー・アニメーション等)は
// 今回持ち込まない。将来Adapterがこの最小構造とPowerPoint/Google
// Slides等の実際のフォーマットを相互変換する想定。

export type DocumentElementType =
  | "text"
  | "shape"
  | "table"
  | "image"
  | "group"
  // STEP44で追加。TACTのsection.content内にある箇条書き
  // (「・」「-」始まりの行)を、通常のtextとは区別して保持する
  // ための型。既存のtext/table等は変更していない、追加のみの
  // 拡張(既存コンシューマへの破壊的影響なし)。
  | "list";

// STEP55で追加。「このElementは何か(currentOutputのどのフィールド
// 由来か)」を表す軽量な意味タグ。style(見た目)とは責務を分け、
// role(意味)を見てRendererがどう見せるかを判断できるようにする。
// 新しいDocumentElementTypeは増やさない(STEP47の「titleはtext+style
// で表現する」方針を維持)、あくまでtext/listの上に乗る追加情報。
export type DocumentElementRole =
  | "title"
  | "heading"
  | "summary"
  | "keyFindings"
  | "recommendations"
  | "nextActions";

// STEP55で追加。段落内の一部分だけを強調するための、最小限の
// Rich Text表現。1要素につき { text, emphasize? } の配列で、
// 部分文字列ごとの強調有無だけを表せる(フォントサイズや色など
// 複数のスタイル軸を持たせる本格的なRich Textスキーマは今回
// 実装しない。将来必要になった時点で拡張する)。
// segmentsが存在する場合、Rendererはcontentの代わりにこちらを
// 使って描画する(存在しない場合は従来どおりcontentのみで描画)。
export interface DocumentTextSegment {
  text: string;
  emphasize?: boolean;
}

// =========================
// AssetReference (STEP140)
// =========================
//
// TACT Designが「既に存在する素材」を参照するための型。
//
// 最重要原則: AssetReferenceは素材そのもの(画像バイナリ等)を
// 保持しない。あくまで元システム(PowerPoint/Canva/アップロード先)
// に存在する実体への「参照」であり、TACT側で画像・イラスト・写真を
// 新しく生成することはない。previewはUI表示用の軽量な手がかり
// (サムネイルURLや説明文)に留め、実体のコピーではない。
//
// STEP139の調査方針(TACT本体(core/*)の型には依存しない)を
// 踏襲し、Evidence/WorkflowContext等のCore型とは無関係に、
// TACT Design独自の型として定義する。

export type AssetSource =
  | "powerpoint"
  | "canva"
  | "uploaded";

export type AssetType =
  | "image"
  | "shape"
  | "icon"
  | "chart"
  | "logo"
  | "template"
  | "slide";

export interface AssetReference {
  id: string;

  source: AssetSource;

  type: AssetType;

  // 元システム内でこの素材を一意に特定するための情報。
  // sourceの値に応じて該当するフィールドだけを使う(すべて任意)。
  sourceReference: {
    driveId?: string;
    fileId?: string;
    slideIndex?: number;
    shapeId?: string;

    canvaDesignId?: string;
    canvaAssetId?: string;

    uploadedFileId?: string;
  };

  metadata?: {
    title?: string;
    tags?: string[];
    dimensions?: {
      width?: number;
      height?: number;
    };
    // OCR等で抽出済みのテキスト(あれば)。Asset検索のkeyword
    // matchingで利用する。
    extractedText?: string;
  };

  // UI表示用の軽量プレビュー情報。thumbnailUrlが無い場合、
  // DocumentRendererはtitle/source/type等のテキストラベルで
  // 代替表示する(実体を推測して描画しない)。
  preview?: {
    thumbnailUrl?: string;
  };
}

export interface DocumentElement {
  id: string;
  type: DocumentElementType;

  position: { x: number; y: number };
  size: { width: number; height: number };

  // text/title等、単純な文字列で表現できる要素の中身。
  content?: string;

  // STEP55で追加。type: "text"の場合、部分文字列単位の強調を
  // 表現したい時だけ設定する(オプショナル、既存のcontentのみの
  // Elementとの後方互換性を保つ)。
  segments?: DocumentTextSegment[];

  // STEP55で追加。「このElementは何か」を表す意味タグ。
  role?: DocumentElementRole;

  // STEP44で追加。type: "list"の場合の、箇条書き項目
  // (マーカーは含まない、1項目1文字列)。
  // 既存のparseContentBlocks()の表検出と同様、TACT側の
  // Markdown箇条書き記法をDocumentModel側では引きずらないため、
  // contentへ無理に押し込めず専用フィールドとして持たせる。
  items?: string[];

  // STEP44で追加。type: "table"の場合の構造化データ。
  // components/output/parseContentBlocks.tsが返す
  // ContentBlock.headers/rowsと同じ形をそのまま使う
  // (既存の表検出ロジックをそのまま再利用できるようにするため)。
  tableData?: { headers: string[]; rows: string[][] };

  // フォントサイズ・色・強調等、緩やかなスタイル情報。
  style?: Record<string, unknown>;

  // STEP140で追加。type: "image"/"shape"/"group"の要素が、既存の
  // Asset(PowerPoint/Canva/アップロード済み)への参照を持つ場合に
  // 設定する。存在しない場合、DocumentRendererは従来通りの
  // プレースホルダー表示を維持する(後方互換)。
  asset?: AssetReference;
}

export interface DocumentPage {
  id: string;
  index: number;
  elements: DocumentElement[];
}

export interface DocumentModel {
  id: string;
  title: string;
  pages: DocumentPage[];
}
