"use client";

// =========================
// TACT Design (STEP42〜STEP47、開発指示「PowerPoint資料編集基盤」で再構成)
// =========================
//
// TACTとは責務を分離した別アプリとして、同一リポジトリ内の
// 新しいルート(/design)に実装する。TACT本体(app/page.tsx以下)は
// 一切変更しない。
//
// 開発指示(PowerPoint資料編集基盤): このPhaseで、読み取り専用
// DocumentRendererを主役としていた画面構成を、
//
//   Slides(左) | Canvas(中央、直接編集可能) | Properties(右)
//
// という3ペイン構成へ再構成した(開発指示 Section9のUI基本思想)。
// 既存のFloatingAIButton/AIPanel(STEP42〜、mockDesignAgent.tsによる
// 自然言語→DesignIntent→DocumentOperationのモック実装)は削除せず、
// そのままCanvasの上に浮かせて共存させる(開発指示 Section6「TACTへの
// 指示」「直接編集」という2つの編集方式の共存)。AIPanel/
// FloatingAIButton/mockDesignAgent.ts/DocumentRenderer.tsxは無変更。
//
// 新規: SlidePanel.tsx(Slide一覧・追加・削除・複製・並び替え)、
// CanvasEditor.tsx(直接編集可能なCanvas)、PropertiesPanel.tsx
// (Text/Object編集)、documentModelOps.ts(編集ロジック本体)、
// pptxExport.ts/pptxImport.ts(.pptx相互変換)、projectFile.ts
// (保存/読込、DBは新設せずファイルダウンロード/アップロードで実現)。
//
// LLM/APIは一切使用しない(開発指示の絶対条件)。

import { useEffect, useRef, useState } from "react";
import FloatingAIButton from "@/components/design/FloatingAIButton";
import AIPanel, {
  PANEL_WIDTH,
  PANEL_HEIGHT,
} from "@/components/design/AIPanel";
import SlidePanel from "@/components/design/SlidePanel";
import CanvasEditor from "@/components/design/CanvasEditor";
import PropertiesPanel from "@/components/design/PropertiesPanel";
import { currentOutputToDocumentModel } from "@/components/design/currentOutputToDocumentModel";
import type { DocumentModel } from "@/components/design/types";
import type { Position } from "@/components/design/useDraggable";
import {
  deriveAssetSuggestions,
  AssetSuggestions,
} from "@/components/design/assetDiscovery";
import { mockAssets } from "@/components/design/mockAssetLibrary";
import { addSlide } from "@/components/design/documentModelOps";
import { exportDocumentModelToPptx, buildPptxFilename } from "@/components/design/pptxExport";
import { importPptxToDocumentModel } from "@/components/design/pptxImport";
import {
  buildProjectFilename,
  parseDocumentModel,
  serializeDocumentModel,
} from "@/components/design/projectFile";

const PANEL_MARGIN = 24;

// STEP45で導入(当時はAIPanel.tsx内)、STEP47でこのページへ移動した。
// TACTの実際の会話結果ではなく、Writer出力Schema
// (core/prompt/outputFormats.ts)と同じ形をしたローカルのサンプル
// currentOutput(将来的にはTACT側の実際の会話結果に差し替わる
// 想定の差し込み口)。
const SAMPLE_CURRENT_OUTPUT = {
  title: "在宅勤務のメリットに関するレポート",
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

function downloadBlob(blob: Blob, filename: string): void {

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);

}

