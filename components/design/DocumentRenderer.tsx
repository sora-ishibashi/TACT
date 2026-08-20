"use client";

// =========================
// DocumentRenderer (STEP47〜STEP48)
// =========================
//
// DocumentModelを、HTML/CSSだけで「資料っぽく」描画する簡易Renderer。
// PowerPointの完全再現は目的にしない。目的は、
//
//   AI Panel → DesignIntent → DocumentOperation → Apply
//   → DocumentModel更新 → 画面へ反映
//
// という一連のループを、目に見える形で成立させること。
//
// 重要: このコンポーネントはDocumentModelを一切書き換えない
// (読み取り専用)。編集はmockDesignAgent.tsのapplyDocumentOperation
// だけが行う。責務は
//   DocumentModel = データ
//   DocumentRenderer = 表示
//   DocumentOperation = 編集
//   AIPanel = AIとの対話・承認
// にはっきり分かれている(STEP47の設計方針)。
//
// titleについて: DocumentElementTypeには"title"という型は存在せず
// (STEP43〜44の設計)、タイトルはcurrentOutputToDocumentModel
// (STEP44)がfontSize/fontWeightを大きめに設定した"text"要素として
// 表現されている。そのためこのRendererでも"title"を特別な
// Element.typeとしては扱わず、"text"要素のstyleをそのまま反映する
// ことで結果的にタイトルらしい見た目になる(DocumentModelの構造を
// 変更しないため、あえて型を増やさない判断)。
//
// STEP48: selectedElementIdをpropsとして受け取り、対象Elementに
// 視覚的なハイライトを付ける機能を追加した。selectedElementIdは
// あくまで「表示上の選択状態」であり、DocumentModel自体には
// 一切含まれない(このコンポーネントもuseStateでDocumentModelを
// 持たないのと同様、選択状態もこのコンポーネントの外
// (app/design/page.tsx)が所有する)。
//
// addTextのようにPage単位のOperationの場合、targetIdはElement id
// ではなくPage idになる(mockDesignAgent.ts参照)。この場合は
// Element単位のハイライトではなく、Page全体を軽くハイライトする
// ことで区別する(要件10)。
//
// STEP55: currentOutputToDocumentModel(Adapter)がElementへ付与する
// ようになったrole(title/heading/summary/keyFindings/
// recommendations/nextActions)とsegments(部分文字列単位の強調)を
// 描画に反映するようにした。どちらも読み取るだけで、Renderer自身が
// 新たに判定・生成することはない(Read Only設計は維持)。
// - segmentsがある場合は強調部分だけを太字+下線で表示し、ない場合は
//   従来どおりcontentをそのまま表示する(完全な後方互換)。
// - roleに応じて、Text/List要素にごく控えめな左枠線・背景色を
//   加えることで、Executive Summary/Key Findings/Recommendations/
//   Next Actionsが「同じただのElement」に見えないようにする
//   (過剰な装飾はしない)。
// - Tableは見出しの視認性・余白・数値列の右揃え・長文セルの折り返し
//   ・大きすぎる表への安全なスクロール対応を改善した。
//
// STEP56: DocumentModel/typesは変更せず、既存のrole/segments/items
// をより丁寧に描画することだけを行った(Presentation Layerのみの
// 改善、境界は維持)。
// - role: "heading" のtext要素に、下線区切り(border-bottom)を追加し、
//   「見出し」であることを色を増やさずに伝える。
// - keyFindings/recommendations/nextActionsのlist items(Adapter側で
//   既に「タイトル：説明」という形の文字列として作られている)を、
//   Renderer側で「：」区切りだけを根拠に安全に分割し、タイトル部分
//   だけをstrongで強調する。区切りが見つからない場合は元の文字列を
//   そのまま表示する(新しいAI判定・新しい構造化は行わない)。
// - Tableの1列目を「比較項目/行ラベル」とみなし、太字・左寄せで
//   区別する(見出しheaders/rows構造をそのまま使うだけで、
//   currentOutput Schemaは変更していない)。
//
// STEP57: 色を増やさず、「相対的な情報階層」をさらに明確にした
// (title最強 → heading区切り → summary(本文よりやや強い) →
// keyFindings/recommendations/nextActions → sections(通常本文) →
// role未設定の補足情報、の順)。
// - role: "summary" のtext要素にfont-medium(本文より少し強いが
//   heading程ではない)を追加した(Adapter側のstyleは変更せず、
//   Renderer側のclassNameだけで表現)。
// - keyFindings/recommendations/nextActionsのitem表示を、
//   「タイトル：説明」という1行のインライン表示から、タイトルを
//   1行目・説明を2行目に置く縦積みのブロック表示へ変更し、
//   「タイトル→説明」という視覚的な関係をより明確にした。
// - Table本文セルの上下paddingをヘッダーと揃え、比較表(3列以上)の
//   場合は1列目(行ラベル)と比較対象列の間に縦の区切り線を追加した
//   (構造上「これが比較の軸で、右側が比較対象」と分かるようにする
//   だけで、どの値が重要かをAIが判断して強調することはしない)。
//
// STEP58: 重要な制約の発見と対応方針。
// currentOutputToDocumentModel(Adapter)は各Elementを絶対配置
// (position: absolute、LayoutCursorによるy座標の事前計算)で
// 配置しており、次のElementのtopは前のElementの「推定height」を
// 基準に決まっている。そのため、Renderer側でmargin/paddingを
// 大きく増やして特定のElementを高くすると、後続Elementと視覚的に
// 重なるリスクがある(boxStyleがminHeightなので描画自体は崩れないが、
// 想定より高さが伸びた分だけ次のElementに近づく/重なる可能性がある)。
// この制約を踏まえ、STEP58では:
// - Page間の余白(PageView同士のmargin)は通常のブロックフローで
//   スタックされておりAdapterの座標計算と無関係なため、安全に調整
//   できる(mb-8 → mb-10)。
// - Element内部の余白(padding)は、Adapterのheight見積もりに元々
//   含まれている余裕(+20px等の固定バッファ)の範囲に収まる、
//   小さな調整に留めた(例: summary/headingのpadding微増)。
// - line-heightの変更は、内容が長くなりやすい箇所(section本文)には
//   適用せず、比較的短いsummary/list item説明文にのみ、小さな増分
//   (leading-relaxed)で適用した。
// - Tableの1列目にposition: sticky(横スクロール時に行ラベルを
//   固定表示)を追加した。既存のoverflow-y:auto(大きな表の縦
//   スクロール)と同じコンテナ内で機能するため衝突しない
//   (sticky top(header)とsticky left(1列目)は独立した軸)。
//   ただし、sticky化した1列目セルは背景色を固定にしたため、
//   zebra縞・hover強調が1列目では見えなくなるという既知のトレード
//   オフがある(要件7で報告)。
//
// STEP59: STEP58の「未解決事項」で報告した、Adapter側のlist要素
// height見積もりのズレ(keyFindings等が1行想定のままだったこと)を
// 解消した。表示ロジック(このファイル)は変更していない
// (見た目は従来通り)。「タイトル：説明」の分割判定ロジック自体は
// currentOutputToDocumentModel.tsからも必要になったため、
// itemTitleSplit.tsへ共有した(二重実装の回避)。
//
// STEP61: 「AI内部の構造を見せるUI」から「自然な日本語の資料」へ。
// 調査の結果、"Key Findings"/"Recommendations"/"Next Actions"という
// 英語文字列は、Adapter(currentOutputToDocumentModel.ts)がrole:
// "heading"のtext要素のcontentとして直接埋め込んでいることが判明した
// (makeBulletPage参照)。DocumentModelのcontent自体は変更せず
// (「Presentation Layerのみで完結させる」という実装範囲の制約、
// およびcurrentOutputToDocumentModel.tsのheight計算に触れないという
// 要件7を守るため)、Renderer側で「role: headingのcontentが既知の
// 英語ラベルと完全一致する場合だけ、表示文字列を日本語ラベルへ
// 差し替える」という表示専用の変換(HEADING_LABEL_OVERRIDE)を追加
// した。DocumentModel.content自体(内部データ)は英語のまま保持され、
// あくまで画面に描画される文字列だけが変わる(表示と内部データの
// 分離)。
// - 4色(summary=グレー/keyFindings=青/recommendations=緑/
//   nextActions=オレンジ)だったROLE_ACCENTを、summaryの控えめな
//   グレー1色だけに統一した(要件6)。keyFindings/recommendations/
//   nextActionsのlistは、色ではなく「見出しラベル+タイトル/説明の
//   タイポグラフィ+余白」だけで構造を伝える設計へ移行した。
// - summary(概要)には、他の3セクションと同様に小さな見出し
//   ラベル("概要")を追加した。新しいDocumentElementは増やさず、
//   既存のsummary text要素の描画内に、見出しラベルを1行添える形に
//   した(box自体のheight見積もりはAdapter側の既存の余裕(+20px
//   固定バッファ)の範囲に収まる小さな追加のため、height計算には
//   触れていない)。
//
// STEP62: 「見出しを明確にし、重要部分にだけ視線を誘導する」。
// STEP61で色数を減らした結果、(1)見出しが本文とあまり変わらない、
// (2)重要な情報を示す視覚的な手がかりがない、という2つの課題が
// 残っていた。今回はこの2つだけに絞って対応する。
// - 見出し(role: "heading"のtext要素、および概要ラベル)は、
//   paddingTop/paddingBottomをわずかに増やし、border-bottomを
//   1px→2pxに強めた。fontSize/fontWeightはAdapter側で既に
//   bold+本文より大きいサイズが設定されている(makeBulletPage/
//   section heading生成箇所参照)ため、文字サイズ自体は変更して
//   いない。paddingの増分は、HEADING_HEIGHT(44px)/TITLE_HEIGHT
//   (60px)というAdapterの固定height見積もりに対して数px程度の
//   増加にとどまり、GAP_Y(20px、要素間に必ず入る固定の余白)の
//   範囲内に収まることを計算で確認した(要件7参照)。
// - 重要部分の強調は、新しいAI判定を追加せず、STEP56〜59で
//   既に確立された「タイトル：説明」分割構造(itemTitleSplit.ts)を
//   そのまま利用する。keyFindings/recommendations/nextActionsの
//   item のタイトル部分だけに、1色の下線(text-decoration)を
//   引く。ROLE_ACCENTのような「role毎に別の色」を割り当てる設計
//   には戻さない。下線はtext-decorationのため、文字の実際の幅
//   にだけ沿って引かれ、要素box全体に線が伸びることはない
//   (「文章全体に下線を引いてはいけない」という要件を満たす)。
//
// STEP63: 「文字色の情報階層」の調整(機能追加ではなく色のみ)。
// STEP62までで構造・見出し・下線は整ったが、本文全体の文字色を
// 見直すと、説明文(タイトル/説明の縦積みブロックの「説明」側)が
// text-gray-600のままで、白背景に対してコントラストが弱く「資料
// として読むには薄い」状態だった。今回はそこだけを最小変更で調整
// する(新しい色は増やさない、フォントサイズ・line-height・
// padding/marginは変更しない、色classだけを変更する)。
// - 説明文(list itemの「タイトル：説明」の説明側): text-gray-600
//   → text-gray-700。
// - role: "title"(ページ冒頭のタイトル要素): text-gray-800 →
//   text-gray-900。「最重要の見出し・タイトル」としてheadingと
//   同じ濃さの階層に揃えた(fontSizeは元々32/22pxで十分大きいため
//   変更不要、色だけの調整)。
// - それ以外(本文text-gray-800、通常listのtext-gray-700、概要
//   ラベルのtext-gray-500、Tableのtext-gray-700/900、境界線の
//   border-gray-200等)は、STEP62時点で既にガイドラインの目安
//   (見出しtext-gray-900/本文text-gray-700程度/補助ラベル
//   text-gray-500程度)に収まっていたため変更していない。
//   「全部text-gray-900にする」ような一律の濃色化はせず、階層は
//   維持したままコントラストが不足していた箇所だけを底上げした。

