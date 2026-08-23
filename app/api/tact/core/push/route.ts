import { NextRequest, NextResponse } from "next/server";

import { createSupabaseCoreCapability } from "@/core/tact-core/supabaseCoreCapability";
import { getCurrentUserContext } from "@/core/auth/getUserContext";
import type {
  KnowledgeItem,
  CoreMemory,
  Example,
} from "@/core/tact-core";

// =========================
// POST /api/tact/core/push (STEP212)
// =========================
//
// TACT CoreへのDirect Push入口。Researchを経由せず、ユーザーが
// 明示的にTACTへ教えた情報をPersistent Core(User Scope)へ保存する。
//
// 責務分離(STEP212絶対条件5-1): このRouteはSupabaseへ直接INSERTしない。
// 必ず既存の`createSupabaseCoreCapability()`(STEP208、無変更)経由で
// `recordKnowledge()`/`recordMemory()`/`recordExample()`を呼ぶだけに
// 留め、ownerId/scope/DB DEFAULT/mapping/validationは全て既存実装に
// 一元化する(新しいSupabase INSERT処理をここに書かない)。
//
// User Scopeのみ(絶対条件5-2): Organization/Project/Conversation
// Scopeは実装しない。認証済みuserIdをそのままownerIdとして使う。
//
// owner isolation(絶対条件5-3): userIdが取得できない場合は明示的に
// 401を返す。全ユーザー・匿名ユーザーへのfallback保存は行わない。
//
// 自動分類は行わない(絶対条件4): `type`(knowledge/memory/example)は
// 呼び出し側が明示する。LLMによる分類はSTEP212のスコープ外。
//
// body:
// {
//   content: string,
//   type: "knowledge" | "memory" | "example"
// }
//
// response(成功時、既存/api/tact/research/route.tsのconventionに
// 合わせ、判別可能な結果をほぼそのまま返す):
// {
//   success: true,
//   type: "knowledge" | "memory" | "example",
//   item: KnowledgeItem | CoreMemory | Example
// }

type PushType = "knowledge" | "memory" | "example";

const VALID_TYPES: readonly PushType[] = ["knowledge", "memory", "example"];

// STEP212: Direct Pushは`content`と`type`しか受け取らない最小契約
// のため、各recordメソッドが要求するそれ以外の必須フィールドには、
// ここで固定のデフォルト値を与える。将来のclassifier追加時(STEP214
// 以降)も、この関数群の入出力(content→Domain object)だけを差し替えれば
// 済む形にしてある。
//
// - source: "user_push"という新しい自由記述値を使う(既存の
//   source?: string / source: stringフィールドはenum制約が無く、
//   "upload"/"research"等と同じ位置づけの値を追加するだけであり、
//   型変更を伴わない)。
// - title: contentの先頭を短く切り出したものを暫定titleとする
//   (Direct Pushは別途titleを収集しないため)。
// - confidence: "high"(ユーザーが直接教えた情報であり、推測や
//   検索結果由来ではないため)。
// - importance/type(Memory)/kind(Knowledge): 最も汎用的な既定値。

const TITLE_MAX_LENGTH = 60;

function deriveTitle(content: string): string {

  const trimmed = content.trim();

  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}...`
    : trimmed;

}

async function pushKnowledge(
  core: ReturnType<typeof createSupabaseCoreCapability>,
  ownerId: string,
  content: string
): Promise<KnowledgeItem> {

  return core.recordKnowledge({
    scope: "user",
    ownerId,
    source: "user_push",
    tags: [],
    kind: "document",
    title: deriveTitle(content),
    content,
  });

}

async function pushMemory(
  core: ReturnType<typeof createSupabaseCoreCapability>,
  ownerId: string,
  content: string
): Promise<CoreMemory> {

  return core.recordMemory({
    scope: "user",
    ownerId,
    type: "context",
    content,
    importance: 5,
    confidence: "high",
    source: "user_push",
  });

}

async function pushExample(
  core: ReturnType<typeof createSupabaseCoreCapability>,
  ownerId: string,
  content: string
): Promise<Example> {

  return core.recordExample({
    scope: "user",
    ownerId,
    source: "user_push",
    tags: [],
    title: deriveTitle(content),
    description: content,
    importance: 5,
  });

}

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    const content = body.content;
    const type = body.type;

    if (
      !content ||
      typeof content !== "string" ||
      !content.trim()
    ) {

      return NextResponse.json(
        {
          success: false,
          error: "content is required and must be a non-empty string",
        },
        { status: 400 }
      );

    }

    if (
      typeof type !== "string" ||
      !VALID_TYPES.includes(type as PushType)
    ) {

      return NextResponse.json(
        {
          success: false,
          error: `type must be one of: ${VALID_TYPES.join(", ")}`,
        },
        { status: 400 }
      );

    }

    // STEP212絶対条件5-3: bodyのuserIdは信頼しない(既存の
    // /api/tact/research/route.tsと同じ既存方針)。認証済みuserIdが
    // 取得できない場合は明示的に401とし、匿名・全ユーザーへの
    // fallback保存を行わない。
    const { userId: authenticatedUserId } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId) {

      return NextResponse.json(
        {
          success: false,
          error: "authentication is required to push to Core",
        },
        { status: 401 }
      );

    }

    const core = createSupabaseCoreCapability();

    const pushType = type as PushType;

    let item: KnowledgeItem | CoreMemory | Example;

    switch (pushType) {

      case "knowledge":
        item = await pushKnowledge(core, authenticatedUserId, content);
        break;

      case "memory":
        item = await pushMemory(core, authenticatedUserId, content);
        break;

      case "example":
        item = await pushExample(core, authenticatedUserId, content);
        break;

    }

    return NextResponse.json({
      success: true,
      type: pushType,
      item,
    });

  } catch (error) {

    console.error(
      "TACT Core Direct Push failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: String(error),
      },
      { status: 500 }
    );

  }

}
