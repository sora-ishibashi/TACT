"use client";

// =========================
// AIPanel (STEP42〜STEP46 / TACT Design)
// =========================
//
// Floating AI Buttonから展開する、フローティングのAI会話パネル。
// 常設サイドバーにはしない(資料編集画面を圧迫しないため)。
//
// STEP43: 単純な固定文言(buildMockResponse)を返すだけだったSTEP42の
// mock処理を、
//   User Input → DesignIntent → DocumentOperation → AI Panel表示
// という中間表現を経由する構造へ置き換えた。まだ実LLMには接続せず、
// mockDesignAgent.tsのキーワード判定だけで生成する。
//
// STEP44: TACTのcurrentOutputをDocument Modelへ変換する
// Adapter(currentOutputToDocumentModel)を実装(型・変換ロジックのみ)。
//
// STEP45: STEP43で使っていた固定のMOCK_DOCUMENT依存を廃止し、
// TACT成果物(サンプルのcurrentOutput、まだDB/API接続はしない)から
// currentOutputToDocumentModel()で生成したDocument Modelを、
// このAI Panelの実際の編集対象として保持するようにした。
// DesignIntent.targetは、rawInputのキーワードから実際のElement id
// へ解決し(resolveTargetElementId)、解決できた場合のみ操作案を
// 生成する。「適用」を押した場合だけDocument Modelの対象Elementを
// 実際に変更し(applyDocumentOperation)、「却下」の場合は一切
// 変更しない。TACT本体のcurrentOutput自体はどちらの場合も
// 変更しない(読み取り専用のまま)。
//
// STEP46: STEP45まではchangeStyle以外のOperationが実質的に
// 「説明文をstyleに書き込むだけ」だったが、moveElement/
// resizeElement/deleteText/addTextを実際にDocument Modelへ
// 反映するよう拡張した(詳細はmockDesignAgent.ts参照)。
//
// STEP47: documentModelの所有(useState)をこのコンポーネントから
// app/design/page.tsxへ移動した。DocumentRenderer(STEP47新規)が
// 「AI Panelが編集しているのと同じDocumentModel」を描画するには、
// 親(page.tsx)がstateを持ち、AIPanel/DocumentRendererの両方へ
// 渡す必要があるため(状態の持ち上げ)。AIPanel自体の役割
// (AIとの対話・操作案の承認)は変わっていない。
//
// STEP48: Operationカードをクリックすると、そのOperation.targetId
// をselectedElementId(page.tsx所有、DocumentRendererと共有)として
// 選択する。Apply時は対象をそのまま選択状態にし、Rejectは
// (現在その対象が選択中だった場合のみ)選択解除する。
// selectedElementId自体の所有・DocumentModelとの整合性チェックは
// page.tsx側の責務(このコンポーネントはpropsを読むだけ)。
//
// STEP49: Operationカードが内部ID(page-0-title-0等)や生のchanges
// JSONをそのまま表示していたのを、人間可読なラベル・説明文へ
// 変換して表示するようにした(describeTarget/describeChanges)。
// 複数Operationの独立性(Apply/Rejectが他のOperationへ影響しない)は
// STEP43〜48時点で既にmessage.operations.map()による不変更新
// (対象operation.idだけを書き換える)で確立済みのため、今回は
// 表示面の改善のみで、状態管理の構造自体は変更していない。

import { useState } from "react";
import { useDraggable, Position } from "./useDraggable";
import {
  applyDocumentOperation,
  generateDesignIntent,
  generateDocumentOperations,
} from "./mockDesignAgent";
import {
  AssetReference,
  DesignIntent,
  DocumentElement,
  DocumentModel,
  DocumentOperation,
  DocumentOperationStatus,
} from "./types";
import type { AssetSuggestions } from "./assetDiscovery";

export const PANEL_WIDTH = 340;
export const PANEL_HEIGHT = 460;

interface Message {
  role: "user" | "ai";
  content: string;
  // STEP43: AI側の応答にだけ、生成された中間表現を添付する。
  intent?: DesignIntent;
  operations?: DocumentOperation[];
}