import type { CSSProperties, ReactNode } from "react";
import {
  AssetReference,
  DocumentElement,
  DocumentElementRole,
  DocumentModel,
  DocumentPage,
} from "./types";
import { canSplitItemTitle, splitItemTitle } from "./itemTitleSplit";

const PAGE_WIDTH = 680;
const PAGE_PADDING = 24;
const PAGE_MIN_HEIGHT = 160;

const SELECTION_COLOR = "#2563eb";

// DocumentElement.style(Record<string, unknown>)から、既知の
// CSSプロパティだけを安全に(型を確認したうえで)取り出す。
// 存在しない/型が違う値は無視し、デフォルト(何も指定しない)に
// フォールバックする(STEP47要件6)。
function pickStyle(style: Record<string, unknown> | undefined): CSSProperties {

  if (!style) return {};

  const result: CSSProperties = {};

  if (typeof style.fontSize === "number") {
    result.fontSize = style.fontSize;
  }

  if (typeof style.fontWeight === "string" || typeof style.fontWeight === "number") {
    result.fontWeight = style.fontWeight as CSSProperties["fontWeight"];
  }

  if (typeof style.fontStyle === "string") {
    result.fontStyle = style.fontStyle as CSSProperties["fontStyle"];
  }

  if (typeof style.color === "string") {
    result.color = style.color;
  }

  if (typeof style.backgroundColor === "string") {
    result.backgroundColor = style.backgroundColor;
  } else if (typeof style.background === "string") {
    // mockDesignAgent.ts側では"background"というキーで生成される
    // 可能性がある(STEP46 changeStyleのchanges例)ため、こちらも見る。
    result.backgroundColor = style.background;
  }

  if (typeof style.textAlign === "string") {
    result.textAlign = style.textAlign as CSSProperties["textAlign"];
  }

  return result;

}

