"use client";

// =========================
// TACT Design (STEP42〜STEP47)
// =========================
//
// TACTとは責務を分離した別アプリとして、同一リポジトリ内の
// 新しいルート(/design)に実装する。TACT本体(app/page.tsx以下)は
// 一切変更しない。ルートグループ等でapp/layout.tsxを分岐する
// 必要もない(既存のapp/layout.tsxはフォント読み込みと
// globals.cssの適用のみで、TACT固有のヘッダー/サイドバー等の
// UIチェイン(TactInterface.tsx等)はapp/page.tsx側だけが描画して
// いるため、共有しても問題ない)。
//
// STEP42: 「資料編集画面の横にAIがいる」という関係性を成立させる
// ための最小限のプロトタイプとして、資料編集画面はプレースホルダー
// (文字だけの箱)だった。
//
// STEP47: プレースホルダーを、実際にDocumentModelを描画する
// DocumentRenderer(components/design/DocumentRenderer.tsx)へ
// 置き換えた。あわせて、documentModelの所有(useState)をAIPanel.tsx
// からこのページへ移動した(状態の持ち上げ)。DocumentRendererと
// AIPanelが「同じDocumentModel」を参照する必要があるため。
// DB/API接続はまだ実装しないため、初期状態はローカルの
// サンプルcurrentOutputから生成する。
//
// STEP48: 同様の理由でselectedElementId(表示上の選択状態)も
// このページが所有する。DocumentModelが変わってselectedElementIdの
// 指す対象(Element idまたはPage id)が消えた場合、useEffectで
// 追跡してsetStateするのではなく(このプロジェクトのReact Compiler
// 方針上、エフェクト内での同期的なsetStateは避ける)、レンダー中に
// 「今のdocumentModelに実在するか」を毎回導出し、無効なら
// 子コンポーネントへはnullとして渡す(=selectedElementIdという
// 生のstate自体はそのまま保持されるが、表示・利用される実効値は
// 常に整合性が取れている)。
//
// 最速実装モード STEP1(TACT Core → TACT Design実接続):
// ?conversationId=... がURLに付与されている場合、既存の
// GET /api/tact/conversation(app/api/tact/conversation/route.ts、
// 既存の単体取得API)から実際のConversation.currentOutputを取得し、
// SAMPLE_CURRENT_OUTPUT(デモ用の固定値)の代わりに使う。これは
// ネットワーク越しのデータ取得であり、上記コメントが言う
// 「エフェクト内での同期的なsetState」(派生状態の二重管理)とは
// 異なるカテゴリのuseEffect用途のため、既存方針とは矛盾しない
// (components/ConversationList.tsxの既存fetchパターンと同じ考え方)。
// conversationIdが無い、または取得に失敗した場合は従来通り
// SAMPLE_CURRENT_OUTPUTのまま動作する(後方互換)。

import { useEffect, useState } from "react";
import FloatingAIButton from "@/components/design/FloatingAIButton";
import AIPanel, {
  PANEL_WIDTH,
  PANEL_HEIGHT,
} from "@/components/design/AIPanel";
import DocumentRenderer from "@/components/design/DocumentRenderer";
import { currentOutputToDocumentModel } from "@/components/design/currentOutputToDocumentModel";
import type { DocumentModel } from "@/components/design/types";
import type { Position } from "@/components/design/useDraggable";
import {
  deriveAssetSuggestions,
  AssetSuggestions,
} from "@/components/design/assetDiscovery";
import { mockAssets } from "@/components/design/mockAssetLibrary";

const PANEL_MARGIN = 24;

// STEP45で導入(当時はAIPanel.tsx内)、STEP47でこのページへ移動した。
// TACTの実際の会話結果ではなく、Writer出力Schema
// (core/prompt/outputFormats.ts)と同じ形をしたローカルのサンプル
// currentOutput(将来的にはTACT側の実際の会話結果に差し替わる
// 想定の差し込み口)。
const SAMPLE_CURRENT_OUTPUT = {
  title: "在宅勤務のメリットに関するレポート",
  // STEP46: 複数文にしておく(deleteTextの「先頭文だけ残す」削減が
  // 意味を持つようにするため。単文だと削減の余地がなく、
  // 操作案自体が生成されない = mockDesignAgent.tsの安全設計)。
  executiveSummary:
    "在宅勤務には、生産性・コストの両面で複数のメリットが確認できる。" +
    "特に通勤時間の削減が大きな効果をもたらす。",
  sections: [
    {
      heading: "生産性への影響",
      content:
        "在宅勤務は通勤時間の削減により生産性を高める。\n" +
        "・集中できる環境を確保しやすい\n" +
        "・オンライン会議の効率化",
      evidenceIds: [],
    },
    {
      heading: "コストへの影響",
      content: "オフィス賃料や交通費の削減につながる。",
      evidenceIds: [],
    },
  ],
  keyFindings: [
    {
      title: "生産性向上",
      importance: 1,
      summary: "通勤時間の削減が寄与する",
    },
  ],
  recommendations: ["段階的な在宅勤務制度の導入を検討する"],
  nextActions: ["制度設計のためのアンケートを実施する"],
};

