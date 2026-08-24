"use client";

// =========================
// ConversationSection (Phase 70、Phase72でBeta Entry UXを追加)
// =========================
//
// TACT Conversation Architecture(Phase64〜69で完成)を、既存TactShell
// UIから実際に操作できるようにするための最小Canonical入口。
//
// Repository Evidence(Phase70 Step2):
//   - ResearchSection.tsx/CoreSection.tsxは/api/tact/research・
//     /api/tact/chat・/api/tact/core/pushを直接fetchしており、
//     Authorizationヘッダーを一切付けていない(未認証許容の既存3経路、
//     STEP216)。このコンポーネントはそれらを一切変更せず、
//     Canonical Conversation APIのみを新たに呼ぶ独立したSectionとして
//     追加する(Section3「既存のResearchSection/CoreSection等を無理に
//     Conversation対応させない」)。
//   - components/auth/AuthProvider.tsx(STEP132)がapp/layout.tsxで
//     既に全ページへ提供済みの、唯一の既存認証機構
//     (Supabase Auth session・getAccessToken())。/api/tact/
//     tact-conversationsはPhase66でgetCurrentUserContext()必須(401)と
//     しているため、Legacy components/InputBar.tsx(STEP132)と同じ
//     `Authorization: Bearer <access_token>`パターンをそのまま再利用
//     する(新しい認証方式を作らない、Section10絶対条件)。
//   - app/login/page.tsx(STEP132)が既に実装済みの唯一のログインUI。
//     未ログイン時はここへの導線を表示するだけに留める(新しいログイン
//     UIを作らない)。
//
// Phase72 Section9(Conversation Navigation): Phase66で既に存在する
// GET /api/tact/tact-conversations(一覧)・GET /api/tact/
// tact-conversations/[id]/messages(既存Conversationのmessages取得)を
// 利用して、「新しい会話」「直近の会話一覧から選んで再開」を追加する。
// 新規APIは作らず、新しいConversation Layerの責務も追加しない
// (UI側でfetchして表示するだけ)。一覧は自動取得せず、ユーザーが履歴を
// 開いたときにだけ取得する(不要なAPI呼び出しを増やさない)。
//
// 責務: Conversation一覧取得・編集・削除等の管理機能は持たない。入力→
// POST /api/tact/tact-conversations→response反映、および既存GET経由の
// 一覧表示・再開だけを行う最小実装。

import { useState } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import type {
  ConversationMessageRole,
  ConversationSummary,
} from "@/core/tact-conversation/types";

type ConversationMessageView = {
  id: string;
  role: ConversationMessageRole;
  content: string;
  createdAt?: string;
};

// Phase72: HTTP statusごとにSection13の要求(401→Login導線・400→入力の
// 問題・404→Conversation利用不可・500→一般エラー、内部詳細は出さない)を
// 満たす表示文を組み立てる。API側は既に(Phase66)内部エラー詳細を返さない
// ("failed to submit conversation turn"等の一般文言のみ)ため、ここでは
// status別のユーザー向け文言に変換するだけで、body.errorをそのまま
//露出させない。
function describeErrorResponse(status: number): string {

  if (status === 401) {
    return "ログイン状態が確認できませんでした。再度ログインしてください。";
  }

  if (status === 400) {
    return "入力内容を確認してください。";
  }

  if (status === 404) {
    return "この会話は利用できなくなっています。新しい会話として続けてください。";
  }

  return "TACTとの通信でエラーが発生しました。しばらくしてから再度お試しください。";

}

