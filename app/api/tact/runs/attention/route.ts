import { NextRequest, NextResponse } from "next/server";

import { listExecutionAttentions, type AttentionStatus } from "@/core/tact-execution";
import { toAttentionCardView } from "@/core/tact-runs-view";

import { getCurrentUserContext } from "@/core/auth/getUserContext";

// =========================
// GET /api/tact/runs/attention?status=open (SOR-54 Screen 2: Needs Attention)
// =========================
//
// 必ずSOR-52のlistExecutionAttentions()から読む(絶対条件、SOR-54指示
// 「Needs Attention source」)——Attention判定(eligibility)をこのRoute/
// UIで再計算しない。statusの既定は"open"(SOR-54指示section
// 「Attention filtering」: M-0では最低限Openだけでもよい)。

const VALID_STATUSES: readonly AttentionStatus[] = ["open", "acknowledged", "resolved"];

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
}

export async function GET(request: NextRequest) {

  try {

    const { userId } = await getCurrentUserContext(request);

    if (!userId) {
      return unauthorizedResponse();
    }

    const { searchParams } = new URL(request.url);
    const rawStatus = searchParams.get("status");

    // SOR-18(Human Owner指示「Active Inbox read semantics」): "active"は
    // open+acknowledgedの複数status指定(resolvedを除く、まだ対応が
    // 終わっていないもの全て)。既存の"all"(無filter)/単一status値の
    // 挙動は一切変更しない——純粋加算。
    if (rawStatus === "active") {

      const items = await listExecutionAttentions(userId, { statuses: ["open", "acknowledged"] });
      return NextResponse.json({ success: true, items: items.map(toAttentionCardView) });

    }

    // "all"は無filter(SOR-54指示section「Attention filtering」:
    // Open/All程度で十分)。それ以外の未知の値はOpenへfail closedする
    // (存在しないstatusを推測してquery条件へ渡さない)。
    const status: AttentionStatus | undefined =
      rawStatus === "all"
        ? undefined
        : VALID_STATUSES.includes(rawStatus as AttentionStatus)
          ? (rawStatus as AttentionStatus)
          : "open";

    const items = await listExecutionAttentions(userId, status ? { status } : {});

    return NextResponse.json({
      success: true,
      items: items.map(toAttentionCardView),
    });

  } catch (error) {

    console.error("[api/tact/runs/attention]", error);

    return NextResponse.json({ success: false, error: "failed to load attention items" }, { status: 500 });

  }

}
