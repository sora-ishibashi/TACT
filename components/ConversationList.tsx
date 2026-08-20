"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth/AuthProvider";

// =========================
// ConversationList (STEP9)
// =========================
//
// Sidebarの💬ボタンから開くConversation一覧オーバーレイ。
// GET /api/tact/conversations(新設)を叩いて一覧を取得し、
// 選択されたConversationのidをonSelectで親(TactInterface)へ
// 伝える。削除UIは実装しない。
//
// STEP145-G: GET /api/tact/conversationsはサーバー側でuserIdによる
// 絞り込みを行うようになったため、ログイン済みの場合は
// Authorization: Bearerヘッダーを付与し、自分のConversationのみが
// 返るようにする(未ログイン時は従来どおりヘッダー無しで呼び出す)。

type ConversationSummary = {
  id: string;
  title?: string;
  currentTask: string;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  onClose: () => void;
  onSelect: (conversationId: string) => void;
  onCreateNew: () => void;
};

function formatRelativeTime(iso: string): string {

  const diffMs =
    Date.now() - new Date(iso).getTime();

  const diffMinutes =
    Math.floor(diffMs / 60000);

  if (diffMinutes < 1) {
    return "たった今";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}分前`;
  }

  const diffHours =
    Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours}時間前`;
  }

  const diffDays =
    Math.floor(diffHours / 24);

  return `${diffDays}日前`;

}

export default function ConversationList({
  onClose,
  onSelect,
  onCreateNew,
}: Props) {

  const [conversations, setConversations] =
    useState<ConversationSummary[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const { getAccessToken } = useAuth();

  useEffect(() => {

    let cancelled = false;

    async function fetchList() {

      setLoading(true);
      setError(null);

      try {

        const accessToken = getAccessToken();

        const response =
          await fetch("/api/tact/conversations", {
            headers: accessToken
              ? { Authorization: `Bearer ${accessToken}` }
              : undefined,
          });

        const data = await response.json();

        if (!data.success) {

          throw new Error(
            data.error ?? "Unknown error"
          );

        }

        if (!cancelled) {
          setConversations(data.conversations);
        }

      } catch (err) {

        console.error(err);

        if (!cancelled) {
          setError("Conversation一覧の取得に失敗しました");
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }

    fetchList();

    return () => {
      cancelled = true;
    };

    // 開いた瞬間の1回だけ取得すれば十分なため、意図的に空配列のまま
    // にする(getAccessTokenはuseAuth()が毎レンダー新しい参照を返すため
    // 依存配列に含めると無限に再実行されてしまう)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (

    <div className="fixed inset-0 z-50 flex">

      {/* panel */}
      {/*
        Sidebarの💬ボタン(画面左端)から開くため、パネルも左端に
        表示する。backdropを先に置くとflexの並び順でパネルが
        画面右端に押し出されてしまうため、パネルを先に配置する。
      */}
      <div className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white shadow-xl">

        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">

          <h2 className="text-sm font-semibold text-gray-900">
            Conversation一覧
          </h2>

          <button
            onClick={onClose}
            className="text-gray-400 transition hover:text-gray-600"
          >
            ✕
          </button>

        </div>

        <div className="p-3">

          <button
            onClick={() => {
              onCreateNew();
              onClose();
            }}
            className="w-full rounded-lg bg-black px-3 py-2 text-sm text-white transition hover:bg-gray-800"
          >
            ＋ 新規Conversation
          </button>

        </div>

        <div className="flex-1 px-2 pb-4">

          {loading && (

            <p className="px-2 py-4 text-xs text-gray-400">
              読み込み中...
            </p>

          )}

          {!loading && error && (

            <p className="px-2 py-4 text-xs text-red-500">
              {error}
            </p>

          )}

          {!loading &&
            !error &&
            conversations.length === 0 && (

            <p className="px-2 py-4 text-xs text-gray-400">
              まだConversationがありません
            </p>

          )}

          {!loading &&
            !error &&
            conversations.map((conversation) => (

            <button
              key={conversation.id}
              onClick={() => {
                onSelect(conversation.id);
                onClose();
              }}
              className="mb-1 block w-full rounded-lg px-3 py-2 text-left transition hover:bg-gray-100"
            >

              <div className="truncate text-sm font-medium text-gray-900">
                {conversation.title ||
                  conversation.currentTask ||
                  "(無題)"}
              </div>

              <div className="mt-0.5 text-xs text-gray-400">
                {formatRelativeTime(conversation.updatedAt)}
              </div>

            </button>

          ))}

        </div>

      </div>

      {/* backdrop */}
      <div
        className="flex-1 bg-black/20"
        onClick={onClose}
      />

    </div>

  );

}
