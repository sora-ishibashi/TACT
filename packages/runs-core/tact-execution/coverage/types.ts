import type { ExecutionProvider } from "../types";

export const OBSERVATION_MODES = ["INLINE", "INSTRUMENTED", "RECONCILED", "OTHER"] as const;
export type ObservationMode = (typeof OBSERVATION_MODES)[number];

export const OBSERVATION_SURFACE_HEALTH = ["UNKNOWN", "HEALTHY", "DEGRADED", "OUTAGE"] as const;
export type ObservationSurfaceHealth = (typeof OBSERVATION_SURFACE_HEALTH)[number];

export const COVERAGE_STATUSES = ["UNKNOWN", "PARTIAL", "COVERED", "OUTAGE"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const CAPTURE_GAP_STATUSES = ["UNKNOWN", "PARTIAL", "OUTAGE", "GAP_DETECTED", "RESOLVED"] as const;
export type CaptureGapStatus = (typeof CAPTURE_GAP_STATUSES)[number];

export interface ObservationSurface {
  surfaceId: string;
  userId: string;
  source: string;
  provider: ExecutionProvider;
  observationMode: ObservationMode;
  connectionRef: string | null;
  scopeRef: string | null;
  observableCapabilities: readonly string[];
  identityTransport: string | null;
  workContextTransport: string | null;
  permissionPrecheckAvailable: boolean;
  lastSeenAt: string | null;
  health: ObservationSurfaceHealth;
  coverageStatus: CoverageStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureGap {
  gapId: string;
  userId: string;
  observationSurfaceId: string;
  detectedAt: string;
  affectedFrom: string | null;
  affectedTo: string | null;
  affectedScope: string | null;
  reason: string;
  detectionMethod: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  status: CaptureGapStatus;
  resolvedAt: string | null;
  evidenceRef: string | null;
  provenance: Record<string, unknown>;
}

export interface RegisterObservationSurfaceInput {
  userId: string;
  source: string;
  provider: ExecutionProvider;
  observationMode: ObservationMode;
  connectionRef?: string | null;
  scopeRef?: string | null;
  observableCapabilities?: readonly string[];
  identityTransport?: string | null;
  workContextTransport?: string | null;
  permissionPrecheckAvailable?: boolean;
  health?: ObservationSurfaceHealth;
  coverageStatus?: CoverageStatus;
}

export interface RecordSurfaceHealthObservationInput {
  surfaceId: string;
  userId: string;
  seenAt: string;
  health: ObservationSurfaceHealth;
  coverageStatus: CoverageStatus;
}

export interface AppendCaptureGapInput {
  userId: string;
  observationSurfaceId: string;
  detectedAt: string;
  affectedFrom?: string | null;
  affectedTo?: string | null;
  affectedScope?: string | null;
  reason: string;
  detectionMethod: string;
  confidence: CaptureGap["confidence"];
  status: Exclude<CaptureGapStatus, "RESOLVED">;
  evidenceRef?: string | null;
  provenance?: Record<string, unknown>;
}

export interface ResolveCaptureGapInput {
  gapId: string;
  userId: string;
  resolvedAt: string;
}