// =========================
// role別の視覚アクセント (STEP55、STEP61で色設計を変更)
// =========================
//
// STEP55〜58: Executive Summary / Key Findings / Recommendations /
// Next Actionsをそれぞれ別の色(グレー/青/緑/オレンジ)で区別して
// いた。
//
// STEP61: 4色に分かれたaccentは「VS Codeのような開発ツール的な
// 見た目」に近づいてしまうため廃止した。色でroleを識別する設計から、
// 「見出しラベル(日本語)+タイトル/説明のタイポグラフィ+余白」で
// 構造を伝える設計へ移行した(要件3・6)。
// - summaryだけ、「最初に読むべき情報」であることを示す、ごく
//   薄いグレーの左枠線を残した(背景色は削除し、以前よりさらに
//   弱めた)。
// - keyFindings/recommendations/nextActionsのlistからはaccent
//   (左枠線・背景色)を完全に削除した。区別は日本語見出しラベル
//   (HEADING_LABEL_OVERRIDE参照)とitem内のタイトル/説明の階層だけ
//   で行う。

const ROLE_ACCENT: Partial<
  Record<DocumentElementRole, { borderColor: string; backgroundColor?: string }>
> = {

  summary: {
    borderColor: "#D1D5DB",
  },

};

// =========================
// 見出しラベルの日本語化 (STEP61)
// =========================
//
// currentOutputToDocumentModel.ts(Adapter)は、keyFindings/
// recommendations/nextActionsの各セクションの見出しを、role:
// "heading"のtext要素のcontentとして"Key Findings"/
// "Recommendations"/"Next Actions"という英語文字列で埋め込んでいる
// (makeBulletPage参照)。DocumentModel自体(content)は変更せず
// (Adapterのheight計算・実装範囲の制約に触れないため)、Renderer側
// で表示文字列だけを日本語ラベルへ置き換える。AIによる翻訳・意味
// 判定は行わない、既知の文字列との完全一致だけを見る単純な
// マッピングにとどめる。
const HEADING_LABEL_OVERRIDE: Record<string, string> = {
  "Key Findings": "主なポイント",
  "Recommendations": "提案",
  "Next Actions": "次にやること",
};

