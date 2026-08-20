// =========================
// betaUsageReport.ts (STEP26)
// =========================
//
// 目的:
// βテスト中に「何が起きたか」を後から確認できるようにするための、
// 読み取り専用のレポートスクリプト。
//
// 重要な方針:
// - 新しいテーブル・カラムは一切追加しない。
// - 新しいデータの収集・複製保存も行わない。
// - 既存の conversations / conversation_messages /
//   conversation_workflow_runs (core/conversation/store.ts が
//   既に読み書きしているテーブル)を読み取って集計するだけ。
// - executions / users テーブルは、docs/architecture.md記載の通り
//   現在のConversationフローでは使われていない(createExecutionは
//   どこからも呼ばれていない)ため、このレポートの対象にしない。
//
// 実行方法(例):
//   npx tsx betaUsageReport.ts
//   (プロジェクトの標準的なTypeScript実行手段があればそれでよい。
//   test.ts と同じく "dotenv/config" で .env を読み込む)
//
// 出力: 標準出力にConversationごとの利用状況と、全体サマリーを表示する。
// DBへの書き込みは一切行わない。

import "dotenv/config";
import { supabase } from "./core/database/supabase";
import { EVIDENCE_SNAPSHOT_KEY } from "./core/conversation/collectPastEvidence";
import { ARTIFACT_TYPE_SNAPSHOT_KEY } from "./core/conversation/reconstructTask";

