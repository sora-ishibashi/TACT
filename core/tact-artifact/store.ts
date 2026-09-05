import { createClient } from "@supabase/supabase-js";
import { Artifact, ArtifactBlock, ArtifactSummary } from "./types";
import { legacyContentToBlocks, renderBlocksToPlainText } from "./blocks";

// =========================
// TACT Artifact Store (Phase 75, Phase76でBlocks列に対応)
// =========================
//
// core/tact-conversation/store.ts・core/tact-project/store.tsと
// 完全に同型のper-request Bearer tokenクライアントパターン
// (Stage1 RLS、auth.uid()=user_id)。tact_artifactsテーブルは
// supabase/migrations/20260827000000_create_tact_artifacts.sqlで
// 実DBへ適用済み(`supabase migration list`で確認済み)。Phase76の
// blocks jsonb列追加(supabase/migrations/
// 20260828000000_add_blocks_to_tact_artifacts.sql)は実DB未適用のため、
// 適用前にユーザーへ報告する。
//
// 絶対条件(Phase75 Section9、Phase76でも継続): 既存内容を壊さない。
// update系は「置き換え」ではなく「呼び出し元が組み立てた新しいblocks
// 全体」を受け取って上書きする——Block構築・追記ロジック(既存blocks +
// 新規/更新Block)はcore/tact-conversation/orchestration.ts側の責務と
// し、store.ts自身は「渡された値をそのまま保存するだけ」の薄い層に
// 留める(core/tact-conversation/store.tsと同じ責務分離)。

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

export interface ArtifactRow {
  id: string;
  user_id: string;
  project_id: string | null;
  work_id: string | null;
  title: string;
  content: string;
  // Phase76: jsonb列。supabase-jsが自動でJS配列へparse済みの値が渡って
  // くる(手動JSON.parseは不要)。Phase75以前の行、または一度も
  // Block Mutationが起きていない行はnull/[]のまま。
  blocks: ArtifactBlock[] | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function toArtifact(row: ArtifactRow): Artifact {

  // Phase76 Section13(Backward Compatibility): blocks列が空/未設定の
  // 場合のみ、content(markdown全文)をlegacyContentToBlocks()で
  // TextBlock 1件へ変換する。呼び出し元はArtifact.blocksを常に
  // 「そのArtifactの構造化された全内容」として扱える。
  const blocks =
    row.blocks && row.blocks.length > 0
      ? row.blocks
      : legacyContentToBlocks(row.content);

  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    workId: row.work_id,
    title: row.title,
    blocks,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

}

export function toArtifactSummary(row: ArtifactRow): ArtifactSummary {

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    version: row.version,
    updatedAt: row.updated_at,
  };

}

const ARTIFACT_COLUMNS =
  "id, user_id, project_id, work_id, title, content, blocks, version, created_at, updated_at";

// =========================
// createArtifact
// =========================
//
// Phase76: 呼び出し元(core/tact-conversation/orchestration.ts)が
// 組み立てた初期Block配列を受け取る。contentはblocksから
// renderBlocksToPlainText()で決定論的に導出し、ここで別途組み立てる
// 必要はない(store.ts自身は「渡された値をそのまま保存するだけ」の
// 薄い層という既存方針を維持)。

// Architecture Migration Phase B2: workIdは末尾のoptional引数として
// 追加した(既存呼び出し元は一切変更不要、既定値nullで既存挙動と
// 完全に同じ)。Work経由で生成されたArtifactにのみ、呼び出し元
// (core/tact-conversation/orchestration.ts)が解決済みのWork.idを渡す。
export async function createArtifact(
  userId: string,
  accessToken: string,
  title: string,
  blocks: ArtifactBlock[],
  projectId?: string | null,
  workId?: string | null
): Promise<Artifact> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_artifacts")
    .insert({
      user_id: userId,
      title,
      content: renderBlocksToPlainText(blocks),
      blocks,
      project_id: projectId ?? null,
      work_id: workId ?? null,
    })
    .select(ARTIFACT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toArtifact(data as ArtifactRow);

}

// =========================
// getArtifact
// =========================
//
// 所有者不一致・存在しない場合のいずれもundefinedを返す
// (core/tact-conversation/store.tsのgetConversation()と同じ規約)。

export async function getArtifact(
  id: string,
  userId: string,
  accessToken: string
): Promise<Artifact | undefined> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_artifacts")
    .select(ARTIFACT_COLUMNS)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return undefined;
  }

  return toArtifact(data as ArtifactRow);

}

// =========================
// updateArtifactBlocks (Phase76、Phase75のupdateArtifactContent()を置換)
// =========================
//
// 呼び出し元(core/tact-conversation/orchestration.ts)が既存blocks+
// 新規/更新Blockを組み立てた「新しいblocks全体」をそのまま保存する。
// content列はrenderBlocksToPlainText()から決定論的に再導出する
// (Section3「Artifact.contentはblocksから再構成した互換フィールド」)。
// versionをここで+1する(呼び出し元がversion番号を意識しなくて済む
// ようにするための、この関数唯一の副作用ロジック、Phase75から継続)。

export async function updateArtifactBlocks(
  artifact: Artifact,
  accessToken: string,
  newBlocks: ArtifactBlock[]
): Promise<Artifact> {

  const client = createRequestScopedClient(accessToken);

  const { data, error } = await client
    .from("tact_artifacts")
    .update({
      content: renderBlocksToPlainText(newBlocks),
      blocks: newBlocks,
      version: artifact.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", artifact.id)
    .eq("user_id", artifact.userId)
    .select(ARTIFACT_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toArtifact(data as ArtifactRow);

}