// summary要素には見出しラベルとなるElement自体が存在しない
// (keyFindings等と違い、Adapterは見出しを別要素として生成していない)
// ため、Rendererが小さなラベル行を1つ追加で描画する
// (DocumentElementは増やさない、表示上の追加のみ)。
const SUMMARY_LABEL = "概要";

// =========================
// 重要部分の下線アクセント (STEP62)
// =========================
//
// STEP61で4色accentを廃止した結果、「重要な情報がどこか」を示す
// 視覚的な手がかりが失われた。STEP62では新しいAI判定・意味解析を
// 一切追加せず、既存のDocumentModel構造(keyFindings/
// recommendations/nextActionsのitemが「タイトル：説明」の形に
// 分割できるという、itemTitleSplit.tsで既に判定済みの構造)だけを
// 根拠に、タイトル部分にだけ1色の下線を引く。
// ROLE_ACCENTのように「roleごとに別の色」を割り当てる設計には戻さ
// ない(4色復活の禁止)。全roleで共通のこの1色だけを、「重要な場所」
// (=タイトル)に限定して使う。旧ROLE_ACCENTの4色(グレー/青/緑/
// オレンジ)のいずれとも異なる、落ち着いたティール系の色を選んだ
// (要件「派手な青・緑・オレンジなどを複数使わない」に対応)。
const IMPORTANT_UNDERLINE_COLOR = "#0F766E";

// =========================
// TableView (STEP55)
// =========================
//
// 「比較・判断を一瞬でできること」を目的にTable描画を改善する
// (要件8)。派手な装飾ではなく、ヘッダーの視認性・余白・数値列の
// 右揃え・長文セルの折り返し・大きすぎる表への安全なスクロール
// 対応にとどめる。headers/rowsが欠落・不正な形(null/undefined/
// 非配列/行ごとの列数不一致)でもクラッシュしない(要件15)。

const TABLE_MAX_VISIBLE_ROWS = 12;
const TABLE_ROW_HEIGHT_PX = 34;

// セルの値が数値らしいかどうかの簡易判定(カンマ区切り・%・通貨
// 記号・符号・単位を許容する)。列内の全セルが数値らしい場合のみ、
// その列を右揃えにする(要件8「数値は読みやすく揃える」)。
// STEP56: 「0円」「15,000円」のような、記号ではなく単位が後置される
// 日本語の金額・件数表記も数値として認識するよう拡張した(値そのもの
// は書き換えず、右揃え判定にのみ使う)。
function isNumericLike(value: string): boolean {
  return /^\s*[-+]?[\d,]+(\.\d+)?\s*(円|件|人|個|枚|%|％|¥|\$|€)?\s*$/.test(
    value
  );
}

// =========================
// AssetPreview (STEP140)
// =========================
//
// element.assetが設定されている場合の表示。既存Assetの実体
// (画像バイナリ等)はTACT側に存在しないため、ここでは
// thumbnailUrlがあればそれを、無ければsource/title/typeという
// テキスト情報だけを表示する。TACTが独自に画像を生成・取得する
// ことは一切ない。

