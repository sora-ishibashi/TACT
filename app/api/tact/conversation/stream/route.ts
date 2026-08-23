import { NextRequest } from "next/server";

import {
  createConversation,
  runConversationTurn,
} from "@/core/conversation";

import { ConversationAttachment } from "@/core/conversation/types";

import {
  getConversation,
  saveConversation,
} from "@/core/conversation/store";

import { getAuthenticatedUser } from "@/core/auth/getAuthenticatedUser";

// =========================
// POST /api/tact/conversation/stream
// =========================
//
// STEP17: 既存のPOST /api/tact/conversation(app/api/tact/conversation/route.ts)
// とまったく同じConversationロジック(取得/新規作成 -> runConversationTurn
// -> saveConversation)を1回だけ実行しつつ、runWorkflow()が実際に
// 発火するAgentイベント(start/complete/failed)をSSE形式でリアルタイムに
// 中継する。
//
// 重要:
// - Workflowを二重実行しない。runConversationTurn()の呼び出しは1箇所のみ。
// - 既存のPOST /api/tact/conversationは無変更のまま残す
//   (このエンドポイントは追加のものであり、既存の契約を壊さない)。
// - 最終的に送る"result"イベントの中身は、既存POSTルートのレスポンス
//   ({success, conversation, message, currentOutput, workflowRun})と
//   同一の形にする。
// - SSEのエンコード方式(`data: ...\n\n`)は既存のapp/api/tact/stream/route.ts
//   と同じパターンを再利用する。
//
// body:
// {
//   conversationId?: string,
//   message: string,
//   mode?: "quick" | "think" | "deep",
//   userId?: string,
//   title?: string,
//   attachments?: ConversationAttachment[]  // STEP32: 事前に
//     /api/tact/attachments で抽出済みのファイル内容
// }
//
// イベント:
// { type: "connected", conversationId }
// { type: "agentEvent", event: WorkflowEvent }  // 実際のAgent開始/完了/失敗
// { type: "result", success: true, conversation, message, currentOutput, workflowRun }
// { type: "error", error, conversationId? }

export async function POST(
  request: NextRequest
) {

  const encoder = new TextEncoder();

  const body = await request.json();

  const stream = new ReadableStream({

    async start(controller) {

      function send(payload: unknown) {

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify(payload)}\n\n`
          )
        );

      }

      try {

        // STEP131: クライアントが送ってくるbody.userIdは信頼せず、
        // Authorization: Bearer <access_token> ヘッダーをserver側で
        // Supabase Authにより検証する。トークンが無い/不正な場合は
        // userId: null(未認証)として扱い、既存どおりWorkflow自体は
        // 引き続き許可する(拒否は行わない)。
        const { userId: authenticatedUserId } =
          await getAuthenticatedUser(request);

        const message: string =
          body.message;

        if (
          !message ||
          typeof message !== "string"
        ) {

          send({
            type: "error",
            error: "message is required",
          });

          return;

        }

        const mode =
          (body.mode ?? "think") as
            | "quick"
            | "think"
            | "deep";

        // STEP32: 事前に/api/tact/attachmentsで抽出済みの
        // ファイル内容(あれば)。
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

        if (!conversation) {

          conversation =
            createConversation(
              // STEP131: 未検証のbody.userIdではなく、server側で
              // 検証済みのuserIdのみを永続化対象として採用する。
              authenticatedUserId ?? undefined,
              body.title
            );

          // STEP153: 非StreamのPOST /api/tact/conversation
          // (app/api/tact/conversation/route.ts、STEP141)と同じ
          // 事前save処理。新規Conversationはこの時点ではメモリ上にしか
          // 存在しない(createConversation()はDBへ書き込まない)。
          // runConversationTurn()内部のrunWorkflow()は、Brain
          // (tact_execution_history / tact_memory)へconversation_idを
          // 外部キーとして保存するため、Workflow実行前に
          // conversationsテーブルへ先に存在させておく必要がある
          // (未挿入のままWorkflowを実行すると、外部キー制約違反で
          // Brainの永続化だけが失敗していた。STEP152/153で発見)。
          // saveConversation()はidを基準にupsertする既存関数のため、
          // ここで呼んでも後段の最終saveConversation()と重複更新には
          // ならない(同じ行を最新状態で上書きするだけ)。
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

        send({
          type: "connected",
          conversationId: conversation.id,
        });

        let workflowRun;

        try {

          workflowRun =
            await runConversationTurn(
              conversation,
              message,
              mode,
              (event) => {

                send({
                  type: "agentEvent",
                  event,
                });

              },
              attachments,
              authenticatedUserId
            );

        } catch (workflowError) {

          // 既存POSTルートと同じフォールバック:
          // Workflow失敗時も、ここまでにconversationへ反映された状態
          // (追加されたuser message、status="failed"のworkflowRunなど)を
          // 保存する。保存自体の失敗は元のWorkflowエラーを握り潰さない
          // ようログのみに留める。

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

          send({
            type: "error",
            error: String(workflowError),
            conversationId: conversation.id,
          });

          return;

        }

        await saveConversation(
          conversation
        );

        const lastMessage =
          conversation.messages[
            conversation.messages.length - 1
          ];

        send({

          type: "result",

          success: true,

          conversation,

          message: lastMessage,

          currentOutput:
            conversation.currentOutput,

          workflowRun,

        });

      } catch (error) {

        console.error(error);

        send({
          type: "error",
          error: String(error),
        });

      } finally {

        controller.close();

      }

    },

  });

  return new Response(stream, {

    headers: {

      "Content-Type":
        "text/event-stream",

      "Cache-Control":
        "no-cache",

      Connection:
        "keep-alive",

    },

  });

}
