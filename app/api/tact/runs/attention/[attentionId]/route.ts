import { NextRequest, NextResponse } from "next/server";

import { transitionExecutionAttention, getExecutionAttention, type AttentionAction } from "@/core/tact-execution";
import { toAttentionCardView } from "@/core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// PATCH /api/tact/runs/attention/[attentionId] (SOR-48 Attention Lifecycle)
// =========================
//
// 絶対条件(Human Owner指示section2「Never trust caller-supplied
// user_id as authorization」): userIdは常にgetCurrentUserContext(request)
// からのみ導出する——request bodyはaction文字列(acknowledge/resolveの
// 2値のみ)しか受け付けない。
//
// 遷移そのものの安全性(concurrency-safe CAS、tenant所有権、
// idempotency)はcore/tact-execution/permission/attentionStore.tsの
// transitionExecutionAttention()が単一conditional UPDATE文で担う
// ——このrouteはHTTP boundaryの薄いwrapperに徹する(action検証+
// userId導出+response整形のみ)。

const VALID_ACTIONS: readonly AttentionAction[] = ["acknowledge", "resolve"];

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ attentionId: string }> }
) {

  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {
      return unauthorizedResponse();
    }

    const { attentionId } = await context.params;

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 });
    }

    const rawAction = (body as { action?: unknown } | null)?.action;

    // 絶対条件(「no arbitrary status string from caller」): actionは
    // 厳密に2値のいずれかのみ。statusを直接受け取らない(遷移元/遷移先を
    // 呼び出し元に選ばせない、状態機械はサーバー側でのみ決定する)。
    if (typeof rawAction !== "string" || !VALID_ACTIONS.includes(rawAction as AttentionAction)) {
      return NextResponse.json(
        { success: false, error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
        { status: 400 }
      );
    }

    const outcome = await transitionExecutionAttention(attentionId, userId, rawAction as AttentionAction);

    if (outcome.status === "not_found") {
      return NextResponse.json({ success: false, error: "attention not found" }, { status: 404 });
    }

    if (outcome.status === "unavailable") {
      return NextResponse.json({ success: false, error: "attention service unavailable" }, { status: 503 });
    }

    if (outcome.status === "error") {
      return NextResponse.json({ success: false, error: outcome.message }, { status: 500 });
    }

    // transitioned/no_opいずれも、呼び出し元(RunsSection)が既存read
    // boundary(listExecutionAttentions/getExecutionAttention)と同じ
    // shape(AttentionCardView)を受け取れるよう、Work title等を含む
    // full read modelを1回だけ読み直して返す——transitionExecutionAttention()
    // 自体はWork/Decision/Executionをjoinしない薄いCAS操作のため。
    const item = await getExecutionAttention(attentionId, userId);

    if (!item) {
      // 絶対条件(No-Fabrication): 遷移は成功したがread modelの組み立てに
      // 必要なExecution/Decisionが読めない、という通常起き得ない
      // 不整合。推測で埋めず、素直にエラーとして報告する。
      return NextResponse.json({ success: false, error: "attention transitioned but could not be re-read" }, { status: 500 });
    }

    return NextResponse.json({ success: true, changed: outcome.status === "transitioned", attention: toAttentionCardView(item) });

  } catch (error) {

    console.error("[api/tact/runs/attention/[attentionId]][PATCH]", error);

    return NextResponse.json({ success: false, error: "failed to update attention" }, { status: 500 });

  }

}
