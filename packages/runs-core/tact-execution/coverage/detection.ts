import type { AppendCaptureGapInput, CoverageStatus, ObservationSurface, ObservationSurfaceHealth } from "./types";

export type CaptureGapSignal =
  | { kind: "expected_heartbeat_missing"; expectedAt: string; observedAt: string }
  | { kind: "adapter_error"; observedAt: string; errorKind: string }
  | { kind: "stale_last_seen"; observedAt: string; staleAfterMs: number }
  | { kind: "manual_outage"; observedAt: string; evidenceRef?: string | null }
  | { kind: "partial_capability"; observedAt: string; missingCapability: string };

export interface CaptureGapDetection {
  health: ObservationSurfaceHealth;
  coverageStatus: CoverageStatus;
  gap: Omit<AppendCaptureGapInput, "userId" | "observationSurfaceId">;
}

// This is intentionally a testable classification hook, not a scheduler or a
// monitoring service. Callers decide when a signal is sufficiently evidenced.
export function detectCaptureGap(surface: ObservationSurface, signal: CaptureGapSignal): CaptureGapDetection {
  const base = { detectedAt: signal.observedAt, provenance: { signal: signal.kind } };

  switch (signal.kind) {
    case "partial_capability":
      return {
        health: "DEGRADED", coverageStatus: "PARTIAL",
        gap: { ...base, reason: `Observable capability unavailable: ${signal.missingCapability}`, detectionMethod: "capability_declaration", confidence: "HIGH", status: "PARTIAL", affectedScope: signal.missingCapability },
      };
    case "adapter_error":
      return {
        health: "DEGRADED", coverageStatus: "PARTIAL",
        gap: { ...base, reason: "Adapter reported an observation error", detectionMethod: "adapter_error", confidence: "MEDIUM", status: "GAP_DETECTED", affectedScope: signal.errorKind },
      };
    case "manual_outage":
      return {
        health: "OUTAGE", coverageStatus: "OUTAGE",
        gap: { ...base, reason: "Reality test or operator reported an observation outage", detectionMethod: "manual_reality_test", confidence: "HIGH", status: "OUTAGE", evidenceRef: signal.evidenceRef ?? null },
      };
    case "expected_heartbeat_missing":
      return {
        health: "OUTAGE", coverageStatus: "OUTAGE",
        gap: { ...base, reason: "Expected observation heartbeat was missing", detectionMethod: "heartbeat_missing", confidence: "MEDIUM", status: "GAP_DETECTED", affectedFrom: signal.expectedAt, affectedTo: signal.observedAt },
      };
    case "stale_last_seen":
      return {
        health: "UNKNOWN", coverageStatus: "UNKNOWN",
        gap: { ...base, reason: "Observation surface has not been seen within its declared freshness window", detectionMethod: "stale_last_seen", confidence: "LOW", status: "UNKNOWN", affectedFrom: surface.lastSeenAt, affectedTo: signal.observedAt, provenance: { signal: signal.kind, staleAfterMs: signal.staleAfterMs } },
      };
  }
}

export function isCaptureGapAttentionWorthy(gap: Pick<AppendCaptureGapInput, "status" | "confidence">): boolean {
  return gap.status === "GAP_DETECTED" || gap.status === "OUTAGE" || gap.status === "PARTIAL" || (gap.status === "UNKNOWN" && gap.confidence === "HIGH");
}
