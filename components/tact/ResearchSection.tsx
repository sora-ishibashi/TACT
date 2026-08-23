"use client";

// =========================
// ResearchSection (STEP215/STEP216)
// =========================
//
// 新TACT UIの中核: 「左 = TACTとの対話 / 右 = TACTが生み出したもの」
// という基本レイアウトの、既定(TactShellの初期選択)の入口。
//
// STEP216: このコンポーネントはSTEP215までは無条件にPOST
// /api/tact/researchのみを呼んでいたが、それでは「こんにちは」等の
// 雑談まで毎回Research Pipeline(Search/LLM)へ到達してしまう問題が
// あった。STEP216で、入力ごとにcore/tact-intent/ruleRouter.tsの
// classifyIntent()(LLM不使用、純粋関数)を1回だけ実行し、判定結果に
// 応じて以下の既存3経路のいずれか1つだけを呼ぶよう変更した。
//   - "chat"       → POST /api/tact/chat(STEP216新規、Legacy非依存)
//   - "research"   → POST /api/tact/research(STEP201、無変更)
//   - "core_push"  → POST /api/tact/core/push(STEP212、無変更、
//                     Rule Routerの既定typeは"memory")
// 旧TACTの/api/tact/conversation/stream(→runConversationTurn()→
// Legacy Workflow)は引き続き一切呼び出さない(旧UIはapp/legacy/page.tsx
// へ退避済み、削除はしていない)。
//
// 責務: 入力→意図判定(1回)→API呼び出し(1回)→状態管理→結果表示だけを
// 行う。Search/LLM呼び出し・Requirement Decomposition・Knowledge Gap・
// Safety判定・Evidence選定・Retryは一切行わない(すべて各経路側の
// 既存責務のまま)。

import { useState } from "react";

import { classifyIntent } from "@/core/tact-intent/ruleRouter";
import type { TactIntent } from "@/core/tact-intent/types";
import type {
  ResearchResult,
  ResearchEvidenceItem,
} from "@/core/tact-research/types";

type ChatMessage = {
  id: string;
  role: "user" | "tact";
  content: string;
  intent?: TactIntent;
  result?: ResearchResult;
  pushConfirmation?: { type: string; itemId?: string };
  apiError?: string;
};

