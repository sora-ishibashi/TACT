// =========================
// CodeTask Store(STEP142-D)
// =========================
//
// DB設計方針: 新規テーブルは作らない。
//
// 既存のtact_memoryテーブル(supabase/migrations/
// 20260821000000_create_brain_memory_tables.sql)は、
// - content jsonb に任意の構造を保持できる
// - type列のCHECK制約は既に 'task' という値を許可している
//   (既存コードはどこも実際には'task'を書き込んでおらず、未使用のまま
//   残っていた。grep で確認済み)
// - updated_at列・UPDATE用のRLSポリシー(tact_memory_update_anon_stage0)
//   も既に用意されている(Executionのステータスを後から更新する
//   用途を、このテーブルは元々想定していたことが読み取れる)
//
// という理由から、CodeTaskはtact_memoryへ type: "task" として
// 保存する。新しいMigrationは不要。

import { supabase } from "../database/supabase";
import { CodeTask } from "./types";

const CODE_TASK_TYPE = "task";

// DB未接続時のフォールバック(core/brain/history.ts・
// core/brain/memory.tsと同じ、プロセス内キャッシュ + DB永続化の
// 二層構成)。
const codeTaskCache: Map<string, CodeTask> = new Map();

export async function saveCodeTask(
  task: CodeTask
): Promise<void> {

  codeTaskCache.set(task.id, task);

  try {

    const { error } =
      await supabase
        .from("tact_memory")
        .upsert(
          {
            id: task.id,
            type: CODE_TASK_TYPE,
            target_agent: null,
            content: task,
            importance: 5,
            confidence: "medium",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "id" }
        );

    if (error) throw error;

  } catch (error) {

    console.warn(
      "[TACT Code] Failed to persist CodeTask to DB. " +
      "Falling back to in-process cache only.",
      error instanceof Error ? error.message : error
    );

  }

}

export async function getCodeTask(
  id: string
): Promise<CodeTask | undefined> {

  try {

    const { data, error } =
      await supabase
        .from("tact_memory")
        .select("content")
        .eq("id", id)
        .eq("type", CODE_TASK_TYPE)
        .maybeSingle();

    if (error) throw error;

    if (data?.content) {
      return data.content as CodeTask;
    }

  } catch (error) {

    console.warn(
      "[TACT Code] Failed to load CodeTask from DB. " +
      "Falling back to in-process cache.",
      error instanceof Error ? error.message : error
    );

  }

  return codeTaskCache.get(id);

}

export async function listCodeTasks(
  limit: number = 20
): Promise<CodeTask[]> {

  try {

    const { data, error } =
      await supabase
        .from("tact_memory")
        .select("content, created_at")
        .eq("type", CODE_TASK_TYPE)
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) throw error;

    if (data) {
      return data.map((row) => row.content as CodeTask);
    }

  } catch (error) {

    console.warn(
      "[TACT Code] Failed to list CodeTasks from DB. " +
      "Falling back to in-process cache.",
      error instanceof Error ? error.message : error
    );

  }

  return Array.from(codeTaskCache.values()).slice(-limit).reverse();

}
