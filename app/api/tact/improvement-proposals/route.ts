import { NextRequest, NextResponse } from "next/server";

import {
  getImprovementProposals,
  getImprovementProposalById,
} from "@/core/brain/memory";
import { buildClaudeCodeInstruction } from "@/core/brain/claudeCodeInstruction";
import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/improvement-proposals (最速実装モード STEP6)
// =========================
//
// TACT Brainが自動生成したImprovementProposal(core/brain/analyzer.ts)
// を、人間が確認できる形で一覧取得する。Claude Codeを自動実行する
// エンドポイントではない(読み取り専用)。
//
// STEP146-C/F: userId取得はgetCurrentUserContext()に一本化し、
// 一覧・単体取得ともにuserIdでスコープする。
// - 認証済み: そのuserId所有のProposalのみ。
// - 未認証: user_id IS NULL(認証導入前の既存データ)のみ
//   (STEP145のGET /api/tact/conversationsと同じ後方互換方針)。
//
// query:
// {
//   limit?: number  // 省略時は20(id未指定時のみ使用)
//   id?: string     // 指定時は1件取得。他ユーザー所有のidの場合、
//                    // 存在の有無を漏らさないため404を返す。
// }

export async function GET(
  request: NextRequest
) {

  try {

    const { searchParams } = new URL(request.url);

    const { userId: authenticatedUserId } =
      await getCurrentUserContext(request);

    const id = searchParams.get("id");

    if (id) {

      const proposal =
        await getImprovementProposalById(
          id,
          authenticatedUserId
        );

      if (!proposal) {

        return NextResponse.json(
          { success: false, error: "proposal not found" },
          { status: 404 }
        );

      }

      return NextResponse.json({
        success: true,
        proposal: {
          ...proposal,
          claudeCodeInstruction:
            buildClaudeCodeInstruction(proposal),
        },
      });

    }

    const limitParam = searchParams.get("limit");

    const parsedLimit =
      limitParam ? Number(limitParam) : NaN;

    const proposals =
      await getImprovementProposals(
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : undefined,
        authenticatedUserId
      );

    return NextResponse.json({

      success: true,

      proposals: proposals.map((proposal) => ({
        ...proposal,
        claudeCodeInstruction:
          buildClaudeCodeInstruction(proposal),
      })),

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
