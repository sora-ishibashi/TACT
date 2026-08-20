import { NextRequest, NextResponse } from "next/server";

import {
  createConversation,
  runConversationTurn,
} from "@/core/conversation";

import { ConversationAttachment } from "@/core/conversation/types";

import {
  getConversation,
  saveConversation,
} from "@/core/conversation/store";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/conversation
// =========================
//
// body:
// {
//   conversationId?: string,  // 省略時は新規Conversationを作成
//   message: string,
//   mode?: "quick" | "think" | "deep",
//   userId?: string,
//   title?: string,
//   attachments?: ConversationAttachment[]  // STEP32: 事前に
//     /api/tact/attachments で抽出済みのファイル内容
// }
//
// conversationIdが既存のものであれば、そのConversationの
// currentTask / currentOutput / messages / workflowRuns を
// 維持したままrunConversationTurn()を実行する。

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    // STEP131: クライアントが送ってくるbody.userIdは信頼せず、
    // Authorization: Bearer <access_token> ヘッダーをserver側で
    // Supabase Authにより検証する。トークンが無い/不正な場合は
    // userId: null(未認証)として扱い、既存どおりWorkflow自体は
    // 引き続き許可する(拒否は行わない)。
    // STEP145-C: userId取得はgetCurrentUserContext()に一本化する。
    const { userId: authenticatedUserId } =
      await getCurrentUserContext(request);

    const message: string =
      body.message;

    if (
      !message ||
      typeof message !== "string"
    ) {

      return NextResponse.json(
        {
          success: false,
          error: "message is required",
        },
        {
          status: 400,
        }
      );

    }

    const mode =
      (body.mode ?? "think") as
        | "quick"
        | "think"
        | "deep";

    // STEP32: 事前に/api/tact/attachmentsで抽出済みの
    // ファイル内容(あれば)。形式チェックのみ行い、
    // 内容自体の検証(必須フィールド等)は行わない
    // (呼び出し元を信頼する既存の他フィールドと同じ扱い)。
    const attachments: ConversationAttachment[] | undefined =
      Array.isArray(body.attachments)
        ? body.attachments
        : undefined;

    let conversation =
      body.conversationId
        ? await getConversation(
            body.conversationId
          )
        : undefined;

    // STEP145-G: 既存Conversationに対する追加Turnは、そのConversationの
    // 所有者(user_id)と今回の認証済みuserIdが一致する場合のみ許可する。
    // conversation.userIdが未設定(認証導入前に作られた既存データ、
    // または未認証フローで作られたConversation)の場合は所有者が
    // 存在しないため、従来どおり誰でも継続できる(既存ユーザーを
    // 壊さないための後方互換)。
    if (
      conversation &&
      conversation.userId &&
      conversation.userId !== authenticatedUserId
    ) {

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

      conversation =
        createConversation(
          // STEP131: 未検証のbody.userIdではなく、server側で
          // 検証済みのuserIdのみを永続化対象として採用する。
          authenticatedUserId ?? undefined,
          body.title
        );

      // STEP141: 新規Conversationはこの時点ではメモリ上にしか
      // 存在しない(createConversation()はDBへ書き込まない)。
      // runConversationTurn()内部のrunWorkflow()は、Brain
      // (tact_execution_history / tact_memory)へconversation_idを
      // 外部キーとして保存するため、Workflow実行前に
      // conversationsテーブルへ先に存在させておく必要がある
      // (未挿入のままWorkflowを実行すると、外部キー制約違反で
      // Brainの永続化だけが失敗していた)。
      // saveConversation()はidを基準にupsertする既存関数のため、
      // ここで呼んでも後段(161行目付近)の最終saveConversation()と
      // 重複更新にはならない(同じ行を最新状態で上書きするだけ)。
      try {

        await saveConversation(
          conversation
        );

      } catch (saveError) {

        console.error(
          "Failed to pre-save new conversation before workflow:",
          saveError
        );

      }

    }

    let workflowRun;

    try {

      workflowRun =
        await runConversationTurn(
          conversation,
          message,
          mode,
          undefined,
          attachments,
          authenticatedUserId
        );

    } catch (workflowError) {

      // runConversationTurn()自体の失敗処理(run.status="failed"の
      // 設定・rethrow)は変更しない。ここではrethrowされた後でも、
      // ここまでにconversationへ反映された状態
      // (追加されたuser message、status="failed"のworkflowRunなど)を
      // 保存するためだけにsaveConversation()を呼ぶ。
      //
      // 保存自体が失敗しても、元のWorkflowエラーを握り潰さないよう
      // ログのみに留め、レスポンスは従来通りworkflowError由来のものとする。

      try {

        await saveConversation(
          conversation
        );

      } catch (saveError) {

        console.error(
          "Failed to persist conversation after workflow failure:",
          saveError
        );

      }

      console.error(workflowError);

      return NextResponse.json(
        {
          success: false,
          error: String(workflowError),
          conversationId: conversation.id,
        },
        {
          status: 500,
        }
      );

    }

    await saveConversation(
      conversation
    );

    const lastMessage =
      conversation.messages[
        conversation.messages.length - 1
      ];

    return NextResponse.json({

      success: true,

      conversation,

      message: lastMessage,

      currentOutput:
        conversation.currentOutput,

      workflowRun,

    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: String(error),
      },
      {
        status: 500,
      }
    );

  }

}

// =========================
// GET /api/tact/conversation?conversationId=...
// =========================
//
// 既存Conversationの現在状態を取得する
// (ページ再読み込み時などに利用可能)。

export async function GET(
  request: NextRequest
) {

  const { searchParams } =
    new URL(request.url);

  const conversationId =
    searchParams.get("conversationId");

  if (!conversationId) {

    return NextResponse.json(
      {
        success: false,
        error:
          "conversationId is required",
      },
      {
        status: 400,
      }
    );

  }

  const conversation =
    await getConversation(conversationId);

  if (!conversation) {

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

  // STEP145-G: POST側と同じ所有者チェック。conversation.userIdが
  // 未設定(認証導入前/未認証フローのConversation)の場合は
  // 従来どおり誰でも取得できる(既存ユーザーを壊さないための
  // 後方互換)。存在自体を漏らさないため404で返す(403にしない)。
  const { userId: authenticatedUserId } =
    await getCurrentUserContext(request);

  if (
    conversation.userId &&
    conversation.userId !== authenticatedUserId
  ) {

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

  return NextResponse.json({
    success: true,
    conversation,
  });

}
