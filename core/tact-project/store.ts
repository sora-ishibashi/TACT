import { createClient } from "@supabase/supabase-js";
import { Project } from "./types";

// =========================
// Project Store (Phase 31)
// =========================
//
// core/conversation/store.tsと同じ構成(DB row型 → ドメイン型変換 →
// CRUD関数)を踏襲する。ただし1点だけ既存store.tsと異なる、重要な
// 実装上の理由がある。
//
// 背景(Phase31実測で確認した事実): core/database/supabase.tsの共有
// クライアントはanonキーのみで生成されており、どのAPI Routeも
// ユーザーのSupabaseセッションをこのクライアントへ引き継いでいない
// (getAuthenticatedUser()はBearerトークンをsupabase.auth.getUser()で
// 検証するだけで、検証後もクライアント自体はanonロールのまま)。
// 既存テーブル(conversations等)はRLSがStage 0(using(true))のため
// これで問題にならないが、Phase30のprojectsテーブルはStage 1
// (auth.uid() = user_id)を採用しているため、anonキーのままでは
// auth.uid()が常にNULLになり、正当なownerからの操作もRLSに拒否される
// ことを実測で確認した(INSERT: 42501 row-level security violation、
// SELECT: 常に0件)。
//
// 対応: 検証済みのaccess_token(Phase31でcore/auth側に追加)を
// Authorizationヘッダーとして持つ、リクエストごとのSupabaseクライアント
// を構築する(Supabaseの標準的なper-request RLSクライアントパターン)。
// これによりPostgREST側でauth.uid()が実際のユーザーIDへ正しく解決され、
// Phase30のRLSがそのまま意図通りに機能する。Phase30のRLS定義自体は
// 一切変更していない。
//
// 絶対条件(RLSをAPIの代わりとして扱わない): このRLS前提のクライアント
// を使う場合でも、各関数は明示的に `.eq("user_id", userId)` を伴う
// クエリを組み立てる。RLSは最後の防御層として維持し、所有者判定の
// 主たるロジックはこのファイル(アプリケーション層)に置く。

function createRequestScopedClient(accessToken: string) {

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );

}

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

}

const PROJECT_COLUMNS = "id, user_id, name, created_at, updated_at";

// =========================
// createProject
// =========================

export async function createProject(
  userId: string,
  accessToken: string,
  name: string
): Promise<Project> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("projects")
    .insert({ user_id: userId, name })
    .select(PROJECT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toProject(data as ProjectRow);

}

// =========================
// listProjects
// =========================
//
// 並び順はupdated_at降順(既存のlistConversations()と同じ規約、
// 指示書の第一候補をそのまま採用)。

export async function listProjects(
  userId: string,
  accessToken: string
): Promise<Project[]> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => toProject(row as ProjectRow));

}

// =========================
// getProject
// =========================
//
// 存在しない場合・他UserのProjectの場合のいずれもundefinedを返す
// (呼び出し元のRoute側で一律404にするため、ここで区別しない)。

export async function getProject(
  userId: string,
  accessToken: string,
  projectId: string
): Promise<Project | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toProject(data as ProjectRow);

}

// =========================
// updateProjectName
// =========================
//
// 更新対象はname(+updated_at)のみ。user_id/idを書き換える経路は
// このシグネチャ自体に存在しない(絶対条件)。

export async function updateProjectName(
  userId: string,
  accessToken: string,
  projectId: string,
  name: string
): Promise<Project | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("projects")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select(PROJECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toProject(data as ProjectRow);

}

// =========================
// deleteProject
// =========================
//
// conversations.project_idがNULLへ戻る処理はPhase30のON DELETE
// SET NULLがDB側で行う。ここでConversationを手動更新・削除する
// 処理は追加しない(絶対条件)。

export async function deleteProject(
  userId: string,
  accessToken: string,
  projectId: string
): Promise<boolean> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("user_id", userId)
    .select(PROJECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return !!data;

}
