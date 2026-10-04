import { NextRequest, NextResponse } from "next/server";
import {
  getExecutionById,
  listDownstreamPermissionEvidenceForExecution,
  listPermissionDecisionsForExecution,
} from "@tact/runs-core/tact-execution";
import { getCurrentUserContext } from "@/core/auth/getUserContext";
import { toExecutionInspectorViewModel } from "@/lib/executionInspector";

export async function GET(request: NextRequest, context: { params: Promise<{ executionId: string }> }) {
  const { userId, accessToken } = await getCurrentUserContext(request);
  if (!userId || !accessToken) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
  const { executionId } = await context.params;
  const execution = await getExecutionById(executionId, userId);
  if (!execution) return NextResponse.json({ success: false, error: "execution not found" }, { status: 404 });
  const [decisions, downstream] = await Promise.all([
    listPermissionDecisionsForExecution(executionId),
    listDownstreamPermissionEvidenceForExecution(executionId, userId),
  ]);
  return NextResponse.json({ success: true, inspector: toExecutionInspectorViewModel(execution, decisions, downstream) });
}
