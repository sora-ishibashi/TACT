import { NextRequest, NextResponse } from "next/server";

import {
  createConversation,
  getConversation,
  listConversations,
  runConversationOrchestration,
} from "@/core/tact-conversation";

import { getProject } from "@/core/tact-project/store";

import { getCurrentUserContext } from "@/core/auth/getUserContext";
import { resolveReadyAttachments } from "@/core/tact-attachment/repository";
import { buildAttachmentEvidence } from "@/core/tact-attachment/evidence";
import { validateAttachmentIds } from "@/core/tact-attachment/validation";
// LW-P3: client-side Workspace Context Resolverが送ってきた
// workspaceEvidenceを、無条件に信頼せずここでvalidationする。DOM/
// Browser API/File System Access APIには依存しない(server-safe)。
import { validateWorkspaceEvidence } from "@/core/tact-context-source/localWorkspace/requestValidation";
import type { LocalWorkspaceEvidence } from "@/core/tact-context-source/localWorkspace/types";

// =========================
// GET / POST /api/tact/tact-conversations (Phase 66)
// =========================
//
// core/tact-conversation/*(Phase60〜65で確立したCanonical Conversation
// Architecture)をHTTPから利用するための最小API Boundary。
//
// 命名についてのRepository Evidence(Phase66 Step2/Step3):
// 既存の /api/tact/conversation(単体)・/api/tact/conversation/stream・
// /api/tact/conversations(一覧)はいずれもcore/conversation/*
// (Legacy、Frozen——app/legacy/page.tsx専用、components/ConversationList.tsx
// /TactInterface.tsx/InputBar.tsxからのみ参照される)を直接使っており、
// "conversation"/"conversations"のいずれの単数形・複数形パスも既に
// Legacyが占有している。したがってCanonical APIには
// core/tact-conversation/というモジュール名をそのままURLに用いる
// (新しい用語を作らず、既存のディレクトリ名をそのまま転用する)。
//
// 認証パターンはPhase31 core/tact-project/store.ts + app/api/tact/projects/
// route.tsの既存方式をそのまま踏襲する(getCurrentUserContext()で
// userId/accessTokenを取得し、両方揃わなければ401。bodyのuserIdは
// 一切信頼しない)。

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// query:
// {
//   limit?: number,
//   projectId?: string  // Phase74: 指定時はそのProject(Folder)配下の
//     Conversationのみ(Chat History表示用)。省略時は全件、"null"を
//     明示的に渡した場合は未所属のConversationのみ(listConversations()
//     のprojectId未指定/null分岐、store.ts参照)。
// }

export async function GET(
  request: NextRequest
) {

  try {

    const { userId: authenticatedUserId, accessToken } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId || !accessToken) {

      return NextResponse.json(
        {
          success: false,
          error: "authentication required",
        },
        {
          status: 401,
        }
      );

    }

    const { searchParams } = new URL(request.url);

    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : NaN;

    const rawProjectId = searchParams.get("projectId");

    if (rawProjectId && rawProjectId !== "null" && !UUID_PATTERN.test(rawProjectId)) {

      return NextResponse.json(
        {
          success: false,
          error: "projectId must be a valid UUID",
        },
        {
          status: 400,
        }
      );

    }

    const projectId =
      rawProjectId === null
        ? undefined
        : rawProjectId === "null"
          ? null
          : rawProjectId;

    const conversations = await listConversations(
      authenticatedUserId,
      accessToken,
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : undefined,
      projectId
    );

    return NextResponse.json({
      success: true,
      conversations,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to list conversations",
      },
      {
        status: 500,
      }
    );

  }

}

// body:
// {
//   conversationId?: string,  // 省略時は新規Conversationを作成
//   content: string
// }
//
// Phase67: core/tact-conversation/orchestration.tsのrunConversationOrchestration()
// へ処理を委譲する。User Message保存・Orchestrator実行・ExecutionRecord/
// Assistant Message(または Clarification Message)保存までの一連の
// Write Orderingは、Conversation Layer側(orchestration.ts)の責務であり、
// このAPI RouteはDBへ直接アクセスしない(Phase66 Section4を維持)。
// Research/Chat/Core Capabilityは依然として接続しない
// (Orchestrator経由でresearch capabilityが呼ばれる既存経路のみ)。