function ConfidenceBadge({
  confidence,
}: {
  confidence: ResearchEvidenceItem["confidence"];
}) {

  const colorClass =
    confidence === "high"
      ? "bg-green-100 text-green-700"
      : confidence === "medium"
        ? "bg-yellow-100 text-yellow-700"
        : "bg-gray-100 text-gray-600";

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colorClass}`}>
      {confidence}
    </span>
  );

}

function EvidenceItemView({ item }: { item: ResearchEvidenceItem }) {

  return (

    <li className="rounded-lg border border-gray-200 p-3 text-sm">

      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-gray-900">{item.claim}</p>
        <ConfidenceBadge confidence={item.confidence} />
      </div>

      {item.snippet && (
        <p className="mt-1 text-xs text-gray-500">{item.snippet}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">

        {item.source && (
          <a
            href={item.source}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            {item.source}
          </a>
        )}

        <details className="text-gray-400">
          <summary className="cursor-pointer select-none">evidence id</summary>
          <code className="break-all">{item.id}</code>
        </details>

      </div>

    </li>

  );

}

// STEP215: metadataから、対話の視線移動として意味のある値だけを
// 抜粋して表示する(生のJSONをそのまま出さない、STEP202以来の方針を
// 右パネルでも踏襲)。
function MetadataStrip({ metadata }: { metadata: ResearchResult["metadata"] }) {

  return (

    <div className="flex flex-wrap gap-2 text-[10px] text-gray-400">
      <span className="rounded bg-gray-100 px-2 py-0.5">mode: {metadata.executionMode}</span>
      <span className="rounded bg-gray-100 px-2 py-0.5">llmAttempts: {metadata.llmAttempts}</span>
      <span className="rounded bg-gray-100 px-2 py-0.5">knowledge: {metadata.usedKnowledgeCount}</span>
      <span className="rounded bg-gray-100 px-2 py-0.5">memory: {metadata.usedMemoryCount}</span>
      <span className="rounded bg-gray-100 px-2 py-0.5">example: {metadata.usedExampleCount}</span>
      {metadata.safetyDowngradeCount > 0 && (
        <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">
          safety downgrade: {metadata.safetyDowngradeCount}
        </span>
      )}
    </div>

  );

}

export default function ResearchSection() {

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const selected =
    messages.find((m) => m.id === selectedId) ??
    [...messages].reverse().find((m) => m.role === "tact");

  async function handleSubmit() {

    const query = input.trim();

    if (!query || loading) {
      return;
    }

    const userMessageId = crypto.randomUUID();

    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user", content: query },
    ]);

    setInput("");
    setLoading(true);

    // STEP216: LLM/Search呼び出しの前に、まず無コストのRule Routerで
    // 意図を判定する(1回のみ)。
    const decision = classifyIntent(query);

    const tactMessageId = crypto.randomUUID();

    try {

      if (decision.intent === "research") {

        // STEP201/STEP211から無変更のResearch経路。
        const response = await fetch("/api/tact/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });

        const body = await response.json();

        if (!response.ok) {

          setMessages((prev) => [
            ...prev,
            {
              id: tactMessageId,
              role: "tact",
              intent: decision.intent,
              content: "",
              apiError:
                typeof body.error === "string"
                  ? body.error
                  : `リクエストに失敗しました(HTTP ${response.status})`,
            },
          ]);

          setSelectedId(tactMessageId);

          return;

        }

        const result = body as ResearchResult;

        setMessages((prev) => [
          ...prev,
          {
            id: tactMessageId,
            role: "tact",
            intent: decision.intent,
            content: result.success ? result.answer : "Researchが完了しませんでした。",
            result,
          },
        ]);

        setSelectedId(tactMessageId);

      } else if (decision.intent === "core_push") {

        // STEP212から無変更のDirect Push経路。Rule Routerの既定
        // typeを使う(自然文からのknowledge/memory/example自動分類は
        // STEP216スコープ外)。
        const response = await fetch("/api/tact/core/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: query,
            type: decision.corePushType ?? "memory",
          }),
        });

        const body = await response.json();

        if (!response.ok || !body.success) {

          setMessages((prev) => [
            ...prev,
            {
              id: tactMessageId,
              role: "tact",
              intent: decision.intent,
              content: "",
              apiError:
                typeof body.error === "string"
                  ? body.error
                  : `Core Pushに失敗しました(HTTP ${response.status})`,
            },
          ]);

          setSelectedId(tactMessageId);

          return;

        }

        setMessages((prev) => [
          ...prev,
          {
            id: tactMessageId,
            role: "tact",
            intent: decision.intent,
            content: `TACT Coreへ保存しました(${body.type})。`,
            pushConfirmation: { type: body.type, itemId: body.item?.id },
          },
        ]);

        setSelectedId(tactMessageId);

      } else {

        // "chat": STEP216新規のChat Handler経路。Legacy Workflow
        // (runConversationTurn等)は呼ばない。
        const response = await fetch("/api/tact/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: query }),
        });

        const body = await response.json();

        if (!response.ok || !body.success) {

          setMessages((prev) => [
            ...prev,
            {
              id: tactMessageId,
              role: "tact",
              intent: decision.intent,
              content: "",
              apiError:
                typeof body.error === "string"
                  ? body.error
                  : `リクエストに失敗しました(HTTP ${response.status})`,
            },
          ]);

          setSelectedId(tactMessageId);

          return;

        }

        setMessages((prev) => [
          ...prev,
          {
            id: tactMessageId,
            role: "tact",
            intent: decision.intent,
            content: body.response as string,
          },
        ]);

        setSelectedId(tactMessageId);

      }

    } catch (error) {

      console.error("TACT API call failed:", error);

      setMessages((prev) => [
        ...prev,
        {
          id: tactMessageId,
          role: "tact",
          intent: decision.intent,
          content: "",
          apiError: "TACTとの通信に失敗しました",
        },
      ]);

      setSelectedId(tactMessageId);

    } finally {

      setLoading(false);

    }

  }

  return (

    <div className="flex h-full min-w-0 flex-1">

      {/* 左: TACTとの対話 */}
      <div className="flex h-full min-w-0 flex-1 flex-col border-r border-gray-200">

        <div className="border-b border-gray-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Chat</h2>
          <p className="text-xs text-gray-400">
            TACTと話してください。内容に応じて、雑談・調査(Research)・記憶(Core)へ自動的に振り分けます。
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">

          {messages.length === 0 && (
            <p className="text-sm text-gray-400">
              まだ会話はありません。下の入力欄から質問してみてください。
            </p>
          )}

          {messages.map((message) => (

            <button
              key={message.id}
              type="button"
              onClick={() => message.role === "tact" && setSelectedId(message.id)}
              className={`block w-full rounded-xl px-4 py-2.5 text-left text-sm ${
                message.role === "user"
                  ? "ml-auto max-w-[85%] bg-black text-white"
                  : `max-w-[85%] border ${
                      selectedId === message.id
                        ? "border-black"
                        : "border-gray-200 hover:border-gray-300"
                    } bg-gray-50 text-gray-900`
              }`}
            >
              {message.apiError ? (
                <span className="text-red-600">{message.apiError}</span>
              ) : (
                message.content || "…"
              )}
            </button>

          ))}

          {loading && (
            <p className="text-sm text-gray-400">TACTが応答を準備しています...</p>
          )}

        </div>

        <div className="border-t border-gray-200 p-3">

          <div className="flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2">

            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSubmit();
                }
              }}
              type="text"
              placeholder="TACTに話しかけてください..."
              className="flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
            />

            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="shrink-0 rounded-lg bg-black px-3 py-1.5 text-xs text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              送信
            </button>

          </div>

        </div>

      </div>

      {/* 右: TACTが生み出したもの */}
      <div className="hidden h-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5 md:flex">

        {!selected ? (

          <p className="text-sm text-gray-400">
            TACTの応答・調査結果・保存内容がここに表示されます。
          </p>

        ) : selected.result ? (

          // STEP216: intent === "research"の場合(既存表示、無変更)。
          <div className="space-y-4">

            <MetadataStrip metadata={selected.result.metadata} />

            {selected.result.success ? (

              <p className="whitespace-pre-wrap text-base leading-relaxed text-gray-900">
                {selected.result.answer}
              </p>

            ) : (

              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                <p>Researchが完了しませんでした。</p>
                {selected.result.errorMessage && (
                  <p className="mt-1 text-xs text-red-600">{selected.result.errorMessage}</p>
                )}
              </div>

            )}

            {selected.result.evidence.length > 0 && (

              <div>

                <p className="mb-2 text-xs font-medium text-gray-500">根拠(Evidence)</p>

                <ul className="space-y-2">
                  {selected.result.evidence.map((item) => (
                    <EvidenceItemView key={item.id} item={item} />
                  ))}
                </ul>

              </div>

            )}

          </div>

        ) : selected.pushConfirmation ? (

          // STEP216: intent === "core_push"の場合。
          <div className="space-y-3">

            <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              core_push / {selected.pushConfirmation.type}
            </span>

            <p className="whitespace-pre-wrap text-base leading-relaxed text-gray-900">
              {selected.content}
            </p>

            {selected.pushConfirmation.itemId && (
              <p className="break-all text-[10px] text-gray-400">
                id: {selected.pushConfirmation.itemId}
              </p>
            )}

          </div>

        ) : selected.apiError ? (

          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {selected.apiError}
          </div>

        ) : (

          // STEP216: intent === "chat"の場合。
          <div className="space-y-3">

            <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              chat
            </span>

            <p className="whitespace-pre-wrap text-base leading-relaxed text-gray-900">
              {selected.content}
            </p>

          </div>

        )}

      </div>

    </div>

  );

}
