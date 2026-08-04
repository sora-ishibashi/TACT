"use client";

type Message = {
  role: "user" | "tact";
  content: string;
};

type Props = {
  messages: Message[];
  workflow: any;
};

export default function Conversation({
  messages,
  workflow,
}: Props) {

  const latestEvent =
    workflow?.events?.[
      workflow.events.length - 1
    ];

  const completed =
    workflow?.events?.filter(
      (e: any) => e.type === "complete"
    ).length ?? 0;

  const total =
    workflow?.events
      ?.filter((e: any) => e.type === "start")
      .length ?? 0;

  const progress =
    total === 0
      ? 0
      : Math.round(
          (completed / total) * 100
        );

  let statusText =
    "AIチームを編成しています...";

  if (latestEvent) {

    switch (latestEvent.agent) {

      case "planner":
        statusText =
          latestEvent.type === "complete"
            ? "✅ タスクを整理しました"
            : "🧠 タスクを整理しています...";
        break;

      case "researcher":
        statusText =
          latestEvent.type === "complete"
            ? "✅ 調査が完了しました"
            : "🔍 情報を調査しています...";
        break;

      case "designer":
        statusText =
          latestEvent.type === "complete"
            ? "✅ 設計が完了しました"
            : "🎨 構成を設計しています...";
        break;

      case "engineer":
        statusText =
          latestEvent.type === "complete"
            ? "✅ 技術設計が完了しました"
            : "💻 実装を考えています...";
        break;

      case "stakeholder":
        statusText =
          latestEvent.type === "complete"
            ? "✅ 評価が完了しました"
            : "👥 ユーザー視点で検討しています...";
        break;

      case "reviewer":
        statusText =
          latestEvent.type === "complete"
            ? "✅ レビューが完了しました"
            : "🧐 品質を確認しています...";
        break;

      case "writer":
        statusText =
          latestEvent.type === "complete"
            ? "✅ 成果物が完成しました"
            : "✍ 成果物を作成しています...";
        break;

    }

  }

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

              <button className="rounded-xl border border-gray-200 p-4 text-left text-sm transition hover:bg-gray-50">
                📄 レポートを書く
              </button>

              <button className="rounded-xl border border-gray-200 p-4 text-left text-sm transition hover:bg-gray-50">
                💼 面接対策をする
              </button>

              <button className="rounded-xl border border-gray-200 p-4 text-left text-sm transition hover:bg-gray-50">
                💡 アイデアを考える
              </button>

              <button className="rounded-xl border border-gray-200 p-4 text-left text-sm transition hover:bg-gray-50">
                💻 コードを書く
              </button>

            </div>

          </div>

        ) : (

          <div className="space-y-4 overflow-y-auto pb-6">

            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">

              <div className="mb-2 text-sm font-semibold text-blue-700">
                🤖 TACT
              </div>

              <p className="text-sm leading-6 text-gray-700">
                {statusText}
              </p>

              <div className="mt-4">

                <div className="mb-1 flex justify-between text-xs text-gray-500">

                  <span>進行状況</span>

                  <span>{progress}%</span>

                </div>

                <div className="h-2 overflow-hidden rounded-full bg-blue-100">

                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-500"
                    style={{
                      width: `${progress}%`,
                    }}
                  />

                </div>

              </div>

            </div>

            {messages.map((message, index) => (

  <div
    key={index}
    className="border-b border-gray-100 py-3"
  >
<div className="mb-1 text-[12px] font-medium text-gray-500">
                  {message.role === "user"
                    ? "👤 あなた"
                    : "🤖 TACT"}

                </div>

<div
  className={`
    whitespace-pre-wrap
    text-[13px]
    leading-6
    ${
      message.role === "user"
        ? "text-gray-900"
        : "text-gray-700"
    }
  `}
>
                  {message.content}

                </div>

              </div>

            ))}

          </div>

        )}

      </div>

    </main>

  );

}