export default function TactDesignPage() {

  const [isPanelOpen, setPanelOpen] = useState(false);

  const [panelPosition, setPanelPosition] =
    useState<Position | null>(null);

  const [documentModel, setDocumentModel] = useState<DocumentModel>(
    () => currentOutputToDocumentModel(SAMPLE_CURRENT_OUTPUT)
  );

  const [assetSuggestions, setAssetSuggestions] =
    useState<AssetSuggestions | undefined>(undefined);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const jsonFileInputRef = useRef<HTMLInputElement | null>(null);
  const pptxFileInputRef = useRef<HTMLInputElement | null>(null);

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

  const [currentPageId, setCurrentPageId] = useState<string | null>(null);

  // 選択状態(複数選択対応、グループ化のため)。documentModelが変わって
  // 選択対象が消えた場合、effective値としてフィルタする
  // (既存selectedElementId方式(STEP48)と同じ考え方を複数選択へ拡張)。
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);

  const allIds = new Set<string>();

  for (const page of documentModel.pages) {

    allIds.add(page.id);

    for (const element of page.elements) {
      allIds.add(element.id);
    }

  }

  const effectiveCurrentPageId =
    currentPageId && documentModel.pages.some((p) => p.id === currentPageId)
      ? currentPageId
      : (documentModel.pages[0]?.id ?? null);

  const currentPage = documentModel.pages.find(
    (p) => p.id === effectiveCurrentPageId
  );

  const effectiveSelectedElementIds = selectedElementIds.filter((id) =>
    allIds.has(id)
  );

  // AIPanel(STEP48、単一選択のみを扱う既存インターフェース)との
  // 互換のため、複数選択の先頭要素だけを渡す(AIPanel自体は変更しない)。
  const effectiveSelectedElementIdForAIPanel =
    effectiveSelectedElementIds.length > 0 ? effectiveSelectedElementIds[0] : null;

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

  function handleNewProject() {

    const blank: DocumentModel = {
      id: `document-${Date.now()}`,
      title: "無題のプレゼンテーション",
      pages: [],
    };

    const withOneSlide = addSlide(blank);

    setDocumentModel(withOneSlide);
    setCurrentPageId(withOneSlide.pages[0]?.id ?? null);
    setSelectedElementIds([]);
    setStatusMessage("新しいプレゼンテーションを作成しました。");

  }

  function handleSaveJson() {

    const json = serializeDocumentModel(documentModel);
    const blob = new Blob([json], { type: "application/json" });

    downloadBlob(blob, buildProjectFilename(documentModel));
    setStatusMessage("プロジェクトファイルを保存しました。");

  }

  function handleOpenJsonFile(e: React.ChangeEvent<HTMLInputElement>) {

    const file = e.target.files?.[0];

    e.target.value = "";

    if (!file) return;

    file.text().then((text) => {

      const result = parseDocumentModel(text);

      if (!result.success || !result.documentModel) {

        setStatusMessage(result.error ?? "読み込みに失敗しました。");
        return;

      }

      setDocumentModel(result.documentModel);
      setCurrentPageId(result.documentModel.pages[0]?.id ?? null);
      setSelectedElementIds([]);
      setStatusMessage("プロジェクトファイルを読み込みました。");

    });

  }

  async function handleExportPptx() {

    setStatusMessage("PowerPointファイルを生成しています...");

    try {

      const blob = await exportDocumentModelToPptx(documentModel);

      downloadBlob(blob, buildPptxFilename(documentModel));
      setStatusMessage("PowerPointファイル(.pptx)を書き出しました。");

    } catch (error) {

      console.error("[TACT Design] pptx export failed:", error);
      setStatusMessage("PowerPointファイルの生成に失敗しました。");

    }

  }

  function handleImportPptxFile(e: React.ChangeEvent<HTMLInputElement>) {

    const file = e.target.files?.[0];

    e.target.value = "";

    if (!file) return;

    setStatusMessage("PowerPointファイルを読み込んでいます...");

    file.arrayBuffer().then(async (buffer) => {

      const result = await importPptxToDocumentModel(buffer, file.name.replace(/\.pptx$/i, ""));

      if (!result.success || !result.documentModel) {

        setStatusMessage(result.error ?? "読み込みに失敗しました。");
        return;

      }

      setDocumentModel(result.documentModel);
      setCurrentPageId(result.documentModel.pages[0]?.id ?? null);
      setSelectedElementIds([]);

      setStatusMessage(
        result.warnings.length > 0
          ? `読み込みました(一部情報は復元されません: ${result.warnings.join(" ")})`
          : "PowerPointファイルを読み込みました。"
      );

    });

  }

  return (

    <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-gray-100">

      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3">

        <span className="mr-2 text-xs font-semibold text-gray-900">TACT Design</span>

        <button
          type="button"
          onClick={handleNewProject}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          新規
        </button>

        <button
          type="button"
          onClick={() => jsonFileInputRef.current?.click()}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          開く
        </button>

        <input
          ref={jsonFileInputRef}
          type="file"
          accept=".json,.tactdesign.json"
          className="hidden"
          onChange={handleOpenJsonFile}
        />

        <button
          type="button"
          onClick={handleSaveJson}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          保存
        </button>

        <span className="mx-1 h-4 w-px bg-gray-200" />

        <button
          type="button"
          onClick={() => pptxFileInputRef.current?.click()}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          PowerPointを読み込む
        </button>

        <input
          ref={pptxFileInputRef}
          type="file"
          accept=".pptx"
          className="hidden"
          onChange={handleImportPptxFile}
        />

        <button
          type="button"
          onClick={handleExportPptx}
          className="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-700"
        >
          PowerPointとして書き出す
        </button>

        {statusMessage && (
          <span className="ml-3 truncate text-xs text-gray-400">{statusMessage}</span>
        )}

      </div>

      {/* Slides | Canvas | Properties */}
      <div className="flex min-h-0 flex-1">

        <SlidePanel
          documentModel={documentModel}
          onDocumentModelChange={setDocumentModel}
          currentPageId={effectiveCurrentPageId}
          onSelectPage={(pageId) => {
            setCurrentPageId(pageId);
            setSelectedElementIds([]);
          }}
        />

        <div className="min-w-0 flex-1">

          {currentPage ? (

            <CanvasEditor
              documentModel={documentModel}
              onDocumentModelChange={setDocumentModel}
              page={currentPage}
              selectedElementIds={effectiveSelectedElementIds}
              onSelectionChange={setSelectedElementIds}
            />

          ) : (

            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              スライドがありません。「新規」から作成してください。
            </div>

          )}

        </div>

        {currentPage && (

          <PropertiesPanel
            documentModel={documentModel}
            onDocumentModelChange={setDocumentModel}
            page={currentPage}
            selectedElementIds={effectiveSelectedElementIds}
            onSelectionChange={setSelectedElementIds}
          />

        )}

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
          selectedElementId={effectiveSelectedElementIdForAIPanel}
          onSelectElement={(id) => setSelectedElementIds(id ? [id] : [])}
          initialAssetSuggestions={assetSuggestions}
        />

      )}

    </main>

  );

}