const ASSET_SOURCE_LABELS_JA: Record<AssetReference["source"], string> = {
  powerpoint: "PowerPoint",
  canva: "Canva",
  uploaded: "アップロード済み",
};

function AssetPreview({ asset }: { asset: AssetReference }) {

  const sourceLabel =
    ASSET_SOURCE_LABELS_JA[asset.source] ?? asset.source;

  const title = asset.metadata?.title ?? "(タイトル不明)";

  if (asset.preview?.thumbnailUrl) {

    return (
      <img
        src={asset.preview.thumbnailUrl}
        alt={title}
        className="h-full w-full object-contain"
      />
    );

  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 border border-dashed border-gray-300 bg-gray-50 px-2 text-center">
      <span className="text-[10px] font-medium text-gray-600">
        {title}
      </span>
      <span className="text-[9px] text-gray-400">
        {sourceLabel} / {asset.type}
      </span>
    </div>
  );

}

function TableView({
  element,
  style,
}: {
  element: DocumentElement;
  style: CSSProperties;
}) {

  const headers =
    element.tableData && Array.isArray(element.tableData.headers)
      ? element.tableData.headers
      : [];

  const rawRows =
    element.tableData && Array.isArray(element.tableData.rows)
      ? element.tableData.rows
      : [];

  // 行自体が配列でない不正なデータは、その行を空配列として扱う
  // (行ごと落とすとデータが消えて見えるため、空行として残す)。
  const rows = rawRows.map((row) => (Array.isArray(row) ? row : []));

  if (headers.length === 0 && rows.length === 0) {

    return (
      <div className="flex h-full items-center justify-center text-[11px] text-gray-400">
        (表データがありません)
      </div>
    );

  }

  const columnCount = Math.max(
    headers.length,
    ...rows.map((row) => row.length),
    0
  );

  const numericColumns = Array.from({ length: columnCount }, (_, colIndex) => {

    const values = rows
      .map((row) => row[colIndex])
      .filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0
      );

    return values.length > 0 && values.every(isNumericLike);

  });

  const isLargeTable = rows.length > TABLE_MAX_VISIBLE_ROWS;

  return (

    <div
      className="overflow-x-auto rounded-md border border-gray-200"
      style={
        isLargeTable
          ? {
              maxHeight:
                TABLE_ROW_HEIGHT_PX * (TABLE_MAX_VISIBLE_ROWS + 1),
              overflowY: "auto",
            }
          : undefined
      }
    >

      <table
        style={{ borderCollapse: "collapse", width: "100%", ...style }}
        className="text-xs"
      >

        <thead className="sticky top-0">
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                style={{
                  textAlign: numericColumns[index] ? "right" : "left",
                  wordBreak: "break-word",
                  // STEP58: 1列目(行ラベル)を横スクロール時にも
                  // 固定表示する。theadは既にsticky top(縦スクロール
                  // 対応)なので、1列目のセルにはsticky leftを重ねる
                  // (縦横で独立した軸のため衝突しない)。header自体は
                  // bg-gray-100が既にクラスで指定済みのため、追加の
                  // 背景色指定は不要。
                  position: index === 0 ? "sticky" : undefined,
                  left: index === 0 ? 0 : undefined,
                  zIndex: index === 0 ? 2 : undefined,
                }}
                className={
                  "border-b-2 border-gray-300 bg-gray-100 px-3 py-2.5 " +
                  "font-semibold text-gray-700" +
                  // STEP57: 本文側の区切り線(比較表の1列目)と揃える。
                  (index === 0 && columnCount >= 3
                    ? " border-r-2 border-gray-200"
                    : "")
                }
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className={
                "hover:bg-blue-50/40 " +
                (rowIndex % 2 === 1 ? "bg-gray-50/60" : "")
              }
            >
              {row.map((cell, cellIndex) => {

                // STEP56: 1列目は「比較項目/行ラベル」であることが
                // 多いため(既存のMarkdown表の一般的な慣習)、太字・
                // 左寄せで区別する。列の意味を推測して値を書き換える
                // ことはしない(表示スタイルのみの変更)。
                const isRowLabel = cellIndex === 0;

                // STEP57: 3列以上(=行ラベル+比較対象2つ以上)の表は
                // 「比較表」とみなし、行ラベル列と比較対象列の間に
                // 縦の区切り線を入れる。どの値が重要かをAIが判断して
                // 強調することはせず、あくまで「ここからが比較対象」
                // という構造上の区切りだけを示す。
                const isComparisonDivider =
                  isRowLabel && columnCount >= 3;

                return (
                  <td
                    key={cellIndex}
                    style={{
                      textAlign:
                        isRowLabel
                          ? "left"
                          : numericColumns[cellIndex] ? "right" : "left",
                      wordBreak: "break-word",
                      // STEP58: 1列目をsticky leftにする(theadの
                      // sticky topと独立した軸のため衝突しない)。
                      // sticky化したセルは背景を透過させると下に
                      // スクロールしてきた他列の内容が透けるため、
                      // 固定の背景色を明示する必要がある。この結果、
                      // 1列目だけはzebra縞・hover強調が見えなくなる
                      // (既知のトレードオフ、要件7で報告)。
                      position: isRowLabel ? "sticky" : undefined,
                      left: isRowLabel ? 0 : undefined,
                      zIndex: isRowLabel ? 1 : undefined,
                      backgroundColor: isRowLabel ? "#FFFFFF" : undefined,
                    }}
                    className={
                      "border-b border-gray-100 px-3 py-2.5 align-top " +
                      (isRowLabel
                        ? "font-medium text-gray-900"
                        : "text-gray-700") +
                      (isComparisonDivider ? " border-r-2 border-gray-200" : "")
                    }
                  >
                    {cell}
                  </td>
                );

              })}
            </tr>
          ))}
        </tbody>

      </table>

    </div>

  );

}

