import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { ExecutionProvider } from "../types";
import { type AppendCaptureGapInput, type CaptureGap, type CoverageStatus, type ObservationMode, type ObservationSurface, type ObservationSurfaceHealth, type RecordSurfaceHealthObservationInput, type RegisterObservationSurfaceInput, type ResolveCaptureGapInput } from "./types";

type Client = NonNullable<ReturnType<typeof getServiceRoleClient>>;
export interface CoverageStoreDeps { getClient: () => Client | null; }
const defaultDeps: CoverageStoreDeps = { getClient: getServiceRoleClient };

interface SurfaceRow {
  id: string; user_id: string; source: string; provider: ExecutionProvider; observation_mode: ObservationMode; connection_ref: string | null; scope_ref: string | null; observable_capabilities: string[]; identity_transport: string | null; work_context_transport: string | null; permission_precheck_available: boolean; last_seen_at: string | null; health: ObservationSurfaceHealth; coverage_status: CoverageStatus; created_at: string; updated_at: string;
}
interface GapRow {
  id: string; user_id: string; observation_surface_id: string; detected_at: string; affected_from: string | null; affected_to: string | null; affected_scope: string | null; reason: string; detection_method: string; confidence: CaptureGap["confidence"]; status: CaptureGap["status"]; resolved_at: string | null; evidence_ref: string | null; provenance: Record<string, unknown>;
}
const SURFACE_COLUMNS = "id, user_id, source, provider, observation_mode, connection_ref, scope_ref, observable_capabilities, identity_transport, work_context_transport, permission_precheck_available, last_seen_at, health, coverage_status, created_at, updated_at";
const GAP_COLUMNS = "id, user_id, observation_surface_id, detected_at, affected_from, affected_to, affected_scope, reason, detection_method, confidence, status, resolved_at, evidence_ref, provenance";
const toSurface = (row: SurfaceRow): ObservationSurface => ({ surfaceId: row.id, userId: row.user_id, source: row.source, provider: row.provider, observationMode: row.observation_mode, connectionRef: row.connection_ref, scopeRef: row.scope_ref, observableCapabilities: row.observable_capabilities, identityTransport: row.identity_transport, workContextTransport: row.work_context_transport, permissionPrecheckAvailable: row.permission_precheck_available, lastSeenAt: row.last_seen_at, health: row.health, coverageStatus: row.coverage_status, createdAt: row.created_at, updatedAt: row.updated_at });
const toGap = (row: GapRow): CaptureGap => ({ gapId: row.id, userId: row.user_id, observationSurfaceId: row.observation_surface_id, detectedAt: row.detected_at, affectedFrom: row.affected_from, affectedTo: row.affected_to, affectedScope: row.affected_scope, reason: row.reason, detectionMethod: row.detection_method, confidence: row.confidence, status: row.status, resolvedAt: row.resolved_at, evidenceRef: row.evidence_ref, provenance: row.provenance ?? {} });

export async function registerObservationSurface(input: RegisterObservationSurfaceInput, deps: CoverageStoreDeps = defaultDeps): Promise<ObservationSurface | undefined> {
  const client = deps.getClient(); if (!client) return undefined;
  const { data, error } = await client.from("tact_observation_surfaces").insert({ user_id: input.userId, source: input.source, provider: input.provider, observation_mode: input.observationMode, connection_ref: input.connectionRef ?? null, scope_ref: input.scopeRef ?? null, observable_capabilities: [...(input.observableCapabilities ?? [])], identity_transport: input.identityTransport ?? null, work_context_transport: input.workContextTransport ?? null, permission_precheck_available: input.permissionPrecheckAvailable ?? false, health: input.health ?? "UNKNOWN", coverage_status: input.coverageStatus ?? "UNKNOWN" }).select(SURFACE_COLUMNS).single();
  if (error || !data) return undefined; return toSurface(data as SurfaceRow);
}

export async function recordSurfaceHealthObservation(input: RecordSurfaceHealthObservationInput, deps: CoverageStoreDeps = defaultDeps): Promise<ObservationSurface | undefined> {
  const client = deps.getClient(); if (!client) return undefined;
  const { data, error } = await client.from("tact_observation_surfaces").update({ last_seen_at: input.seenAt, health: input.health, coverage_status: input.coverageStatus, updated_at: input.seenAt }).eq("id", input.surfaceId).eq("user_id", input.userId).select(SURFACE_COLUMNS).maybeSingle();
  if (error || !data) return undefined; return toSurface(data as SurfaceRow);
}

export async function appendCaptureGap(input: AppendCaptureGapInput, deps: CoverageStoreDeps = defaultDeps): Promise<CaptureGap | undefined> {
  const client = deps.getClient(); if (!client) return undefined;
  const { data, error } = await client.from("tact_capture_gaps").insert({ user_id: input.userId, observation_surface_id: input.observationSurfaceId, detected_at: input.detectedAt, affected_from: input.affectedFrom ?? null, affected_to: input.affectedTo ?? null, affected_scope: input.affectedScope ?? null, reason: input.reason, detection_method: input.detectionMethod, confidence: input.confidence, status: input.status, evidence_ref: input.evidenceRef ?? null, provenance: input.provenance ?? {} }).select(GAP_COLUMNS).single();
  if (error || !data) return undefined; return toGap(data as GapRow);
}

export async function resolveCaptureGap(input: ResolveCaptureGapInput, deps: CoverageStoreDeps = defaultDeps): Promise<CaptureGap | undefined> {
  const client = deps.getClient(); if (!client) return undefined;
  const { data, error } = await client.from("tact_capture_gaps").update({ status: "RESOLVED", resolved_at: input.resolvedAt }).eq("id", input.gapId).eq("user_id", input.userId).neq("status", "RESOLVED").select(GAP_COLUMNS).maybeSingle();
  if (error || !data) return undefined; return toGap(data as GapRow);
}

export async function listCurrentObservationSurfaces(userId: string, deps: CoverageStoreDeps = defaultDeps): Promise<ObservationSurface[]> {
  const client = deps.getClient(); if (!client) return [];
  const { data } = await client.from("tact_observation_surfaces").select(SURFACE_COLUMNS).eq("user_id", userId).order("updated_at", { ascending: false });
  return (data ?? []).map((row) => toSurface(row as SurfaceRow));
}

export async function listCaptureGaps(userId: string, deps: CoverageStoreDeps = defaultDeps): Promise<CaptureGap[]> {
  const client = deps.getClient(); if (!client) return [];
  const { data } = await client.from("tact_capture_gaps").select(GAP_COLUMNS).eq("user_id", userId).order("detected_at", { ascending: false });
  return (data ?? []).map((row) => toGap(row as GapRow));
}
