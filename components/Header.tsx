"use client";

// STEP24: 従来は常に「🟢 Ready」固定表示で、Agent実行中でも
// 変化しなかったため、「実行中なのかどうか分からない」UX上の
// 問題があった(右側のTeamStatusパネルとの表示不整合)。
// runStatusを受け取り、実際の状態と一致させる。

import { useAuth } from "./auth/AuthProvider";

type Props = {
  runStatus?: "idle" | "running" | "completed" | "error";
};

function statusDotClass(
  runStatus: Props["runStatus"]
) {

  switch (runStatus) {

    case "running":
      return "animate-pulse bg-blue-500";

    case "error":
      return "bg-red-500";

    default:
      return "bg-green-500";

  }

}

function statusLabel(
  runStatus: Props["runStatus"]
) {

  switch (runStatus) {

    case "running":
      return "実行中...";

    case "error":
      return "エラー";

    case "completed":
      return "完了";

    default:
      return "Ready";

  }

}

export default function Header({
  runStatus = "idle",
}: Props) {

  // STEP132: 既存レイアウト・テーマを変更せず、右端に最小限の
  // ログイン状態表示だけを追加する。
  const { user, signOut } = useAuth();

  return (
    <header className="h-16 border-b border-gray-200 flex items-center justify-between px-8">
      <h2 className="text-xl font-semibold">
        AI Workspace
      </h2>

      <div className="flex items-center gap-3">
        <div
          className={`h-3 w-3 rounded-full ${statusDotClass(runStatus)}`}
        ></div>

        <span className="text-gray-500">
          {statusLabel(runStatus)}
        </span>

        <span className="text-gray-300">|</span>

        {user ? (
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-sm">
              {user.email}
            </span>
            <button
              type="button"
              onClick={() => signOut()}
              className="text-sm text-gray-500 hover:text-gray-800"
            >
              Logout
            </button>
          </div>
        ) : (
          <a
            href="/login"
            className="text-sm text-gray-500 hover:text-gray-800"
          >
            ログイン
          </a>
        )}
      </div>
    </header>
  );
}