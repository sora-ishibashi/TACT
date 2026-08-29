// =========================
// tact-conversations API — Authentication & Validation Regression (Phase 66)
// =========================
//
// 対象: app/api/tact/tact-conversations/route.ts・[conversationId]/route.ts・
// [conversationId]/messages/route.ts の未認証時の挙動、およびPOST bodyの
// pure validation関数(parseTurnRequestBody)。
//
// tests/tact/project/projectApiAuth.test.ts(Phase31)と同じ方針:
// 実際のRoute Handlerを直接importして呼び出す。Authorizationヘッダーを
// 付けないため、core/auth/getAuthenticatedUser.ts内部のtoken検証
// (supabase.auth.getUser())自体が実行されず、実Supabaseへのネットワーク
// 呼び出しは発生しない(LLM/API/DB call = 0)。
//
// 認証成功後の所有者/非所有者/IDOR検証(owner GET/LIST/messages/POST、
// non-owner 404、Cross-user write拒否)は、このHarness環境に
// Service Role Key・レート制限を回避できる実テストUserセッションが
// 存在しないため(Phase31の既存制約と同じ)、npm testには含めない。
// これらはPhase66完了報告に記載の通り、実DBに対する
// `supabase db query --linked`によるauth.uid()ロールシミュレーション
// (実際のRLS Policy——auth.uid()=user_id等——をそのまま経由する、
// service role bypassではない手法)で実施し、一時SQLは実行後に削除した。

import "dotenv/config";
import { NextRequest } from "next/server";
import {
  GET as listConversationsRoute,
  POST as postTurnRoute,
  parseTurnRequestBody,
} from "../../../app/api/tact/tact-conversations/route";
import { GET as getConversationRoute } from "../../../app/api/tact/tact-conversations/[conversationId]/route";
import { GET as getMessagesRoute } from "../../../app/api/tact/tact-conversations/[conversationId]/messages/route";
import { getAttachmentOnlyOrchestrationInput } from "../../../core/tact-conversation/orchestration";
import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import { check, summarize, type CheckResult } from "../lib/check";