// =========================
// parseTurnRequestBody (純粋関数、DB/認証アクセスなし)
// =========================
//
// POST bodyのvalidationのみを担う(Section4「APIの責務はauthentication/
// input validation/Conversation Layer呼び出し/response mapping/error
// mapping」)。テスト容易性のため独立した純粋関数として切り出す
// (Section18が要求するinvalid content/invalid conversationIdの
// regression testは、実Supabase認証を経由しない限りPOSTハンドラ全体を
// 直接呼び出せない——core/auth/getAuthenticatedUser.tsがtoken検証のため
// 実ネットワーク呼び出しを行う設計であり、このHarness環境には
// Service Role Key・レート制限を回避できる実テストUserセッションが
// 存在しないため(Phase31 tests/tact/project/projectApiAuth.test.tsの
// 既存コメントで確認済みの制約と同じ)。この関数を認証の手前で
// 独立させることで、validation logic自体は実認証なしに検証できる)。

export type ParsedTurnRequestBody =
  | {
      ok: true;
      content: string;
      conversationId?: string;
      projectId?: string;
      attachmentIds: string[];
      // LW-P3: client-side Workspace Context Resolverが既にbound済み
      // (最大3file・合計最大5万文字)のLocal Workspace Evidence。
      workspaceEvidence: LocalWorkspaceEvidence[];
    }
  | { ok: false; error: string };

export function parseTurnRequestBody(body: unknown): ParsedTurnRequestBody {

  if (!body || typeof body !== "object") {
    return { ok: false, error: "request body must be a JSON object" };
  }

  const content =
    typeof (body as Record<string, unknown>).content === "string"
      ? ((body as Record<string, unknown>).content as string).trim()
      : "";

  const rawConversationId = (body as Record<string, unknown>).conversationId;

  if (
    rawConversationId !== undefined &&
    rawConversationId !== null &&
    (typeof rawConversationId !== "string" || !UUID_PATTERN.test(rawConversationId))
  ) {
    return { ok: false, error: "conversationId must be a valid UUID" };
  }

  // Phase74: projectIdは新規Conversation作成時のみ意味を持つ(既存
  // conversationIdが指定された場合は無視する、POST handler側で判断)。
  const rawProjectId = (body as Record<string, unknown>).projectId;

  const attachmentIdsResult = validateAttachmentIds((body as Record<string, unknown>).attachmentIds);
  if (!attachmentIdsResult.ok) {
    return { ok: false, error: attachmentIdsResult.message };
  }

  // LW-P3: workspaceEvidenceはoptional。省略時は空配列(既存Turnと
  // 完全に同じ挙動、後方互換)。
  const workspaceEvidenceResult = validateWorkspaceEvidence(
    (body as Record<string, unknown>).workspaceEvidence
  );
  if (!workspaceEvidenceResult.ok) {
    return { ok: false, error: workspaceEvidenceResult.message };
  }

  if (!content && attachmentIdsResult.attachmentIds.length === 0) {
    return { ok: false, error: "content or at least one attachment is required" };
  }

  if (
    rawProjectId !== undefined &&
    rawProjectId !== null &&
    (typeof rawProjectId !== "string" || !UUID_PATTERN.test(rawProjectId))
  ) {
    return { ok: false, error: "projectId must be a valid UUID" };
  }

  return {
    ok: true,
    content,
    conversationId: typeof rawConversationId === "string" ? rawConversationId : undefined,
    projectId: typeof rawProjectId === "string" ? rawProjectId : undefined,
    attachmentIds: attachmentIdsResult.attachmentIds,
    workspaceEvidence: workspaceEvidenceResult.workspaceEvidence,
  };

}