const INITIAL_MESSAGE: Message = {
  role: "ai",
  content:
    "こんにちは。資料について気になる点があれば教えてください。" +
    "（現時点ではmockのDesignIntent/DocumentOperation生成のみです）",
};

// =========================
// buildAssetSuggestionMessage (最速実装モード STEP1)
// =========================
//
// TACT CoreのcurrentOutputから自動的に判明した「必要そうな既存素材」
// (STEP140のderiveAssetSuggestions())を、初回メッセージとして
// 提示する。解決できたものはplaceAsset操作案(Apply/Reject)として、
// 解決できなかったものは「見つかりませんでした」という文章として
// そのまま伝える(STEP140の最重要原則: 生成による補完はしない)。
function buildAssetSuggestionMessage(
  suggestions: AssetSuggestions,
  documentModel: DocumentModel
): Message | null {

  if (
    suggestions.resolved.length === 0 &&
    suggestions.unresolved.length === 0
  ) {
    return null;
  }

  const firstPageId = documentModel.pages[0]?.id;

  const operations: DocumentOperation[] = firstPageId
    ? suggestions.resolved.map((s) => ({
        id: crypto.randomUUID(),
        type: "placeAsset",
        targetId: firstPageId,
        changes: { asset: s.asset },
        sourceIntentId: "auto-suggestion",
        status: "proposed" as DocumentOperationStatus,
      }))
    : [];

  const lines: string[] = [
    "この資料の内容から、既存素材で対応できそうな箇所を確認しました。",
  ];

  if (suggestions.resolved.length > 0) {
    lines.push(
      `${suggestions.resolved.length}件、既存素材の候補が見つかりました。` +
      "内容を確認のうえ、適用/却下を選んでください。"
    );
  }

  if (suggestions.unresolved.length > 0) {
    lines.push(
      "以下は該当する既存素材が見つかりませんでした" +
      "（新しい素材は生成していません）：\n" +
      suggestions.unresolved
        .map((u) => `・${u.query.description}`)
        .join("\n")
    );
  }

  return {
    role: "ai",
    content: lines.join("\n\n"),
    operations,
  };

}

// STEP49: 実際にapplyDocumentOperation(mockDesignAgent.ts)が意味の
// ある変更を行うOperation typeだけ、具体的な日本語ラベルを持つ。
// それ以外(changeLayout/addElement/duplicateElement等、STEP46時点で
// 適用ロジックが未実装のもの)は、ユーザーに誤解を与えないよう
// 汎用的な「変更案」にフォールバックする。
const OPERATION_TYPE_LABELS: Partial<Record<DocumentOperation["type"], string>> = {
  changeStyle: "スタイルを変更",
  moveElement: "位置を変更",
  resizeElement: "サイズを変更",
  deleteText: "テキストを削減",
  replaceText: "テキストを置換",
  addText: "テキストを追加",
  deleteElement: "要素を削除",
  // STEP140で追加。
  placeAsset: "既存素材を配置",
};

export function operationTypeLabel(type: DocumentOperation["type"]): string {

  return OPERATION_TYPE_LABELS[type] ?? "変更案";

}

// STEP140で追加。placeAsset操作の説明表示(describeChanges)で使う。
const ASSET_SOURCE_LABELS: Record<AssetReference["source"], string> = {
  powerpoint: "PowerPoint",
  canva: "Canva",
  uploaded: "アップロード済み",
};

export function statusLabel(status: DocumentOperationStatus): string {

  if (status === "applied") return "✓ 適用済み";
  if (status === "rejected") return "却下済み";
  return "変更案";

}

// =========================
// describeTarget (STEP49)
// =========================
//
// Operation.targetId(page-0-title-0等の内部ID、またはaddTextの
// 場合はPage id)を、ユーザー向けの人間可読ラベルへ変換する純粋関数。
// 既存のid規約(`${pageId}-title-${n}`等、currentOutputToDocumentModel/
// mockDesignAgent.ts由来)を軽く読むだけで、複雑な専用パーサーは
// 作らない。DocumentModel内に対応する対象が実在しない場合は、
// 安全な文言にフォールバックする(要件9のクラッシュ防止と両立)。

