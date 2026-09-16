// =========================
// TACT Conversation Origin Boundary Regression
// =========================
//
// 対象: TACT CONVERSATION ORIGIN BOUNDARY実装(監査で確認したRoot
// Cause — tact_conversationsにorigin/source/surface概念が存在せず、
// Research履歴がuser_idのみで絞り込まれるため、Slack/Core起点の
// Conversationが混入していた問題 — の修正)。
//
// このrepositoryの既存方針(tests/tact/security/secR1P0.test.tsの
// 冒頭コメント参照)と同じ理由により、実Supabase接続を必要とする
// 検証(実際にoriginがDBへ書き込まれる・listConversations()が実際に
// フィルタする・migrationのbackfillが正しく動く)はこのHarnessには
// 含めない(Service Role Key・実DBセッションがこの環境に存在しない)。
// ここでは以下の2種類に絞って検証する:
//   1. 純粋関数(parseTurnRequestBody、DBアクセスなし)の実際の挙動
//   2. Route/Trusted Boundaryのソースコード自体が「originをclient入力
//      から読み取らず、server-owned literalとしてのみ決定している」
//      ことのsource-levelな構造的検証(secR1P0.test.tsと同じ手法)
//
// DB-levelの検証手順(origin列のNOT NULL化・backfillの実際の結果・
// listConversations()のorigin絞り込み)は、実装完了報告に記載する
// 手動検証手順に委ねる(Phase65/66以来の既存方針、npm testには
// 実Supabase接続を持ち込まない)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTurnRequestBody } from "../../../app/api/tact/tact-conversations/route";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

