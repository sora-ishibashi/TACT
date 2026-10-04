import { NextRequest, NextResponse } from "next/server";
import { captureExecution, observeExecutionPermission, observeExecutionWorkCorrelation } from "@tact/runs-core/tact-execution";
import { linkReceiptToExecution, trustedCaptureInput, verifyAndClaimTelemetry } from "@/lib/telemetry/executionTelemetry";
export interface SignedTelemetryIngestDeps {
  verify: typeof verifyAndClaimTelemetry;
  capture: typeof captureExecution;
  link: typeof linkReceiptToExecution;
  permission: typeof observeExecutionPermission;
  correlation: typeof observeExecutionWorkCorrelation;
}
const defaultDeps: SignedTelemetryIngestDeps = { verify: verifyAndClaimTelemetry, capture: captureExecution, link: linkReceiptToExecution, permission: observeExecutionPermission, correlation: observeExecutionWorkCorrelation };
export async function ingestSignedTelemetry(request: NextRequest, deps: SignedTelemetryIngestDeps = defaultDeps) {
  const accepted = await deps.verify(request);
  if (!accepted.ok) { const status = accepted.reason === "replay_detected" ? 409 : accepted.reason === "receipt_store_unavailable" ? 503 : accepted.reason === "payload_invalid" || accepted.reason === "malformed_headers" || accepted.reason === "missing_headers" ? 400 : 401; return NextResponse.json({ success: false, error: status === 409 ? "replay rejected" : status === 503 ? "telemetry unavailable" : status === 400 ? "invalid telemetry request" : "telemetry authentication failed" }, { status }); }
  const capture = await deps.capture(trustedCaptureInput(accepted.value));
  if (capture.status !== "captured" && capture.status !== "duplicate") return NextResponse.json({ success: false, error: "telemetry accepted but execution capture failed" }, { status: 202 });
  if (!await deps.link(accepted.value.receiptId, capture.execution.id, capture.execution.userId)) return NextResponse.json({ success: false, error: "telemetry accepted but link unavailable" }, { status: 202 });
  if (capture.execution.permissionStatus === "pending") {
    try { await deps.permission(capture.execution); } catch (error) {
      console.error("[runs/execution-ingest] permission observation failed", { errorKind: error instanceof Error ? error.name : typeof error });
    }
  }
  try { await deps.correlation(capture.execution); } catch (error) {
    console.error("[runs/execution-ingest] work correlation failed", { errorKind: error instanceof Error ? error.name : typeof error });
  }
  return NextResponse.json({ success: true, executionId: capture.execution.id }, { status: 202 });
}
export async function POST(request: NextRequest) { return ingestSignedTelemetry(request); }