function describeElementKind(element: DocumentElement): string {

  if (element.id.includes("-title-")) return "タイトル";
  if (element.type === "list") return "箇条書き";
  if (element.type === "table") return "表";
  if (element.type === "text") return "本文";

  return "要素";

}

export function describeTarget(
  targetId: string,
  documentModel: DocumentModel
): string {

  // addTextのようなPage単位のOperationは、targetIdがPage idになる
  // (mockDesignAgent.ts参照)。
  const pageIndex = documentModel.pages.findIndex((p) => p.id === targetId);

  if (pageIndex !== -1) {
    return `${pageIndex + 1}ページ目`;
  }

  for (let i = 0; i < documentModel.pages.length; i++) {

    const element = documentModel.pages[i].elements.find(
      (el) => el.id === targetId
    );

    if (element) {
      return `${i + 1}ページ目の${describeElementKind(element)}`;
    }

  }

  return "対象を特定できません";

}

// =========================
// describeChanges (STEP49)
// =========================
//
// Operation.changes(内部的にはRecord<string, unknown>)を、生の
// JSONではなくユーザーが理解できる短い説明文へ変換する。
// 現在のmockDesignAgent.tsが実際に生成する形(changeStyleの
// fontSize/fontWeight、moveElementのposition差分、resizeElementの
// 絶対size等)から確実に読み取れる情報だけを使い、読み取れない
// 場合は安全な既定文言にフォールバックする(存在しない情報を
// 推測しない)。

export function describeChanges(operation: DocumentOperation): string[] {

  const changes = operation.changes;

  switch (operation.type) {

    case "changeStyle": {

      const lines: string[] = [];

      if (typeof changes.fontSize === "number") {
        lines.push(`文字サイズを${changes.fontSize}pxに変更`);
      }

      if (typeof changes.fontWeight === "string") {
        lines.push(
          changes.fontWeight === "bold"
            ? "太字に変更"
            : `文字の太さを${changes.fontWeight}に変更`
        );
      }

      // STEP50: mockDesignAgent.tsのcomputeStyleChangesがfontStyle/
      // textAlignも生成するようになったため、こちらも表示する。
      if (typeof changes.fontStyle === "string") {
        lines.push(
          changes.fontStyle === "italic"
            ? "斜体に変更"
            : `文字のスタイルを${changes.fontStyle}に変更`
        );
      }

      if (typeof changes.textAlign === "string") {
        const alignLabels: Record<string, string> = {
          center: "中央揃えに変更",
          left: "左揃えに変更",
          right: "右揃えに変更",
        };
        lines.push(
          alignLabels[changes.textAlign] ??
            `文字揃えを${changes.textAlign}に変更`
        );
      }

      return lines.length > 0 ? lines : ["スタイルを変更"];

    }

    case "moveElement": {

      const position = changes.position as
        | { x?: number; y?: number }
        | undefined;

      if (!position) return ["位置を変更"];

      const parts: string[] = [];

      if (typeof position.x === "number" && position.x !== 0) {
        parts.push(
          position.x > 0
            ? `右に${position.x}px`
            : `左に${Math.abs(position.x)}px`
        );
      }

      if (typeof position.y === "number" && position.y !== 0) {
        parts.push(
          position.y > 0
            ? `下に${position.y}px`
            : `上に${Math.abs(position.y)}px`
        );
      }

      return parts.length > 0 ? [`${parts.join("、")}移動`] : ["位置を変更"];

    }

    case "resizeElement": {

      const size = changes.size as
        | { width?: number; height?: number }
        | undefined;

      if (
        size &&
        typeof size.width === "number" &&
        typeof size.height === "number"
      ) {
        return [`サイズを${size.width} × ${size.height}pxに変更`];
      }

      return ["サイズを変更"];

    }

    case "deleteText":
      return ["文章量を削減"];

    case "replaceText":
      return ["テキストを置き換え"];

    case "addText":
      return ["新しいテキストを追加"];

    case "deleteElement":
      return ["要素を削除"];

    // STEP140で追加。changes.assetは必ずAssetReference(既存素材
    // への参照)であり、TACTが新しく生成した画像・図形ではない。
    case "placeAsset": {

      const asset = changes.asset as AssetReference | undefined;

      if (!asset) return ["既存素材を配置"];

      const sourceLabel = ASSET_SOURCE_LABELS[asset.source] ?? asset.source;

      const title = asset.metadata?.title ?? "(タイトル不明)";

      return [
        `${sourceLabel}の既存素材「${title}」を配置`,
        `種類: ${asset.type}`,
      ];

    }

    default:
      // STEP46時点で意味づけが未実装のOperation type
      // (changeLayout/addElement/duplicateElement等)。
      return ["変更内容の詳細は未定義です"];

  }

}

