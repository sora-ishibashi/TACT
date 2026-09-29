import { NextRequest, NextResponse } from "next/server";

import { persistManualWorkCorrelationOverride, getExecutionCorrelationView } from "@/core/tact-execution";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// PATCH /api/tact/runs/execution/[executionId]/reclassify
// (SOR-46 Safe manual reclassification server/API surface)
// =========================
//
// 絶対条件(SOR-46指示「Expose the already-verified reclassify_execution_work
// capability through an authenticated, tenant-safe application boundary」
// 「Do not allow direct client access to privileged RPCs」): このRouteは
// HTTP boundaryの薄いwrapperに徹する——tenant所有権検証・optimistic
// concurrency・append-only history・Work active-state検証は、すべて既存の
// reclassify_execution_work() RPC(service role専用、SOR-53でaclハード化
// 済み)とそのapplication層wrapper(persistManualWorkCorrelationOverride()、
// core/tact-execution/correlation/store.ts)がtransaction内で行う。この
// fileはbody検証・userId導出(session由来のみ、caller-suppliedを信用
// しない)・outcomeのHTTP status mappingだけを行う。

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

interface ReclassifyRequestBody {
  newWorkId: string | null;
  expectedPreviousWorkId: string | null;
  reasonCode: string;
}

function parseBody(body: unknown): { ok: true; value: ReclassifyRequestBody } | { ok: false; error: string } {

  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "request body must be a JSON object" };
  }

  const raw = body as Record<string, unknown>;

  const newWorkId = raw.newWorkId;
  if (newWorkId !== null && typeof newWorkId !== "string") {
    return { ok: false, error: "newWorkId must be a string or null" };
  }

  // expectedPreviousWorkId(絶対条件、Optimistic Concurrency): 呼び出し元が
  // 「自分が最後に見た」work_idを明示的に渡す必須値(未割当を期待する場合は
  // null)。省略を許すと「常に最新を上書きしてよい」という誤った既定動作
  // になり、Part4の「二人が同時にmanual overrideしても両方成功扱いに
  // ならないこと」という絶対条件を呼び出し元の規律だけに依存させてしまう。
  if (!("expectedPreviousWorkId" in raw)) {
    return { ok: false, error: "expectedPreviousWorkId is required (pass null if you expect no Work assigned)" };
  }

  const expectedPreviousWorkId = raw.expectedPreviousWorkId;
  if (expectedPreviousWorkId !== null && typeof expectedPreviousWorkId !== "string") {
    return { ok: false, error: "expectedPreviousWorkId must be a string or null" };
  }

  const reasonCode = raw.reasonCode;
  if (typeof reasonCode !== "string" || reasonCode.length < 1 || reasonCode.length > 255) {
    return { ok: false, error: "reasonCode is required and must be between 1 and 255 characters" };
  }

  return {
    ok: true,
    value: {
      newWorkId: newWorkId ?? null,
      expectedPreviousWorkId: expectedPreviousWorkId ?? null,
      reasonCode,
    },
  };

}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ executionId: string }> }
) {

  try {

    // 絶対条件(Human Owner指示section2「Never trust caller-supplied user_id
    // as authorization」、attention/[attentionId]/route.tsと同じ規約):
    // userIdは常にgetCurrentUserContext(request)からのみ導出する。
    const { userId } = await getCurrentUserContext(request);

    if (!userId) {
      return unauthorizedResponse();
    }

    const { executionId } = await context.params;

    let rawBody: unknown;

    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 });
    }

    const parsed = parseBody(rawBody);

    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }

    const outcome = await persistManualWorkCorrelationOverride({
      executionId,
      userId,
      expectedPreviousWorkId: parsed.value.expectedPreviousWorkId,
      newWorkId: parsed.value.newWorkId,
      changedBy: { kind: "human", id: userId },
      reasonCode: parsed.value.reasonCode,
    });

    if (outcome.status === "execution_not_found") {
      return NextResponse.json({ success: false, error: "execution not found" }, { status: 404 });
    }

    if (outcome.status === "target_work_not_found") {
      return NextResponse.json({ success: false, error: "target work not found" }, { status: 404 });
    }

    if (outcome.status === "target_work_not_correlatable") {
      return NextResponse.json({ success: false, error: "target work is no longer active" }, { status: 409 });
    }

    if (outcome.status === "stale_revision") {
      return NextResponse.json(
        { success: false, error: "expectedPreviousWorkId is stale", actualWorkId: outcome.actualWorkId },
        { status: 409 }
      );
    }

    if (outcome.status === "unavailable") {
      return NextResponse.json({ success: false, error: "reclassification service unavailable" }, { status: 503 });
    }

    if (outcome.status === "error") {
      return NextResponse.json({ success: false, error: outcome.message }, { status: 500 });
    }

    // outcome.status === "reclassified"。呼び出し元が既存read boundary
    // (SOR-53のgetExecutionCorrelationView())と同じshapeを受け取れるよう、
    // 1回だけ読み直して返す(persistManualWorkCorrelationOverride()自体は
    // Execution/Workをjoinしない薄いRPC wrapperのため)。
    const view = await getExecutionCorrelationView(executionId, userId);

    if (!view) {
      // 絶対条件(No-Fabrication): reclassifyは成功したがread modelの
      // 組み立てに必要なExecutionが読めない、という通常起き得ない不整合。
      // 推測で埋めず、素直にエラーとして報告する。
      return NextResponse.json({ success: false, error: "reclassified but could not be re-read" }, { status: 500 });
    }

    return NextResponse.json({ success: true, correlation: view });

  } catch (error) {

    console.error("[api/tact/runs/execution/[executionId]/reclassify]", error);

    return NextResponse.json({ success: false, error: "failed to reclassify execution" }, { status: 500 });

  }

}