export default function ConversationSection() {

  const { user, getAccessToken } = useAuth();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageView[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase72 Section9: 直近の会話一覧(履歴)。ページロード時には取得せず、
  // ユーザーが履歴パネルを開いたときにだけ取得する。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  function handleNewConversation() {

    // Phase72: 新しい会話を開始する。既存のconversationIdを破棄する
    // だけで、DB側で何かを削除・変更するわけではない(次回送信時に
    // POST側がconversationId未指定として新規作成する、既存の分岐
    // (route.tsのcreateConversation())をそのまま利用する)。
    setConversationId(null);
    setMessages([]);
    setInput("");
    setError(null);
    setHistoryOpen(false);

  }

  async function toggleHistory() {

    const next = !historyOpen;

    setHistoryOpen(next);

    if (!next) {
      return;
    }

    const accessToken = getAccessToken();

    if (!accessToken) {
      return;
    }

    setHistoryLoading(true);
    setHistoryError(null);

    try {

      // Phase66既存のGET(一覧)をそのまま利用する。新規APIは作らない。
      const response = await fetch(
        "/api/tact/tact-conversations?limit=10",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const body = await response.json();

      if (!response.ok || !body.success) {
        setHistoryError(describeErrorResponse(response.status));
        return;
      }

      setHistory(
        Array.isArray(body.conversations) ? body.conversations : []
      );

    } catch (err) {

      console.error("TACT Conversation list fetch failed:", err);

      setHistoryError("会話一覧の取得に失敗しました。");

    } finally {

      setHistoryLoading(false);

    }

  }

  async function handleSelectConversation(id: string) {

    const accessToken = getAccessToken();

    if (!accessToken || loading) {
      return;
    }

    setLoading(true);
    setError(null);

    try {

      // Phase66既存のGET(単一Conversationのmessages取得)をそのまま
      // 利用する。所有者判定はAPI側(getConversation())が行う。
      const response = await fetch(
        `/api/tact/tact-conversations/${id}/messages`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const body = await response.json();

      if (!response.ok || !body.success) {
        setError(describeErrorResponse(response.status));
        return;
      }

      const loadedMessages: ConversationMessageView[] = Array.isArray(
        body.messages
      )
        ? body.messages.map(
            (m: {
              id: string;
              role: ConversationMessageRole;
              content: string;
              createdAt?: string;
            }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              createdAt: m.createdAt,
            })
          )
        : [];

      setConversationId(id);
      setMessages(loadedMessages);
      setHistoryOpen(false);

    } catch (err) {

      console.error("TACT Conversation messages fetch failed:", err);

      setError("会話の読み込みに失敗しました。");

    } finally {

      setLoading(false);

    }

  }

  async function handleSubmit() {

    const content = input.trim();

    // Section9: 二重送信防止(loading中は再送信しない、既存
    // ResearchSection.tsxのhandleSubmit()と同じガード)。
    if (!content || loading) {
      return;
    }

    const accessToken = getAccessToken();

    // /api/tact/tact-conversationsはPhase66設計上、未認証を許容しない
    // (401)。Legacy 3経路(research/chat/core push)と異なり、ここでは
    // 呼び出し前にaccessToken有無を確認し、無い場合はAPIへ到達させず
    // ログインへの導線だけを示す(新しい認証方式は作らない、既存の
    // /loginへ委ねる)。
    if (!accessToken) {
      setError("この機能を使うにはログインが必要です。");
      return;
    }

    const userMessageId = crypto.randomUUID();

    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user", content },
    ]);

    setInput("");
    setLoading(true);
    setError(null);

    try {

      const response = await fetch("/api/tact/tact-conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          conversationId: conversationId ?? undefined,
          content,
        }),
      });

      const body = await response.json();

      if (!response.ok || !body.success) {

        setError(describeErrorResponse(response.status));

        // Phase72 Section13: 指定していたconversationIdが404
        // (存在しない/利用できない)になった場合、次回送信で同じ
        // 壊れたIDを使い続けないよう、新規Conversationとして続けられる
        // 状態に戻す(DBを直接触らず、UI側のstateだけをリセットする)。
        if (response.status === 404) {
          setConversationId(null);
        }

        return;

      }

      // Section5: APIがConversationを作成した場合、response.conversation.id
      // をUI stateへ保持し、以降のturnで送る。
      if (body.conversation?.id) {
        setConversationId(body.conversation.id);
      }

      // Section7: response.messageは通常turnではassistant answer、
      // clarificationではclarification questionを意味する
      // (Phase67/68の既存設計)。UI側でこの2つを区別する特別なUIは
      // 作らず、どちらもassistant側のメッセージとしてそのまま表示する
      // (Section8「clarification専用UIを新設しない」)。
      if (body.message) {

        setMessages((prev) => [
          ...prev,
          {
            id: body.message.id,
            role: "assistant",
            content: body.message.content,
            createdAt: body.message.createdAt,
          },
        ]);

      }

    } catch (err) {

      console.error("TACT Conversation API call failed:", err);

      setError("TACTとの通信に失敗しました。ネットワーク接続をご確認ください。");

    } finally {

      setLoading(false);

    }

  }

  return (

    <div className="flex h-full min-w-0 flex-1 flex-col">

      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-3">

        <div>
          <h2 className="text-sm font-semibold text-gray-900">Conversation</h2>
          <p className="text-xs text-gray-400">
            TACT Conversation Architecture(Canonical)経由でOrchestrator/Research Capabilityと対話します。
          </p>
        </div>

        {user && (

          <div className="flex shrink-0 items-center gap-2">

            <button
              type="button"
              onClick={handleNewConversation}
              className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 transition hover:bg-gray-100"
            >
              新しい会話
            </button>

            <button
              type="button"
              onClick={toggleHistory}
              className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                historyOpen
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100"
              }`}
            >
              履歴
            </button>

          </div>

        )}

      </div>

      {historyOpen && user && (

        <div className="max-h-40 overflow-y-auto border-b border-gray-200 bg-gray-50 px-5 py-2">

          {historyLoading && (
            <p className="text-xs text-gray-400">読み込み中...</p>
          )}

          {historyError && (
            <p className="text-xs text-red-600">{historyError}</p>
          )}

          {!historyLoading && !historyError && history.length === 0 && (
            <p className="text-xs text-gray-400">まだ会話がありません。</p>
          )}

          {!historyLoading && history.length > 0 && (

            <ul className="space-y-1">
              {history.map((item) => (

                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectConversation(item.id)}
                    className={`w-full truncate rounded px-2 py-1 text-left text-xs transition hover:bg-gray-200 ${
                      item.id === conversationId
                        ? "bg-gray-200 text-gray-900"
                        : "text-gray-600"
                    }`}
                  >
                    {item.title || `会話 ${item.id.slice(0, 8)}`}
                  </button>
                </li>

              ))}
            </ul>

          )}

        </div>

      )}

      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">

        {!user && (
          <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            この機能を使うには
            <a href="/login" className="mx-1 underline">
              ログイン
            </a>
            が必要です。
          </p>
        )}

        {/* Phase72 Section7: TACTのBetaではConversationを主要な入口として
            扱うため、「何をすればいいのか分からない」状態を作らない
            Empty Stateにする。 */}
        {messages.length === 0 && user && (
          <p className="text-sm text-gray-400">
            今日は、何を任せますか？下の入力欄から話しかけてみてください。
          </p>
        )}

        {messages.map((message) => (

          <div
            key={message.id}
            className={`block w-full rounded-xl px-4 py-2.5 text-left text-sm ${
              message.role === "user"
                ? "ml-auto max-w-[85%] bg-black text-white"
                : "max-w-[85%] border border-gray-200 bg-gray-50 text-gray-900"
            }`}
          >
            <p className="whitespace-pre-wrap">{message.content || "…"}</p>
          </div>

        ))}

        {loading && (
          <p className="text-sm text-gray-400">TACTが応答を準備しています...</p>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
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
            placeholder="メッセージを入力..."
            disabled={loading}
            className="flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-50"
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

  );

}