type Props = {
  initialPosition: Position;
  onClose: () => void;
  // STEP47: documentModelはこのコンポーネントの外(app/design/page.tsx)
  // が所有する。AIPanelはそれを読み、Apply時にonDocumentModelChangeで
  // 更新を通知するだけ(=このコンポーネント自身はuseStateで
  // documentModelを持たない)。
  documentModel: DocumentModel;
  onDocumentModelChange: (next: DocumentModel) => void;
  // STEP48: 選択状態も同様にpage.tsxが所有する。
  selectedElementId: string | null;
  onSelectElement: (id: string | null) => void;
  // 最速実装モード STEP1: page.tsxがCore出力から算出済みの
  // Asset提案(STEP140のderiveAssetSuggestions())。省略時は
  // 従来通りINITIAL_MESSAGEのみ表示する(後方互換)。
  initialAssetSuggestions?: AssetSuggestions;
};

export default function AIPanel({
  initialPosition,
  onClose,
  documentModel,
  onDocumentModelChange,
  selectedElementId,
  onSelectElement,
  initialAssetSuggestions,
}: Props) {

  const {
    position,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = useDraggable(initialPosition, {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
  });

  const [messages, setMessages] =
    useState<Message[]>(() => {

      const suggestionMessage =
        initialAssetSuggestions
          ? buildAssetSuggestionMessage(
              initialAssetSuggestions,
              documentModel
            )
          : null;

      return suggestionMessage
        ? [INITIAL_MESSAGE, suggestionMessage]
        : [INITIAL_MESSAGE];

    });

  const [input, setInput] = useState("");

  const [minimized, setMinimized] = useState(false);

  function handleSend() {

    const text = input.trim();

    if (!text) return;

    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
    ]);

    setInput("");

    // STEP43/45: 実LLM呼び出しは行わない。
    // User Input → DesignIntent → DocumentOperation という
    // 中間表現を、mockDesignAgent.tsのキーワード判定だけで生成する。
    // documentModelは現在の(直前までの適用結果を反映した)状態を
    // 参照する。
    window.setTimeout(() => {

      const intent = generateDesignIntent(text);

      const operations = generateDocumentOperations(
        intent,
        documentModel
      );

      const summary =
        operations.length > 0
          ? `「${text}」を、以下のような操作案として整理しました。` +
            "内容を確認のうえ、適用/却下を選んでください" +
            "（この画面ではまだ実際の資料は変更されません）。"
          : intent.action === "unknown"
            ? `「${text}」について、具体的にどの部分をどう変更したいか` +
              "がまだ曖昧です。対象(タイトル/本文/資料全体など)や、" +
              "どう変えたいかをもう少し教えてください。"
            // STEP140: useExistingAssetの場合、対象Pageは特定できて
            // いるが該当する既存Assetが見つからなかったケース。
            // 新しい素材を生成して補完することはせず、その旨を
            // そのまま伝える(STEP140の最重要原則)。
            : intent.action === "useExistingAsset"
              ? `「${text}」に該当する既存素材が見つかりませんでした。` +
                "TACT Designは新しい画像・図形を生成しないため、" +
                "既存のPowerPoint/Canva素材の中から探せる範囲でしか" +
                "対応できません。"
              : `「${text}」について、対象の要素を安全に特定できな` +
                "かったため、操作案は作成しませんでした。" +
                "「タイトル」「本文」「第1章」のように、対象を" +
                "具体的に指定してください。";

      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          content: summary,
          intent,
          operations,
        },
      ]);

    }, 300);

  }

  // STEP45: 「適用」はDocument Modelの対象Elementだけを実際に
  // 変更し(applyDocumentOperation)、「却下」はDocument Modelを
  // 一切変更しない。どちらの場合もTACT本体のcurrentOutput
  // (SAMPLE_CURRENT_OUTPUT)には触れない。
  function handleOperationDecision(
    messageIndex: number,
    operation: DocumentOperation,
    status: DocumentOperationStatus
  ) {

    // 二重適用/二重却下を避ける(既にproposedでなくなっている場合は
    // 何もしない)。
    if (operation.status !== "proposed") return;

    let appliedElementSummary: string | null = null;

    if (status === "applied") {

      const updatedDocument = applyDocumentOperation(
        documentModel,
        operation
      );

      onDocumentModelChange(updatedDocument);

      // STEP48: Apply後も対象をハイライトしたままにする
      // (要件5「変更後のElementをそのまま選択状態として維持」)。
      onSelectElement(operation.targetId);

      // STEP49: 生のJSON/内部IDではなく、人間可読なラベル・説明文で
      // 確認メッセージを組み立てる。
      appliedElementSummary =
        `${describeTarget(operation.targetId, updatedDocument)}に、` +
        `${describeChanges(operation).join("、")}を適用しました。`;

    } else if (selectedElementId === operation.targetId) {

      // STEP48: Reject時は、今まさにこのOperationの対象がハイライト
      // されていた場合のみ選択解除する(別のOperationの対象を
      // 誤って解除しないため)。
      onSelectElement(null);

    }

    setMessages((prev) => {

      const next = prev.map((message, index) => {

        if (index !== messageIndex || !message.operations) {
          return message;
        }

        return {
          ...message,
          operations: message.operations.map((op) =>
            op.id === operation.id ? { ...op, status } : op
          ),
        };

      });

      // STEP45 要件12: 適用後のDocument Modelの状態を、AI Panel上
      // (既存の会話ログ)で確認できるようにする。新しいUI要素は
      // 追加せず、既存のメッセージ表示の仕組みをそのまま使う。
      if (appliedElementSummary) {

        return [
          ...next,
          {
            role: "ai" as const,
            content: appliedElementSummary,
          },
        ];

      }

      return next;

    });

  }

  return (

    <div
      style={{
        position: "fixed",
        // AIPanelは常にinitialPosition(非null)を渡して開かれるため、
        // position自体がnullになることは実質ないが、useDraggable()の
        // 型(Position | null)を満たすためのフォールバックとして
        // initialPositionを使う。
        left: (position ?? initialPosition).x,
        top: (position ?? initialPosition).y,
        width: PANEL_WIDTH,
        // 最小化時はヘッダーだけの高さにする。
        height: minimized ? "auto" : PANEL_HEIGHT,
        zIndex: 2147483000,
      }}
      className="
        flex flex-col overflow-hidden rounded-xl border
        border-gray-200 bg-white shadow-2xl
      "
    >

      {/* Header(ここをドラッグでパネル全体を移動する) */}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ touchAction: "none" }}
        className="
          flex shrink-0 cursor-grab items-center justify-between
          border-b border-gray-200 bg-gray-900 px-3 py-2
          active:cursor-grabbing select-none
        "
      >

        <span className="text-xs font-semibold tracking-wide text-white">
          TACT Design
        </span>

        <div className="flex items-center gap-1">

          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? "パネルを展開" : "パネルを最小化"}
            className="
              rounded px-1.5 py-0.5 text-xs text-gray-300
              hover:bg-white/10 hover:text-white
            "
          >
            {minimized ? "▢" : "—"}
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="パネルを閉じる"
            className="
              rounded px-1.5 py-0.5 text-xs text-gray-300
              hover:bg-white/10 hover:text-white
            "
          >
            ✕
          </button>

        </div>

      </div>

      {!minimized && (

        <>

          {/* 会話領域 */}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">

            {messages.map((message, messageIndex) => (

              <div
                key={messageIndex}
                className={
                  "max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed " +
                  (message.role === "user"
                    ? "ml-auto whitespace-pre-wrap bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-800")
                }
              >

                <p className="whitespace-pre-wrap">
                  {message.content}
                </p>

                {/* STEP43: DesignIntent/DocumentOperationの操作案 */}

                {message.operations &&
                  message.operations.length > 0 && (

                  <div className="mt-2 space-y-2">

                    {message.operations.map((operation) => (

                      <div
                        key={operation.id}
                        // STEP48: カード全体をクリックすると、この
                        // Operationのtargetを資料上でハイライトする
                        // (DocumentRenderer側の対応するElement/Page
                        // にoutline/box-shadowが付く)。
                        onClick={() => onSelectElement(operation.targetId)}
                        className={
                          "cursor-pointer rounded-md border bg-white px-2 py-2 " +
                          (selectedElementId === operation.targetId
                            ? "border-blue-400 ring-1 ring-blue-200"
                            : "border-gray-300")
                        }
                      >

                        <div className="flex items-center justify-between">

                          <span className="font-semibold text-gray-900">
                            {operationTypeLabel(operation.type)}
                          </span>

                          <span className="text-[10px] text-gray-500">
                            {statusLabel(operation.status)}
                          </span>

                        </div>

                        <p className="mt-1 text-[11px] text-gray-500">
                          対象: {describeTarget(operation.targetId, documentModel)}
                        </p>

                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-gray-700">
                          {describeChanges(operation).map((line, index) => (
                            <li key={index}>{line}</li>
                          ))}
                        </ul>

                        {operation.status === "proposed" && (

                          <div className="mt-1.5 flex gap-1.5">

                            <button
                              type="button"
                              onClick={(e) => {
                                // STEP48: カード全体のonClick(選択)と
                                // 二重に反応しないよう伝播を止める
                                // (Apply側はhandleOperationDecision内で
                                // 明示的にonSelectElementを呼ぶため、
                                // カードのonClickは不要かつ、Reject時に
                                // 誤って再選択してしまうのを防ぐ)。
                                e.stopPropagation();
                                handleOperationDecision(
                                  messageIndex,
                                  operation,
                                  "applied"
                                );
                              }}
                              className="
                                rounded bg-gray-900 px-2 py-1 text-[10px]
                                font-medium text-white hover:bg-gray-700
                              "
                            >
                              適用
                            </button>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOperationDecision(
                                  messageIndex,
                                  operation,
                                  "rejected"
                                );
                              }}
                              className="
                                rounded border border-gray-300 px-2 py-1
                                text-[10px] font-medium text-gray-600
                                hover:bg-gray-100
                              "
                            >
                              却下
                            </button>

                          </div>

                        )}

                      </div>

                    ))}

                  </div>

                )}

              </div>

            ))}

          </div>

          {/*
            STEP48要件8: Renderer側でElementがクリックされた場合にも
            selectedElementIdが更新されるため、AIPanel側でも
            軽く分かるように表示する(UIを複雑化させない最小限の表示)。
          */}

          {selectedElementId && (

            <div className="border-t border-gray-200 px-3 py-1 text-[10px] text-gray-400">
              選択中: {describeTarget(selectedElementId, documentModel)}
            </div>

          )}

          {/* Prompt Input */}

          <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 p-2">

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSend();
              }}
              placeholder="このスライドをもっと経営層向けにして…"
              className="
                flex-1 rounded-md border border-gray-300 px-2 py-1.5
                text-xs outline-none focus:border-gray-500
              "
            />

            <button
              type="button"
              onClick={handleSend}
              className="
                rounded-md bg-gray-900 px-3 py-1.5 text-xs
                font-medium text-white transition hover:bg-gray-700
              "
            >
              送信
            </button>

          </div>

        </>

      )}

    </div>

  );

}