function indexOfOrThrow(source: string, needle: string, label: string): number {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`[conversationOriginBoundary.test] expected to find ${label} in source, but it was not present.`);
  }
  return index;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ==========================================================
  // 1. parseTurnRequestBody(): クライアントが送ってきたoriginは
  //    無視される(そもそもParsedTurnRequestBodyの型にorigin field
  //    が存在しないため、実行してみても結果に含まれない)
  // ==========================================================

  const spoofAttempt = parseTurnRequestBody({
    content: "調べて",
    origin: "research",
  } as unknown);

  results.push(
    check(
      "[Origin-1] parseTurnRequestBody(): bodyにorigin:'research'を混入させても、パース結果オブジェクトにoriginキーが一切現れない",
      spoofAttempt.ok === true && !("origin" in spoofAttempt)
    )
  );

  // ==========================================================
  // 2. app/api/tact/tact-conversations/route.ts:
  //    GET/POSTのexport wrapperがリテラル"core"のみをhandlerへ渡す
  //    (client入力からoriginを読み取る経路が存在しない)
  // ==========================================================

  const coreRouteSource = readRepoFile("app/api/tact/tact-conversations/route.ts");

  results.push(
    check(
      "[Origin-2] app/api/tact/tact-conversations/route.ts: GET wrapperがリテラル\"core\"をhandleListConversations()へ渡す",
      coreRouteSource.includes('handleListConversations(request, "core")')
    )
  );

  results.push(
    check(
      "[Origin-3] app/api/tact/tact-conversations/route.ts: POST wrapperがリテラル\"core\"をhandleConversationTurn()へ渡す",
      coreRouteSource.includes('handleConversationTurn(request, "core")')
    )
  );

  results.push(
    check(
      "[Origin-4] app/api/tact/tact-conversations/route.ts: query stringからoriginを読み取る経路が存在しない(searchParams.get(\"origin\")が無い)",
      !coreRouteSource.includes('searchParams.get("origin")')
    )
  );

  results.push(
    check(
      "[Origin-5] app/api/tact/tact-conversations/route.ts: POST bodyからoriginを読み取る経路が存在しない(parsed.origin/body.originの参照が無い)",
      !coreRouteSource.includes("parsed.origin") && !coreRouteSource.includes("body.origin")
    )
  );

  // 既存Conversationを継続する場合、そのConversation自身のoriginと
  // このRoute自身のoriginが一致しなければ拒否する(cross-surface
  // access防止)ガードが、Conversationの存在確認より後・新規作成より
  // 前に位置していることを行番号で確認する。
  const ownerNotFoundIndex = coreRouteSource.indexOf('error: "conversation not found"');
  const originGuardIndex = indexOfOrThrow(
    coreRouteSource,
    "conversation.origin !== origin",
    "origin mismatch guard"
  );
  const createCallIndex = indexOfOrThrow(
    coreRouteSource,
    "conversation = await createConversation(",
    "createConversation() call"
  );

  results.push(
    check(
      "[Origin-6] app/api/tact/tact-conversations/route.ts: origin不一致ガードは所有権チェックより後・新規作成より前に位置する(fail closed)",
      ownerNotFoundIndex !== -1 &&
        originGuardIndex > ownerNotFoundIndex &&
        originGuardIndex < createCallIndex
    )
  );

  results.push(
    check(
      "[Origin-7] app/api/tact/tact-conversations/route.ts: 新規Conversation作成はhandler自身のorigin変数を渡す(createConversation(..., origin, ...))",
      /createConversation\(\s*authenticatedUserId,\s*accessToken,\s*origin,/.test(coreRouteSource)
    )
  );

  // ==========================================================
  // 3. app/api/tact/research/conversations/route.ts:
  //    GET/POSTがリテラル"research"のみを共通handlerへ渡す
  // ==========================================================

  const researchRouteSource = readRepoFile("app/api/tact/research/conversations/route.ts");

  results.push(
    check(
      "[Origin-8] app/api/tact/research/conversations/route.ts: GETがリテラル\"research\"をhandleListConversations()へ渡す",
      researchRouteSource.includes('handleListConversations(request, "research")')
    )
  );

  results.push(
    check(
      "[Origin-9] app/api/tact/research/conversations/route.ts: POSTがリテラル\"research\"をhandleConversationTurn()へ渡す",
      researchRouteSource.includes('handleConversationTurn(request, "research")')
    )
  );

  results.push(
    check(
      "[Origin-10] app/api/tact/research/conversations/route.ts: 共通のvalidation/attachment解決/Conversation解決ロジックをtact-conversations/route.tsから再利用し、二重実装していない",
      researchRouteSource.includes('from "../../tact-conversations/route"')
    )
  );

  // ==========================================================
  // 4. core/tact-bot/execution/trustedConversationTurn.ts:
  //    Slack Trusted Boundaryがリテラル"slack"を決定する
  //    (Slack payload/message textから派生させない)
  // ==========================================================

  const trustedTurnSource = readRepoFile("core/tact-bot/execution/trustedConversationTurn.ts");

  results.push(
    check(
      "[Origin-11] trustedConversationTurn.ts: runConversationTurn()へリテラルorigin:\"slack\"を渡す",
      trustedTurnSource.includes('origin: "slack"')
    )
  );

  results.push(
    check(
      "[Origin-12] trustedConversationTurn.ts: RunConversationTurnAsTrustedActorParams(外部Channelからの入力)にorigin fieldが無い(呼び出し元からoriginを受け取れない)",
      !/origin\s*:/.test(
        trustedTurnSource.slice(
          trustedTurnSource.indexOf("export interface RunConversationTurnAsTrustedActorParams"),
          trustedTurnSource.indexOf("export type RunConversationTurnAsTrustedActorResult")
        )
      )
    )
  );

  // ==========================================================
  // 5. core/tact-conversation/store.ts:
  //    createConversation()/listConversations()がorigin必須引数を持つ
  // ==========================================================

  const storeSource = readRepoFile("core/tact-conversation/store.ts");

  results.push(
    check(
      "[Origin-13] store.ts: createConversation()の第3引数がorigin(必須、デフォルト値なし)",
      /export async function createConversation\(\s*userId: string,\s*accessToken: string,\s*origin: ConversationOrigin,/.test(storeSource)
    )
  );

  results.push(
    check(
      "[Origin-14] store.ts: listConversations()がorigin必須引数を持ち、.eq(\"origin\", origin)でフィルタする",
      /export async function listConversations\(\s*userId: string,\s*accessToken: string,\s*origin: ConversationOrigin,/.test(storeSource) &&
        storeSource.includes('.eq("origin", origin)')
    )
  );

  // ==========================================================
  // 6. core/tact-bot/conversationLink/supabaseConversationLinkStore.ts:
  //    tact_bot_conversation_linksは今回変更していない(originと
  //    bot linkは別責務のまま)
  // ==========================================================

  const linkStoreSource = readRepoFile("core/tact-bot/conversationLink/supabaseConversationLinkStore.ts");

  results.push(
    check(
      "[Origin-15] supabaseConversationLinkStore.ts: originという語を一切含まない(bot linkとorigin境界は別ファイル・別責務のまま)",
      !linkStoreSource.includes("origin")
    )
  );

  return summarize("conversation/conversationOriginBoundary", results);

}