type ElementViewProps = {
  element: DocumentElement;
  selectedElementId: string | null;
  onSelectElement: (id: string) => void;
};

function ElementView({
  element,
  selectedElementId,
  onSelectElement,
}: ElementViewProps) {

  const style = pickStyle(element.style);
  const isSelected = element.id === selectedElementId;
  const accent = element.role ? ROLE_ACCENT[element.role] : undefined;
  // STEP56: role: "heading"は色を増やさず、下線区切りだけで
  // 「見出し」であることを示す(title/summary/keyFindings等の
  // 色付きaccentとは別の、中立的な階層表現)。
  const isHeading = element.role === "heading";
  // STEP58: summaryは「最初に読むべき情報」として、本文より
  // わずかに広い上下paddingを与える(Adapterのheight見積もりに
  // 既に含まれる+20pxの余裕の範囲内に収める小さな増分)。
  const isSummary = element.role === "summary";

  // STEP48: 選択状態はoutline+薄い背景で表現する。資料そのものの
  // 見た目(既存のstyle反映)を壊さないよう、selectedでない場合は
  // 透明なoutlineを敷いてレイアウトのガタつきを防ぐだけに留める。
  // STEP55: accent(role由来の左枠線・背景色)は選択状態と独立した
  // 別軸の見た目のため、両立させる(選択時は上からoutlineが重なる)。
  const boxStyle: CSSProperties = {
    position: "absolute",
    left: element.position.x,
    top: element.position.y,
    width: element.size.width,
    minHeight: element.size.height,
    cursor: "pointer",
    borderRadius: 4,
    outline: isSelected
      ? `2px solid ${SELECTION_COLOR}`
      : "2px solid transparent",
    outlineOffset: 2,
    backgroundColor: isSelected
      ? "rgba(37, 99, 235, 0.06)"
      : accent?.backgroundColor,
    borderLeft: accent ? `3px solid ${accent.borderColor}` : undefined,
    paddingLeft: accent ? 10 : undefined,
    // STEP62: 見出し(isHeading)にもsummaryと同じ上paddingを与え、
    // 「本文の続きではなく、新しいまとまりの始まり」であることを
    // 上下の余白で明確にした。paddingBottom/borderBottomも合わせて
    // 強めた(1px→2px)。増分はHEADING_HEIGHT(44px)基準でも
    // GAP_Y(20px)の余裕内に収まることを確認済み(ファイル冒頭の
    // STEP62コメント参照)。
    paddingTop: isHeading ? 6 : isSummary ? 6 : undefined,
    paddingBottom: isHeading ? 10 : isSummary ? 6 : undefined,
    borderBottom: isHeading ? "2px solid #E5E7EB" : undefined,
  };

  function handleClick() {
    onSelectElement(element.id);
  }

  let inner: ReactNode;

  switch (element.type) {

    case "text": {

      // STEP57: role: "summary"は本文より少し強い階層として、
      // font-mediumだけを追加する(Adapter側のstyleは変更しない、
      // Renderer側の見た目だけの調整)。それ以外(heading/title/
      // 未設定)は既存どおり(headingはAdapter側でfontWeight:bold
      // 済み、titleも同様)。
      // STEP58: summaryはleading-relaxedにして読みやすさを上げる。
      // section本文はleading-snugのまま維持する(Adapterのheight
      // 見積もりは段落数だけを見た概算であり、長い本文にleading-
      // relaxedを適用すると実際の描画高さが見積もりを超えやすく
      // なるため、比較的短いsummaryにのみ適用する)。
      const isSummaryText = element.role === "summary";
      // STEP62: 見出し(role: "heading")は、本文と明確に区別できる
      // よう文字色をtext-gray-900(本文のtext-gray-800より濃い)にし、
      // font-semiboldを添える。Adapter側は既にstyle.fontWeight:
      // "bold"をinlineで設定済み(makeBulletPage/section heading
      // 生成箇所参照)のため実際の太さはそちらが優先されるが、
      // AdapterがfontWeightを設定しないheading要素が将来増えても
      // 崩れないよう、Renderer側でも明示しておく。
      const isHeadingText = element.role === "heading";
      // STEP63: 「最重要の見出し・タイトル」を同じ濃さの階層として
      // 扱う。role: "title"(文書タイトル/section見出しではなく、
      // ページ冒頭のtitle要素)は元々fontSize:32等で十分大きいが、
      // 文字色はheadingと同じtext-gray-900にして、階層の頂点である
      // ことを文字色でも一致させる(fontSize/line-height/paddingは
      // 変更しない、色だけの調整)。
      const isTitleText = element.role === "title";
      const textWeightClassName = isSummaryText
        ? "font-medium"
        : isHeadingText
          ? "font-semibold"
          : "";
      const textColorClassName =
        isHeadingText || isTitleText ? "text-gray-900" : "text-gray-800";
      const textLeadingClassName = isSummaryText
        ? "leading-relaxed"
        : "leading-snug";

      // STEP61: role: "heading"のcontentが既知の英語ラベルと完全
      // 一致する場合だけ、表示文字列を日本語ラベルへ差し替える
      // (DocumentModel.content自体は変更しない、表示専用の変換)。
      const displayContent =
        element.role === "heading" &&
        typeof element.content === "string" &&
        HEADING_LABEL_OVERRIDE[element.content.trim()]
          ? HEADING_LABEL_OVERRIDE[element.content.trim()]
          : element.content;

      inner = (
        <>
          {isSummaryText && (
            // STEP61で追加した「概要」ラベル。STEP62でfont-weight/
            // 文字色だけを強めた(text-gray-400→gray-500、
            // font-medium→font-semibold)。フォントサイズ・margin
            // は変更していない(summaryのheight見積もりは元々
            // executiveSummaryの改行数だけを見た概算で、既にこの
            // ラベル分の余裕を使っているため、これ以上box heightを
            // 増やす変更は行わない)。
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              {SUMMARY_LABEL}
            </p>
          )}
          <p
            style={{ margin: 0, whiteSpace: "pre-wrap", ...style }}
            className={`${textLeadingClassName} ${textColorClassName} ${textWeightClassName}`}
          >
            {element.segments && element.segments.length > 0
              ? element.segments.map((segment, index) =>
                  segment.emphasize ? (
                    <strong
                      key={index}
                      className="underline decoration-2 underline-offset-2"
                    >
                      {segment.text}
                    </strong>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  )
                )
              : displayContent}
          </p>
        </>
      );

      break;

    }

    case "list": {

      // STEP56: keyFindings/recommendations/nextActionsのitemsは、
      // 「タイトル：説明」という形の文字列であることが多いため、
      // 「：」だけを根拠に安全に分割してタイトル部分を強調する。
      // 分割できない場合は元の文字列をそのまま表示する。
      // STEP59: 判定ロジックはitemTitleSplit.tsへ共有し、
      // currentOutputToDocumentModel.ts(height見積もり)と二重実装
      // しないようにした。
      const canSplitTitle = canSplitItemTitle(element.role);

      inner = (
        <ul
          style={{ margin: 0, paddingLeft: "1.25em", ...style }}
          className={
            "list-disc text-gray-700 " +
            (canSplitTitle ? "space-y-2" : "space-y-1")
          }
        >
          {(element.items ?? []).map((item, index) => {

            const split = canSplitTitle ? splitItemTitle(item) : null;

            return (
              <li key={index} className="leading-relaxed">
                {split ? (
                  // STEP57: 「タイトル：説明」を1行のインライン表示
                  // ではなく、タイトルを1行目・説明を2行目に置く
                  // 縦積みのブロック表示にし、「タイトル→説明」という
                  // 視覚的な関係をより明確にした(要件4の
                  // 「市場成長率/今後3年間で...」という例に対応)。
                  // STEP58: titleはleading-snug(タイトルらしく引き
                  // 締まった行間)、descriptionはliから継承される
                  // leading-relaxed(読みやすい行間)のままにし、
                  // 「タイトルは強く・締まって」「説明は落ち着いて・
                  // 読みやすく」という対比を作る。
                  <>
                    {/* STEP62: 「タイトル：説明」に分割できるitemの
                        タイトル部分だけに、1色の下線(text-decoration)
                        で重要部分を示す。新しい重要度判定は行わず、
                        STEP56〜59で既に確立された分割構造(=タイトル
                        部分)をそのまま「重要部分」とみなすだけ。
                        text-decorationは文字の実際の幅にだけ沿って
                        引かれるため、item box全体に線が伸びることは
                        ない。説明部分(下のdiv)には一切適用しない。 */}
                    <div
                      className="underline decoration-2 underline-offset-2 font-semibold leading-snug text-gray-900"
                      style={{ textDecorationColor: IMPORTANT_UNDERLINE_COLOR }}
                    >
                      {split.title}
                    </div>
                    {/* STEP63: 説明部分がtext-gray-600のままだと
                        白背景に対してコントラストが弱く「資料として
                        読むには薄い」状態になっていた。タイトル
                        (text-gray-900+下線)ほど強くはしないが、
                        text-gray-700に上げて可読性を底上げする
                        (フォントサイズ・行間・paddingは変更しない、
                        色のみの調整でheight見積もりへの影響はない)。 */}
                    <div className="mt-1 text-gray-700">
                      {split.rest}
                    </div>
                  </>
                ) : (
                  item
                )}
              </li>
            );

          })}
        </ul>
      );

      break;

    }

    case "table":

      inner = <TableView element={element} style={style} />;

      break;

    case "shape":
    case "image":
    case "group":
    default:

      // STEP140: element.assetが設定されている場合(=既存素材への
      // 参照を持つ場合)のみ、専用のプレビュー表示にする。
      // assetが無い場合はSTEP47時点からの挙動を完全に維持する
      // (後方互換)。
      inner = element.asset ? (
        <AssetPreview asset={element.asset} />
      ) : (
        // STEP47時点では生成経路が存在しないtype。DocumentModelの
        // 構造上は許容されているため、クラッシュせず安全な
        // プレースホルダーとして表示するだけに留める。
        <div className="flex h-full items-center justify-center text-[10px] text-gray-400">
          ({element.type})
        </div>
      );

  }

  return (

    <div
      data-element-id={element.id}
      data-element-type={element.type}
      data-selected={isSelected ? "true" : "false"}
      style={boxStyle}
      onClick={handleClick}
    >
      {inner}
    </div>

  );

}

