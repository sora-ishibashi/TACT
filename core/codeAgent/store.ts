// =========================
// CodeTask Store(STEP142-D、TACT SEC-P0-1/P0-3で更新)
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
//
// TACT SEC-P0-3(Pre-Live Remediation): tact_memoryは
// supabase/migrations/20260913000000_..._restrict_legacy_stage0_
// tables_to_service_role.sqlでclient側policyを全てdropし、service
// role以外はデフォルトで拒否されるようになった。clientの取得先だけを
// service roleへ差し替える(core/database/supabaseServiceRole.tsの
// 既存allowlistへ追加済み)。
//
// TACT SEC-P0-1(Pre-Live Remediation): CodeTaskへ`userId`列を追加し
// (core/codeAgent/types.ts参照)、以降の全操作をこのuserIdで
// owner-scopeする。userIdが指定された呼び出し(認証済みroute経由)は
// 必ず`.eq("user_id", userId)`を伴い、他userのCodeTaskへは
// (service roleでRLSがbypassされていても)アプリケーション層で
// 到達できない。DB未接続時のfallback(codeTaskCache)も同じ
// owner-scopeを適用する——fallback経路だけownership checkを迂回
// できてしまう、という抜け穴を作らない。

import { getServiceRoleClient } from "../database/supabaseServiceRole";
import { CodeTask } from "./types";

function requireServiceRoleClient() {
  const client = getServiceRoleClient();
  if (!client) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return client;
}

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

// TACT SEC-P0-1: fallback(DB接続失敗時)がowner-scopeを迂回しない
// ようにするための共通filter。userId省略時(内部専用の想定、通常の
// route経由では必ず指定される)は従来どおり絞り込まない。exportする
// のはtest容易性のため(実DB接続なしにownership判定ロジック自体を
// 直接検証できるようにする)。
export function isOwnedBy(task: CodeTask, userId: string | undefined): boolean {
  return userId === undefined || task.userId === userId;
}

export async function saveCodeTask(
  task: CodeTask
): Promise<void> {

  codeTaskCache.set(task.id, task);

  try {

    const { error } =
      await requireServiceRoleClient()
        .from("tact_memory")
        .upsert(
          {
            id: task.id,
            user_id: task.userId ?? null,
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

// TACT SEC-P0-1: userIdを指定した場合、そのuserが所有するCodeTaskの
// みを返す(存在するが他user所有の場合もundefined——存在の有無を
// 漏らさない既存規約、STEP145と同じ)。
export async function getCodeTask(
  id: string,
  userId?: string
): Promise<CodeTask | undefined> {

  try {

    let query = requireServiceRoleClient()
      .from("tact_memory")
      .select("content")
      .eq("id", id)
      .eq("type", CODE_TASK_TYPE);

    if (userId !== undefined) {
      query = query.eq("user_id", userId);
    }

    const { data, error } = await query.maybeSingle();

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

  const cached = codeTaskCache.get(id);

  return cached && isOwnedBy(cached, userId) ? cached : undefined;

}

export async function listCodeTasks(
  limit: number = 20,
  userId?: string
): Promise<CodeTask[]> {

  try {

    // Phase103: type="task"のバケツにはDevelopmentTask/HandoffState
    // (core/tact-agent/)も混在するため、DB側のlimitをそのままCodeTask
    // 件数の上限として使うと、非CodeTask行がlimit枠を消費して実際の
    // CodeTaskがlimit件に満たない結果を返しかねない。フィルタ前に
    // 余裕を持った件数を取得し、除外後にlimit件へ絞り込む
    // (新しいクエリ機構は追加せず、既存の1回のSELECTのままにする)。
    const fetchLimit = Math.max(limit * 4, 100);

    let query = requireServiceRoleClient()
      .from("tact_memory")
      .select("content, created_at")
      .eq("type", CODE_TASK_TYPE);

    if (userId !== undefined) {
      query = query.eq("user_id", userId);
    }

    const { data, error } = await query
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

  return Array.from(codeTaskCache.values())
    .filter((task) => isOwnedBy(task, userId))
    .slice(-limit)
    .reverse();

}
