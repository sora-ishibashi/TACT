"use client";

// =========================
// CoreSection (STEP215)
// =========================
//
// TACT CoreへのDirect Push(POST /api/tact/core/push、STEP212で
// 実装済み・無変更)を、新UIの「左=対話/右=生み出したもの」構造の下で
// 提供する。バックエンド仕様(content/typeのみ、自動分類なし、
// User Scope限定)はSTEP212のまま変更しない。
//
// 将来構想(STEP215前提、今回は実装しない): TACT Coreは将来的に
// 開発者・熟練ユーザーが直接操作できる窓口になりうる。この
// CoreSectionはその最初の窓口(Push=書き込みのみ)であり、
// 閲覧・編集・検索といった機能はまだ無い。

import { useState } from "react";

type PushType = "knowledge" | "memory" | "example";

const PUSH_TYPES: readonly PushType[] = ["knowledge", "memory", "example"];

type PushLogEntry = {
  id: string;
  type: PushType;
  content: string;
  success: boolean;
  itemId?: string;
  message?: string;
};

export default function CoreSection() {

  const [content, setContent] = useState("");
  const [type, setType] = useState<PushType>("knowledge");
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<PushLogEntry[]>([]);

  async function handleSubmit() {

    const trimmed = content.trim();

    if (!trimmed || loading) {
      return;
    }

    setLoading(true);

    try {

      // STEP215: UI側でSupabaseへ直接INSERTしない。既存のDirect Push
      // API(STEP212、無変更)を1回だけ呼び出す。
      const response = await fetch("/api/tact/core/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed, type }),
      });

      const body = await response.json();

      if (!response.ok || !body.success) {

        setLog((prev) => [
          {
            id: crypto.randomUUID(),
            type,
            content: trimmed,
            success: false,
            message:
              typeof body.error === "string"
                ? body.error
                : `Pushに失敗しました(HTTP ${response.status})`,
          },
          ...prev,
        ]);

        return;

      }

      setLog((prev) => [
        {
          id: crypto.randomUUID(),
          type,
          content: trimmed,
          success: true,
          itemId: body.item?.id,
        },
        ...prev,
      ]);

      setContent("");

    } catch (error) {

      console.error("TACT Core Push API call failed:", error);

      setLog((prev) => [
        {
          id: crypto.randomUUID(),
          type,
          content: trimmed,
          success: false,
          message: "TACT Coreとの通信に失敗しました",
        },
        ...prev,
      ]);

    } finally {

      setLoading(false);

    }

  }

  return (

    <div className="flex h-full min-w-0 flex-1">

      {/* 左: TACTへ教える(対話) */}
      <div className="flex h-full min-w-0 flex-1 flex-col border-r border-gray-200 px-5 py-4">

        <h2 className="text-sm font-semibold text-gray-900">Core / Direct Push</h2>
        <p className="mt-1 text-xs text-gray-400">
          Researchを介さず、TACTへ直接知識・記憶・お手本を教えられます。
        </p>

        <div className="mt-4 flex flex-1 flex-col gap-3">

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="TACTへ直接教えたい内容を入力してください..."
            rows={6}
            className="flex-1 resize-none rounded-xl border border-gray-300 p-3 text-sm outline-none placeholder:text-gray-400"
          />

          <div className="flex items-center gap-2">

            <div className="flex gap-1">
              {PUSH_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    type === t
                      ? "bg-black text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="ml-auto rounded-lg bg-black px-4 py-1.5 text-xs text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? "保存中..." : "Coreへ保存"}
            </button>

          </div>

        </div>

      </div>

      {/* 右: TACTが記憶したもの */}
      <div className="hidden h-full min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5 md:flex">

        <p className="mb-2 text-xs font-medium text-gray-500">保存履歴(このセッション内)</p>

        {log.length === 0 ? (

          <p className="text-sm text-gray-400">
            まだこのセッションでPushした情報はありません。
          </p>

        ) : (

          <ul className="space-y-2">

            {log.map((entry) => (

              <li
                key={entry.id}
                className={`rounded-lg border p-3 text-sm ${
                  entry.success
                    ? "border-gray-200 bg-white"
                    : "border-red-200 bg-red-50"
                }`}
              >

                <div className="flex items-center justify-between gap-2">

                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                    {entry.type}
                  </span>

                  {entry.success ? (
                    <span className="text-[10px] text-green-600">保存済み</span>
                  ) : (
                    <span className="text-[10px] text-red-600">失敗</span>
                  )}

                </div>

                {entry.success ? (

                  <>
                    <p className="mt-1 text-gray-900">{entry.content}</p>
                    {entry.itemId && (
                      <p className="mt-1 break-all text-[10px] text-gray-400">
                        id: {entry.itemId}
                      </p>
                    )}
                  </>

                ) : (

                  <p className="mt-1 text-xs text-red-700">{entry.message}</p>

                )}

              </li>

            ))}

          </ul>

        )}

      </div>

    </div>

  );

}
