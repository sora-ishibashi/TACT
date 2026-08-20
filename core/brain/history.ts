import {
  ExecutionRecord
} from "../context/types";

import { supabase } from "../database/supabase";


// ==========================
// Execution History
// ==========================
//
// 「TACT最速実装モード」STEP2: これまでプロセス内配列だけで
// 保持していたExecutionHistoryを、既存のSupabase接続
// (core/database/supabase.ts)を使ってtact_execution_history
// テーブルへ永続化する。
//
// 重要: migration(supabase/migrations/
// 20260821000000_create_brain_memory_tables.sql)がまだ適用されて
// いない環境でも既存Workflowを壊さないよう、DB操作は必ず
// try/catchで守り、失敗時はプロセス内配列へのフォールバックのみで
// 継続する(例外を投げない)。

let executionHistory:
  ExecutionRecord[] = [];



// 保存(プロセス内キャッシュ + DB永続化)

export async function saveExecutionRecord(
  record: ExecutionRecord,
  // STEP131以降のuserId伝達経路(context.userId)をそのまま利用する。
  // 未認証の場合はnullのまま(既存方針を維持、拒否しない)。
  userId?: string | null,
  conversationId?: string | null
) {

  executionHistory.push(
    record
  );


  // 最大100件保持(プロセス内キャッシュ、既存の挙動と同じ)

  executionHistory =
    executionHistory.slice(-100);


  try {

    const { error } =
      await supabase
        .from("tact_execution_history")
        .insert({
          user_id: userId ?? null,
          conversation_id: conversationId ?? null,
          user_input: record.userInput,
          mode: record.mode,
          agents: record.agents,
          quality_score: record.quality?.score ?? null,
          success: record.success ?? true,
          failed_agents: record.failedAgents ?? [],
          duration_ms: record.duration ?? null,
          evidence_mode: record.evidenceMode ?? null,
          quality_profile: record.qualityProfile ?? null,
          record,
        });

    if (error) throw error;

  } catch (error) {

    // テーブル未作成(migration未適用)・ネットワークエラー等でも
    // Workflow全体は止めない。プロセス内キャッシュへの保存は
    // 既に完了しているため、Brain分析自体は継続できる。
    console.warn(
      "[Brain] Failed to persist execution record to DB. " +
      "Falling back to in-process cache only.",
      error instanceof Error ? error.message : error
    );

  }

}



// 取得(DBを優先し、失敗時はプロセス内キャッシュへフォールバック)
//
// STEP146-E: userIdによる絞り込みを追加する。この関数の結果は
// Brainのパターン分析(analyzePatterns → optimizeWorkflow)にのみ
// 使われ、core/brain/memory.tsのrefreshRelevantBrainMemory()と
// 同じ「自分のuser_id + user_id IS NULL(認証導入前の共有データ)」
// という設計を踏襲する(Prompt注入ではなくBrain内部の統計処理という
// 点でも、formatBrainMemory()より性質が近いため)。
// - userId省略時: 従来どおり絞り込みを行わない(後方互換)。
// - userIdが確定している場合: 自分の履歴 + user_id IS NULLの履歴。
// - userId === null(未認証と確定): user_id IS NULLの履歴のみ。

export async function getExecutionHistory(
  userId?: string | null
): Promise<ExecutionRecord[]> {

  try {

    let query = supabase
      .from("tact_execution_history")
      .select("record")
      .order("created_at", { ascending: false })
      .limit(100);

    if (userId !== undefined) {
      query = userId
        ? query.or(`user_id.eq.${userId},user_id.is.null`)
        : query.is("user_id", null);
    }

    const { data, error } = await query;

    if (error) throw error;

    if (data && data.length > 0) {

      return data
        .map((row) => row.record as ExecutionRecord)
        .filter((record): record is ExecutionRecord => !!record);

    }

  } catch (error) {

    console.warn(
      "[Brain] Failed to load execution history from DB. " +
      "Falling back to in-process cache.",
      error instanceof Error ? error.message : error
    );

  }

  // DBが空(まだ1件も保存されていない)、または読み取り失敗時は
  // プロセス内キャッシュを返す(既存の挙動)。
  return executionHistory;

}