function makeRequest(method: string, url: string, body?: unknown): NextRequest {

  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const fakeParams = Promise.resolve({ conversationId: "00000000-0000-0000-0000-000000000000" });

  // ---- 未認証 -> 401(4エンドポイントすべて) ----

  const list = await listConversationsRoute(
    makeRequest("GET", "http://localhost/api/tact/tact-conversations")
  );
  results.push(
    check(
      "[Phase66] GET /api/tact/tact-conversations (未認証) -> 401",
      list.status === 401,
      `status=${list.status}`
    )
  );

  const post = await postTurnRoute(
    makeRequest("POST", "http://localhost/api/tact/tact-conversations", { content: "hello" })
  );
  results.push(
    check(
      "[Phase66] POST /api/tact/tact-conversations (未認証) -> 401",
      post.status === 401,
      `status=${post.status}`
    )
  );

  const get = await getConversationRoute(
    makeRequest("GET", "http://localhost/api/tact/tact-conversations/x"),
    { params: fakeParams }
  );
  results.push(
    check(
      "[Phase66] GET /api/tact/tact-conversations/[id] (未認証) -> 401",
      get.status === 401,
      `status=${get.status}`
    )
  );

  const messages = await getMessagesRoute(
    makeRequest("GET", "http://localhost/api/tact/tact-conversations/x/messages"),
    { params: fakeParams }
  );
  results.push(
    check(
      "[Phase66] GET /api/tact/tact-conversations/[id]/messages (未認証) -> 401",
      messages.status === 401,
      `status=${messages.status}`
    )
  );

  // 401レスポンスの形式(success:false、一般的なerror文言、他Userの情報等を含まない)
  const listBody = await list.json();
  results.push(
    check(
      "[Phase66] 401レスポンスの形式(success:false、一般的なerror文言)",
      listBody.success === false && typeof listBody.error === "string",
      `body=${JSON.stringify(listBody)}`
    )
  );

  // ---- parseTurnRequestBody(): pure validation ----

  results.push(
    check(
      "[Test] 正常なbody({content}) -> ok:true",
      parseTurnRequestBody({ content: "調べて" }).ok === true
    )
  );

  const attachmentId = "11111111-1111-4111-8111-111111111111";
  const attachmentOnly = parseTurnRequestBody({ content: "", attachmentIds: [attachmentId] });
  const whitespaceAttachmentOnly = parseTurnRequestBody({ content: "   ", attachmentIds: [attachmentId] });
  results.push(check("[Attachment-only] text without attachment is accepted", parseTurnRequestBody({ content: "調べて", attachmentIds: [] }).ok === true));
  results.push(check("[Attachment-only] text with attachment is accepted", parseTurnRequestBody({ content: "調べて", attachmentIds: [attachmentId] }).ok === true));
  results.push(check("[Attachment-only] empty content with attachment is accepted and remains empty", attachmentOnly.ok && attachmentOnly.content === ""));
  results.push(check("[Attachment-only] whitespace content with attachment is accepted and remains empty", whitespaceAttachmentOnly.ok && whitespaceAttachmentOnly.content === ""));
  results.push(check("[Attachment-only] empty content without attachment is rejected", parseTurnRequestBody({ content: "", attachmentIds: [] }).ok === false));
  results.push(check("[Attachment-only] invalid attachment IDs remain rejected", parseTurnRequestBody({ content: "", attachmentIds: ["not-a-uuid"] }).ok === false));

  const attachmentOnlyInstruction = getAttachmentOnlyOrchestrationInput("", true);
  results.push(check("[Attachment-only] internal fallback routes to Research", attachmentOnlyInstruction.length > 0 && classifyIntent(attachmentOnlyInstruction).intent === "research"));
  results.push(check("[Attachment-only] supplied user text is never replaced internally", getAttachmentOnlyOrchestrationInput("user supplied text", true) === "user supplied text"));

  results.push(
    check(
      "[Test] contentが空文字 -> ok:false",
      parseTurnRequestBody({ content: "" }).ok === false
    )
  );

  results.push(
    check(
      "[Test] contentが空白のみ -> ok:false(trim後判定)",
      parseTurnRequestBody({ content: "   " }).ok === false
    )
  );

  results.push(
    check(
      "[Test] contentが数値 -> ok:false",
      parseTurnRequestBody({ content: 123 }).ok === false
    )
  );

  results.push(
    check(
      "[Test] contentが未指定 -> ok:false",
      parseTurnRequestBody({}).ok === false
    )
  );

  results.push(
    check(
      "[Test] bodyがnull -> ok:false",
      parseTurnRequestBody(null).ok === false
    )
  );

  results.push(
    check(
      "[Test] bodyが配列 -> ok:false",
      parseTurnRequestBody(["not", "an", "object"]).ok === false
    )
  );

  results.push(
    check(
      "[Test] conversationIdが有効なUUID -> ok:true",
      parseTurnRequestBody({
        content: "調べて",
        conversationId: "71e8345f-a393-46a6-bb81-e63c258a5abd",
      }).ok === true
    )
  );

  results.push(
    check(
      "[Test] conversationIdが不正な形式(UUIDでない) -> ok:false",
      parseTurnRequestBody({ content: "調べて", conversationId: "not-a-uuid" }).ok === false
    )
  );

  results.push(
    check(
      "[Test] conversationIdが省略 -> ok:true(新規Conversation作成へ回る)",
      parseTurnRequestBody({ content: "調べて" }).ok === true
    )
  );

  results.push(
    check(
      "[Test] conversationIdがnull -> ok:true(省略と同じ扱い)",
      parseTurnRequestBody({ content: "調べて", conversationId: null }).ok === true
    )
  );

  const trimmed = parseTurnRequestBody({ content: "  調べて  " });
  results.push(
    check(
      "[Test] contentは前後の空白をtrimして保持する",
      trimmed.ok === true && trimmed.content === "調べて",
      `parsed=${JSON.stringify(trimmed)}`
    )
  );

  return summarize("tact-conversations API auth & validation (Phase 66)", results);

}