function computePageHeight(page: DocumentPage): number {

  if (page.elements.length === 0) return PAGE_MIN_HEIGHT;

  const maxBottom = Math.max(
    ...page.elements.map((el) => el.position.y + el.size.height)
  );

  return Math.max(PAGE_MIN_HEIGHT, maxBottom + PAGE_PADDING);

}

type PageViewProps = {
  page: DocumentPage;
  pageNumber: number;
  selectedElementId: string | null;
  onSelectElement: (id: string) => void;
};

function PageView({
  page,
  pageNumber,
  selectedElementId,
  onSelectElement,
}: PageViewProps) {

  const height = computePageHeight(page);

  // STEP48: addTextのようなPage単位のOperationはtargetIdがPage id
  // になる(mockDesignAgent.ts参照)。Element単位のハイライトとは
  // 別の見た目(box-shadowによる外枠)で「ページ全体」を軽く示す。
  const isPageSelected = page.id === selectedElementId;

  return (

    <div
      data-page-id={page.id}
      data-page-selected={isPageSelected ? "true" : "false"}
      style={{
        width: PAGE_WIDTH,
        height,
        boxShadow: isPageSelected
          ? `0 0 0 3px rgba(37, 99, 235, 0.35)`
          : undefined,
      }}
      className="
        relative mx-auto mb-10 rounded-lg border border-gray-200
        bg-white shadow-sm
      "
    >

      <span
        className="
          pointer-events-none absolute -top-5 left-1
          text-[10px] font-medium uppercase tracking-wide text-gray-400
        "
      >
        Page {pageNumber}
      </span>

      {page.elements.map((element) => (
        <ElementView
          key={element.id}
          element={element}
          selectedElementId={selectedElementId}
          onSelectElement={onSelectElement}
        />
      ))}

    </div>

  );

}

type Props = {
  documentModel: DocumentModel;
  // STEP48: 「表示上の選択状態」。DocumentModelには含まれない、
  // app/design/page.tsxが所有するstate。nullは未選択。
  selectedElementId: string | null;
  onSelectElement: (id: string) => void;
};

export default function DocumentRenderer({
  documentModel,
  selectedElementId,
  onSelectElement,
}: Props) {

  return (

    <div className="h-full overflow-y-auto px-8 py-10">

      <p
        className="mb-6 text-center text-xs font-semibold uppercase tracking-widest text-gray-400"
        style={{ width: PAGE_WIDTH, marginInline: "auto" }}
      >
        {documentModel.title}
      </p>

      {documentModel.pages.length === 0 ? (

        <p className="text-center text-sm text-gray-400">
          表示できるページがありません。
        </p>

      ) : (

        documentModel.pages.map((page, index) => (
          <PageView
            key={page.id}
            page={page}
            pageNumber={index + 1}
            selectedElementId={selectedElementId}
            onSelectElement={onSelectElement}
          />
        ))

      )}

    </div>

  );

}
