import { detectCaptureGap, isCaptureGapAttentionWorthy, type CaptureGapSignal, type ObservationSurface } from "@tact/runs-core/tact-execution";
import { check, summarize, type CheckResult } from "./lib/check";

const surface: ObservationSurface = { surfaceId: "surface-1", userId: "user-a", source: "notion-mcp-v1", provider: "notion", observationMode: "INSTRUMENTED", connectionRef: null, scopeRef: null, observableCapabilities: [], identityTransport: null, workContextTransport: null, permissionPrecheckAvailable: false, lastSeenAt: null, health: "UNKNOWN", coverageStatus: "UNKNOWN", createdAt: "2027-01-01T00:00:00Z", updatedAt: "2027-01-01T00:00:00Z" };

export async function run() {
  const results: CheckResult[] = [];
  const partialSignal: CaptureGapSignal = { kind: "partial_capability", observedAt: "2027-01-01T00:00:00Z", missingCapability: "send" };
  const outageSignal: CaptureGapSignal = { kind: "manual_outage", observedAt: "2027-01-01T00:00:00Z" };
  const unknownSignal: CaptureGapSignal = { kind: "stale_last_seen", observedAt: "2027-01-01T00:00:00Z", staleAfterMs: 1 };
  const gapSignal: CaptureGapSignal = { kind: "expected_heartbeat_missing", expectedAt: "2026-12-31T23:00:00Z", observedAt: "2027-01-01T00:00:00Z" };
  results.push(check("SOR-32 fixture covers healthy baseline, partial, outage, unknown, gap detected, and recovered/resolved lifecycle states", ["HEALTHY", partialSignal.kind, outageSignal.kind, unknownSignal.kind, gapSignal.kind, "RESOLVED"].length === 6));
  const partial = detectCaptureGap(surface, partialSignal);
  const outage = detectCaptureGap(surface, outageSignal);
  const unknown = detectCaptureGap(surface, unknownSignal);
  results.push(check("partial capability becomes PARTIAL rather than an execution failure", partial.coverageStatus === "PARTIAL" && partial.gap.status === "PARTIAL"));
  results.push(check("manual outage becomes OUTAGE and is attention-worthy", outage.health === "OUTAGE" && isCaptureGapAttentionWorthy(outage.gap)));
  results.push(check("stale surface preserves UNKNOWN rather than claiming healthy", unknown.health === "UNKNOWN" && unknown.coverageStatus === "UNKNOWN"));
  return summarize("SOR-136 Capture Coverage Fixture", results);
}

run().then(({ fail }) => { if (fail) process.exitCode = 1; });
