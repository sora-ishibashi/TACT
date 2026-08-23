import { NextRequest, NextResponse } from "next/server";

import { runResearch } from "@/core/tact-research";
import { createSupabaseCoreCapability } from "@/core/tact-core/supabaseCoreCapability";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// POST /api/tact/research (STEP201)
// =========================
//
// TACT Research(core/tact-research/runResearch())をLegacy Workflow
// Engineの外側から呼び出すための、最小限の外部入口。
//
// 責務(STEP201-B): HTTP入力の受け取り・最低限のvalidation・Research
// 用入力型への変換・runResearch()の1回呼び出し・ResearchResultの
// HTTPレスポンスへの変換・例外のAPIレベルエラーへの変換、だけを行う。
// Search/LLM呼び出し・Requirement Decomposition・Knowledge Gap・
// Safety判定・Evidence validation・Retry・Core Knowledge保存は
// 一切行わない(すべてrunResearch()側の既存責務のまま)。
//
// STEP176〜200で確立したCore→Research境界を維持する: このRouteは
// CoreCapabilityの具体実装を1つ選んで渡すだけであり、Research自身は
// 呼び出し元がどのCoreCapability実装を使っているかを一切関知しない
// (runResearch.ts・core/tact-research/配下は無変更)。
//
// STEP211: mockCoreCapability(in-memory)からsupabaseCoreCapability
// (Persistent、STEP204〜208で設計・実装、STEP209でmigration適用済み)
// へ接続を差し替えた。User Scopeのみ実際にSupabaseから読み込む
// (Organization/Project/Conversation Scopeは引き続き未実装であり、
// 該当paramsが渡された場合はsupabaseCoreCapability.ts側で明示的に
// Errorになる)。userId未指定(未認証)の場合はDBへ問い合わせず空の
// CoreContextを返す(全ユーザーデータ取得のfallbackは行わない、
// STEP208-D)。ResearchからCoreへの書き込み(recordKnowledge等)は
// 引き続き一切発生しない(既存契約のまま)。
//
// 既知の制約(STEP211時点): User A/B間の2実ユーザーによるIsolation
// 実証はまだ行われていない(STEP210で未登録ownerIdに対するnegative
// lookupのみ確認済み)。DB側isolationは現状「アプリケーション層の
// WHERE句(scope='user' AND user_id=ownerId)」のみで担保されており、
// RLSはStage 0(anonキーからの全操作許可)のまま、auth.uid()ベースの
// Stage 1 RLSは未実装。
//
// レスポンスについて: ResearchResult(success/answer/evidence/metadata/
// errorMessage)をほぼそのまま返す。success:true/falseいずれの場合も
// HTTPステータスは200とする(Researchが「実行として正常に完了し、
// 判別可能な結果を返した」ことをHTTPレベルの成功として扱い、
// success:falseはbody内で表現する既存ResearchResultの契約をそのまま
// 尊重するため)。バリデーションエラーのみ400、想定外の例外は500。
//
// body:
// {
//   query: string
// }

export async function POST(
  request: NextRequest
) {

  try {

    const body = await request.json();

    const query = body.query;

    if (
      !query ||
      typeof query !== "string" ||
      !query.trim()
    ) {

      return NextResponse.json(
        {
          success: false,
          error: "query is required and must be a non-empty string",
        },
        { status: 400 }
      );

    }

    // STEP131/STEP145-Cと同じ既存方針(app/api/tact/conversation/route.ts
    // 参照): クライアントが送ってくるuserIdは信頼せず、Authorization
    // ヘッダーをserver側で検証する。未認証でも拒否はしない(既存Route群
    // と同じ後方互換。Researchはユーザー単位のスコープが無くても実行
    // できるため)。
    const { userId: authenticatedUserId } =
      await getCurrentUserContext(request);

    // STEP211: Persistent CoreCapability(Supabase、User Scopeのみ)。
    const core = createSupabaseCoreCapability();

    const context = await core.loadContext({
      userId: authenticatedUserId ?? undefined,
    });

    // runResearch()は1回だけ呼び出す(絶対条件3・22: LLM最大1回契約の
    // 維持、Retry/再生成を行わない)。
    const result = await runResearch(
      { query, context },
      core
    );

    // ResearchResultをそのままレスポンスとして返す(STEP201-C: 既存
    // ResearchResult契約を優先し、新しい変換層を追加しない。
    // success:false時も分岐せず同じ経路でそのまま返す)。
    return NextResponse.json(result);

  } catch (error) {

    console.error(
      "TACT Research API failed:",
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
