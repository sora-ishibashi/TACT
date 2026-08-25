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

// Phase103(Repository Evidence: Phase102 Reality Testで実際に確認した
// 混入): core/tact-agent/(Phase101)も同じtact_memory・同じtype="task"
// バケツを再利用しており、DevelopmentTask/HandoffStateは
// content.recordKindで区別される(core/tact-agent/supabaseStore.ts参照)。
// CodeTask自身はrecordKindを一度も設定しない(このファイルの
// saveCodeTask()参照)ため、既存のCodeTaskは常にrecordKindが
// undefined。listCodeTasks()では、この2種類のrecordKindを持つ行だけを
// 明示的に除外する(許可リストではなく除外リストにするのは、
// 既存CodeTask行にrecordKindが存在しない場合でも後方互換を壊さない
// ため、Step2絶対条件)。
const NON_CODE_TASK_RECORD_KINDS: ReadonlySet<string> = new Set([
  "development_task",
  "agent_handoff",
]);

function isNonCodeTaskRecord(content: unknown): boolean {

  if (!content || typeof content !== "object") {
    return false;
  }

  const recordKind = (content as { recordKind?: unknown }).recordKind;

  return typeof recordKind === "string" && NON_CODE_TASK_RECORD_KINDS.has(recordKind);

}

// Phase103: listCodeTasks()の中核ロジック(非CodeTask行の除外→CodeTask
// への変換→limit件への絞り込み)を、DB往復から独立した純粋関数として
// 切り出す。DB接続なしにUnit Testできるようにするため(このファイルは
// 元々テストが無く、実Supabase接続なしに検証する手段が無かった)。
// listCodeTasks()自体の公開シグネチャ・挙動は変更しない。
export function selectCodeTasksFromRows(
  rows: { content: unknown }[],
  limit: number
): CodeTask[] {

  return rows
    .filter((row) => !isNonCodeTaskRecord(row.content))
    .map((row) => row.content as CodeTask)
    .slice(0, limit);

}

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

    // Phase103: type="task"のバケツにはDevelopmentTask/HandoffState
    // (core/tact-agent/)も混在するため、DB側のlimitをそのままCodeTask
    // 件数の上限として使うと、非CodeTask行がlimit枠を消費して実際の
    // CodeTaskがlimit件に満たない結果を返しかねない。フィルタ前に
    // 余裕を持った件数を取得し、除外後にlimit件へ絞り込む
    // (新しいクエリ機構は追加せず、既存の1回のSELECTのままにする)。
    const fetchLimit = Math.max(limit * 4, 100);

    const { data, error } =
      await supabase
        .from("tact_memory")
        .select("content, created_at")
        .eq("type", CODE_TASK_TYPE)
        .order("created_at", { ascending: false })
        .limit(fetchLimit);

    if (error) throw error;

    if (data) {
      return selectCodeTasksFromRows(data, limit);
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