interface ConversationRow {
  id: string;
  user_id: string | null;
  title: string | null;
  current_task: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowRunRow {
  id: string;
  conversation_id: string;
  input: string;
  outputs: Record<string, unknown> | null;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface MessageRow {
  conversation_id: string;
  role: "user" | "assistant";
}

// =========================
// Turnの種類の推定
// =========================
//
// 新しいフィールドを追加するのではなく、既にconversation_workflow_runs.
// inputへ保存されている文字列(core/conversation/reconstructTask.tsの
// composeTask()が組み立てたcurrentTask)から、既知の定型文を手がかりに
// 判定するだけ。判定できない場合は「new/other」として扱う
// (誤って断定しないための安全側のfallback)。

const FULL_REWRITE_MARKER =
  "今回の指示は成果物全体の構成を作り直すことを明確に求めています";

const TARGETED_MARKER =
  "現在の成果物に既に存在する章立て";

function classifyTurnScope(
  input: string
): "full" | "targeted" | "new/other" {

  if (input.includes(FULL_REWRITE_MARKER)) return "full";
  if (input.includes(TARGETED_MARKER)) return "targeted";
  return "new/other";

}

function formatDuration(
  startedAt: string,
  completedAt: string | null
): string {

  if (!completedAt) return "-";

  const ms =
    new Date(completedAt).getTime() -
    new Date(startedAt).getTime();

  if (!Number.isFinite(ms) || ms < 0) return "-";

  return `${(ms / 1000).toFixed(1)}s`;

}

// =========================
// 開発テストデータとの区別 (STEP27)
// =========================
//
// STEP17〜26の開発中、実機テストのために多数のConversationが
// 既に本番と同じconversationsテーブルへ作成されている。
// 新しいDBカラム(例: environment区分)を追加せず、既存のcreated_at
// (Supabaseが自動付与するタイムスタンプ)を使い、
// 「このタイムスタンプ以降に作成されたConversationだけをβデータとして
// 集計する」という運用上の区別を行う。
//
// 実行方法(例): npx tsx betaUsageReport.ts 2026-08-12T00:00:00Z
// 引数を省略した場合は、従来どおり全期間を対象にする
// (開発データを含む全件が対象である旨を出力に明記する)。

function parseSinceArg(): string | null {

  const arg = process.argv[2];

  if (!arg) return null;

  const parsed = new Date(arg);

  if (Number.isNaN(parsed.getTime())) {

    console.error(
      `引数 "${arg}" を日時として解釈できませんでした。ISO 8601形式` +
      "(例: 2026-08-12T00:00:00Z)で指定してください。"
    );

    process.exit(1);

  }

  return parsed.toISOString();

}

async function main() {

  const since = parseSinceArg();

  let query = supabase
    .from("conversations")
    .select(
      "id, user_id, title, current_task, created_at, updated_at"
    )
    .order("created_at", { ascending: true });

  if (since) {
    query = query.gte("created_at", since);
  }

  const { data: conversations, error: convError } = await query;

  if (convError) throw convError;

  const { data: runs, error: runsError } =
    await supabase
      .from("conversation_workflow_runs")
      .select(
        "id, conversation_id, input, outputs, status, started_at, completed_at, error"
      )
      .order("started_at", { ascending: true });

  if (runsError) throw runsError;

  const { data: messages, error: messagesError } =
    await supabase
      .from("conversation_messages")
      .select("conversation_id, role");

  if (messagesError) throw messagesError;

  const runsByConversation = new Map<string, WorkflowRunRow[]>();

  for (const run of (runs ?? []) as WorkflowRunRow[]) {

    const list = runsByConversation.get(run.conversation_id) ?? [];
    list.push(run);
    runsByConversation.set(run.conversation_id, list);

  }

  // Turn数は「ユーザーが送った回数」= conversation_messagesの
  // role='user'件数とする(conversation_workflow_runsは1Turn=1Runの
  // はずだが、失敗して保存されなかったRunがあり得るため、
  // より確実なuser messageの件数を採用する)。
  const userTurnCountByConversation = new Map<string, number>();

  for (const message of (messages ?? []) as MessageRow[]) {

    if (message.role !== "user") continue;

    userTurnCountByConversation.set(
      message.conversation_id,
      (userTurnCountByConversation.get(message.conversation_id) ?? 0) + 1
    );

  }

  console.log("=========================================");
  console.log("TACT βテスト利用状況レポート");
  console.log("=========================================");

  console.log(
    since
      ? `集計対象: ${since} 以降に作成されたConversationのみ(開発テストデータを除外)`
      : "集計対象: 全期間(STEP17〜26の開発テストデータを含む)"
  );

  console.log("");

  let totalRuns = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalRunning = 0;

  for (const conversation of (conversations ?? []) as ConversationRow[]) {

    const convRuns =
      runsByConversation.get(conversation.id) ?? [];

    const turnCount =
      userTurnCountByConversation.get(conversation.id) ?? 0;

    const successCount =
      convRuns.filter((r) => r.status === "completed").length;

    const failedCount =
      convRuns.filter((r) => r.status === "failed").length;

    const runningCount =
      convRuns.filter((r) => r.status === "running").length;

    totalRuns += convRuns.length;
    totalSuccess += successCount;
    totalFailed += failedCount;
    totalRunning += runningCount;

    const agentsUsed = new Set<string>();
    const scopes = new Set<string>();

    for (const run of convRuns) {

      // STEP31/36: EVIDENCE_SNAPSHOT_KEY・ARTIFACT_TYPE_SNAPSHOT_KEYは
      // Agentの出力ではないため、「実行されたAgent」一覧からは除外する。
      Object.keys(run.outputs ?? {})
        .filter(
          (key) =>
            key !== EVIDENCE_SNAPSHOT_KEY &&
            key !== ARTIFACT_TYPE_SNAPSHOT_KEY
        )
        .forEach((agent) => agentsUsed.add(agent));

      scopes.add(classifyTurnScope(run.input));

    }

    console.log(`Conversation: ${conversation.id}`);
    console.log(`  タイトル: ${conversation.title ?? "(未設定)"}`);

    console.log(
      `  ユーザー: ${
        conversation.user_id ?? "(未設定・認証未導入のため不明)"
      }`
    );

    console.log(`  開始: ${conversation.created_at}`);
    console.log(`  最終更新: ${conversation.updated_at}`);
    console.log(`  Turn数(ユーザー発言数): ${turnCount}`);

    console.log(
      `  Workflow実行回数: ${convRuns.length}` +
      ` (成功 ${successCount} / 失敗 ${failedCount} / 実行中 ${runningCount})`
    );

    console.log(
      `  実行されたAgent: ${[...agentsUsed].join(", ") || "(なし)"}`
    );

    console.log(
      `  Turnの種類: ${[...scopes].join(", ") || "(なし)"}`
    );

    convRuns.forEach((run, index) => {

      console.log(
        `    Run${index + 1}: ${run.status}` +
        ` / 実行時間 ${formatDuration(run.started_at, run.completed_at)}` +
        (run.error
          ? ` / エラー: ${run.error.slice(0, 120)}`
          : "")
      );

    });

    console.log("");

  }

  console.log("=========================================");
  console.log("全体サマリー");
  console.log("=========================================");
  console.log(`Conversation数: ${(conversations ?? []).length}`);
  console.log(`Workflow実行回数(合計): ${totalRuns}`);

  console.log(
    `成功: ${totalSuccess} / 失敗: ${totalFailed} / 実行中: ${totalRunning}`
  );

  console.log(
    `成功率: ${
      totalRuns > 0
        ? ((totalSuccess / totalRuns) * 100).toFixed(1)
        : "-"
    }%`
  );

}

main().catch((error) => {

  console.error(
    "レポート生成中にエラーが発生しました:",
    error
  );

  process.exit(1);

});
