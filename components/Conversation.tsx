"use client";

import { useEffect, useRef } from "react";

type Message = {
  role: "user" | "tact";
  content: string;
};

type Props = {
  messages: Message[];
  runStatus: "idle" | "running" | "completed" | "error";

  // STEP24: 空状態の提案ボタン用。押しても何も起きなかった問題を
  // 解消するため、押すと入力欄へ叩き台の文章を入れるだけの
  // 最小実装(自動送信はしない)。
  onSuggestionSelect?: (text: string) => void;
};

const SUGGESTIONS = [
  {
    icon: "📄",
    label: "レポートを書く",
    prefill: "について、レポートを作成してください。",
  },
  {
    icon: "💼",
    label: "面接対策をする",
    prefill: "の面接に向けて、想定質問と回答例を教えてください。",
  },
  {
    icon: "💡",
    label: "アイデアを考える",
    prefill: "についてのアイデアを出してください。",
  },
  {
    icon: "💻",
    label: "コードを書く",
    prefill: "を実装するコードを書いてください。",
  },
] as const;

export default function Conversation({
  messages,
  runStatus,
  onSuggestionSelect,
}: Props) {

  // STEP16-C: 新しいメッセージ追加時・実行中バナーの表示切り替え時に
  // 最新位置まで自動スクロールする。scrollIntoView()は必要な
  // 祖先のスクロールコンテナを自動的に辿ってくれるため、
  // LeftPanel.tsx側のスクロール構造には手を加えない。
  const bottomRef =
    useRef<HTMLDivElement | null>(null);

  useEffect(() => {

    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });

  }, [messages, runStatus]);

  return (

    <main className="flex h-full flex-col">

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 pt-10">

        {messages.length === 0 ? (

          <div className="text-center">

            <h1 className="text-3xl font-bold text-gray-900">
              今日は、
              <br />
              何を任せますか？
            </h1>

            <p className="mt-3 text-sm text-gray-500">
              TACTが最適なAIチームを編成し、
              <br />
              成果物を作成します。
            </p>

            <div className="mt-8 grid grid-cols-2 gap-3">

              {SUGGESTIONS.map((suggestion) => (

                <button
                  key={suggestion.label}
                  onClick={() =>
                    onSuggestionSelect?.(suggestion.prefill)
                  }
                  className="rounded-xl border border-gray-200 p-4 text-left text-sm transition hover:bg-gray-50"
                >
                  {suggestion.icon} {suggestion.label}
                </button>

              ))}

            </div>

          </div>

        ) : (

          <div className="flex-1 space-y-3 overflow-y-auto pb-6">

            {/*
              STEP16-C: LINE/ChatGPT風の左右バブルUI。
              user -> 右寄せ・黒背景。tact -> 左寄せ・薄いグレー背景。
              Message型・role判定ロジックは既存のまま利用する。
            */}

            {messages.map((message, index) => {

              const isUser =
                message.role === "user";

              return (

                <div
                  key={index}
                  className={`flex ${
                    isUser
                      ? "justify-end"
                      : "justify-start"
                  }`}
                >

                  <div
                    className={`
                      max-w-[75%]
                      whitespace-pre-wrap
                      break-words
                      rounded-2xl
                      px-4
                      py-2.5
                      text-[13px]
                      leading-6
                      ${
                        isUser
                          ? "bg-black text-white"
                          : "border border-gray-200 bg-gray-50 text-gray-900"
                      }
                    `}
                  >
                    {message.content}
                  </div>

                </div>

              );

            })}

            {/*
              STEP14由来の実行中インジケーター。
              LINE/ChatGPTの「入力中」表示に合わせ、TACT側(左寄せ)の
              バブルとして最新メッセージの下(末尾)に表示する。
              実行中(running)の間だけ表示し、完了後・待機中は表示しない。
            */}

            {runStatus === "running" && (

              <div className="flex justify-start">

                <div className="max-w-[75%] rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-[13px] leading-6 text-blue-700">
                  🧠 TACTが作業しています...
                </div>

              </div>

            )}

            <div ref={bottomRef} />

          </div>

        )}

      </div>

    </main>

  );

}