export async function POST(
  request: NextRequest
) {

  try {

    const { userId: authenticatedUserId, accessToken } =
      await getCurrentUserContext(request);

    if (!authenticatedUserId || !accessToken) {

      return NextResponse.json(
        {
          success: false,
          error: "authentication required",
        },
        {
          status: 401,
        }
      );

    }

    const body = await request.json().catch(() => null);

    const parsed = parseTurnRequestBody(body);

    if (!parsed.ok) {

      return NextResponse.json(
        {
          success: false,
          error: parsed.error,
        },
        {
          status: 400,
        }
      );

    }

    const { content, conversationId, projectId, attachmentIds, workspaceEvidence } = parsed;

    const attachments = await resolveReadyAttachments({
      userId: authenticatedUserId,
      accessToken,
      attachmentIds,
    });
    if (!attachments) {
      return NextResponse.json(
        { success: false, error: "one or more attachments are not available" },
        { status: 404 }
      );
    }
    const attachmentEvidence = buildAttachmentEvidence(attachments);

    // Phase63 Section8のWrite Ordering通り、Conversationの存在確認/作成を
    // 常に最初に行う。他Userのconversationidを指定した場合は
    // getConversation()がRLS+明示的user_id絞り込みの両方でundefinedを
    // 返すため、存在しない場合と同じ404として扱う(Section13/15の
    // Cross-user write拒否・IDOR対策)。
    let conversation = conversationId
      ? await getConversation(conversationId, authenticatedUserId, accessToken)
      : undefined;

    if (conversationId && !conversation) {

      return NextResponse.json(
        {
          success: false,
          error: "conversation not found",
        },
        {
          status: 404,
        }
      );

    }

    if (!conversation) {

      // Phase74: projectIdは新規Conversation作成時のみ受け付ける
      // (既存Conversationのproject所属をこのendpointから変更しない、
      // 最小変更)。他Userのprojectidを指定した場合はgetProject()が
      // 既存のownership check(user_id絞り込み)によりundefinedを返す
      // ため、conversation not foundと同じ404として扱う(project_idの
      // FKに他Userの行を紐付けさせない、IDOR対策)。
      if (projectId) {

        const project = await getProject(authenticatedUserId, accessToken, projectId);

        if (!project) {

          return NextResponse.json(
            {
              success: false,
              error: "project not found",
            },
            {
              status: 404,
            }
          );

        }

      }

      // Phase74: Chat History(左サイドバー)に意味のあるラベルを
      // 表示するため、新規Conversation作成時に最初のuser発言から
      // titleを自動生成する(既存createConversation()のtitle引数、
      // Phase65時点では呼び出し元が値を渡していなかっただけで、
      // 契約自体は変更しない)。要約・LLM呼び出しは行わない、単純な
      // 先頭文字列の切り出しのみ(app/api/tact/core/push/route.tsの
      // deriveTitle()と同じ考え方)。
      const TITLE_MAX_LENGTH = 60;
      const derivedTitle = content
        ? content.length > TITLE_MAX_LENGTH
          ? `${content.slice(0, TITLE_MAX_LENGTH)}...`
          : content
        : attachments[0]?.originalFilename ?? "Attachment";

      conversation = await createConversation(
        authenticatedUserId,
        accessToken,
        derivedTitle,
        projectId
      );

    }

    const turn = await runConversationOrchestration(
      conversation,
      accessToken,
      content,
      attachmentIds,
      attachmentEvidence,
      workspaceEvidence
    );

    // runConversationOrchestration()の各ステップ(User Message/
    // ExecutionRecord/Assistant Message/Clarification Message)は
    // それぞれDB側でConversation.updated_atを更新するが(Phase65
    // store.tsのbumpConversationUpdatedAt())、その最終値をturn自体は
    // 返さない。レスポンスの正確性のため、既存のgetConversation()を
    // 再利用して最新状態を取得する(Phase66から継続する方針、新しい
    // Conversation Layerの責務を追加するのではなく既存関数の呼び出しを
    // 1回増やすだけ)。
    const refreshedConversation =
      (await getConversation(conversation.id, authenticatedUserId, accessToken)) ??
      turn.conversation;

    // Section15: OrchestrationResult内部のTask情報・ExecutionRecord全体を
    // 不要にHTTPへ返さない。turn.message(assistant回答 or clarification
    // 質問)とconversationの最新状態だけを返す(Legacy
    // app/api/tact/conversation/route.tsの`message: lastMessage`と同じ
    // 意味論)。
    return NextResponse.json({
      success: true,
      conversation: refreshedConversation,
      message: turn.message,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: "failed to submit conversation turn",
      },
      {
        status: 500,
      }
    );

  }

}