export default function TactDesignPage() {

  const [isPanelOpen, setPanelOpen] = useState(false);

  const [panelPosition, setPanelPosition] =
    useState<Position | null>(null);

  // STEP47: DocumentRenderer(表示)とAIPanel(編集操作の提案・承認)
  // が同じDocumentModelを参照するための、共有state。
  // currentOutputToDocumentModelは純粋関数であり、
  // SAMPLE_CURRENT_OUTPUT自体はどの操作でも一切変更しない。
  const [documentModel, setDocumentModel] = useState<DocumentModel>(
    () => currentOutputToDocumentModel(SAMPLE_CURRENT_OUTPUT)
  );

  // 最速実装モード STEP1: URLの?conversationId=から取得した
  // currentOutputをもとに、STEP140のAsset Discoveryを実行した結果。
  // 未取得(SAMPLE_CURRENT_OUTPUTのまま)の間はundefined
  // (AIPanel側は「提案なし」として従来通りのINITIAL_MESSAGEのみ表示)。
  const [assetSuggestions, setAssetSuggestions] =
    useState<AssetSuggestions | undefined>(undefined);

  // 最速実装モード STEP1: TACT Core → TACT Design実接続。
  // ?conversationId=が無い場合は何もせず、SAMPLE_CURRENT_OUTPUTの
  // ままにする(既存のデモ動作を完全に維持)。
  useEffect(() => {

    const params = new URLSearchParams(window.location.search);
    const conversationId = params.get("conversationId");

    if (!conversationId) return;

    let cancelled = false;

    (async () => {

      try {

        const response = await fetch(
          `/api/tact/conversation?conversationId=${conversationId}`
        );

        const data = await response.json();

        if (cancelled) return;

        if (!data.success || !data.conversation?.currentOutput) {

          console.warn(
            "[TACT Design] currentOutputが取得できなかったため、" +
            "サンプルデータのまま表示します。"
          );

          return;

        }

        const output = data.conversation.currentOutput;

        setDocumentModel(
          currentOutputToDocumentModel(output)
        );

        setAssetSuggestions(
          deriveAssetSuggestions(output, mockAssets)
        );

      } catch (error) {

        if (cancelled) return;

        console.warn(
          "[TACT Design] Conversationの取得に失敗したため、" +
          "サンプルデータのまま表示します。",
          error
        );

      }

    })();

    return () => {
      cancelled = true;
    };

  }, []);

  // STEP48: DocumentRenderer上でクリックされたElement、または
  // AIPanelのOperationカードで選択されたtargetを保持する。
  // Element idとPage idのどちらも入りうる(addTextのようなPage単位
  // のOperationのため。DocumentRenderer側で区別して描画する)。
  const [selectedElementId, setSelectedElementId] =
    useState<string | null>(null);

  // documentModel内に実在するid(Page id/Element id)の集合。
  // ApplyでElementが削除された場合等、selectedElementIdが指す対象が
  // 消えていれば、実効的な選択状態はnullとして扱う(要件11)。
  const validSelectionIds = new Set<string>();

  for (const page of documentModel.pages) {

    validSelectionIds.add(page.id);

    for (const element of page.elements) {
      validSelectionIds.add(element.id);
    }

  }

  const effectiveSelectedElementId =
    selectedElementId !== null && validSelectionIds.has(selectedElementId)
      ? selectedElementId
      : null;

  // クリック(ユーザー操作)というイベントハンドラ内でのみ
  // windowを読むため、Hydration Mismatchの心配がない
  // (useEffect内でのsetState呼び出しでもない)。
  function handleToggle() {

    setPanelOpen((prev) => {

      const next = !prev;

      if (next && panelPosition === null) {

        setPanelPosition({
          x: Math.max(
            window.innerWidth - PANEL_WIDTH - PANEL_MARGIN,
            PANEL_MARGIN
          ),
          y: Math.max(
            window.innerHeight - PANEL_HEIGHT - PANEL_MARGIN - 80,
            PANEL_MARGIN
          ),
        });

      }

      return next;

    });

  }

  return (

    <main className="relative h-screen w-screen overflow-hidden bg-gray-100">

      {/*
        STEP47: 資料編集画面。DocumentRendererがDocumentModelを
        実際に描画する(読み取り専用)。「主役は資料編集画面、
        TACT DesignはAIとしてその上に存在する」という関係性は
        STEP42から変更していない。
      */}

      <div className="h-full w-full">
        <DocumentRenderer
          documentModel={documentModel}
          selectedElementId={effectiveSelectedElementId}
          onSelectElement={setSelectedElementId}
        />
      </div>

      <FloatingAIButton
        isOpen={isPanelOpen}
        onToggle={handleToggle}
      />

      {isPanelOpen && panelPosition && (

        <AIPanel
          initialPosition={panelPosition}
          onClose={() => setPanelOpen(false)}
          documentModel={documentModel}
          onDocumentModelChange={setDocumentModel}
          selectedElementId={effectiveSelectedElementId}
          onSelectElement={setSelectedElementId}
          initialAssetSuggestions={assetSuggestions}
        />

      )}

    </main>

  );

}
