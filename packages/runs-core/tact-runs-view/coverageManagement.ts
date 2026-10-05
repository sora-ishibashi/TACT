// =========================
// TACT Runs — Connection / Observation Coverage Management Projection (SOR-187)
// =========================
//
// Pure, DB-free transform (same discipline as permissionManagement.ts in
// this directory). Reads ObservationSurface/CaptureGap (coverage/types.ts)
// as-is — it never adds a new domain enum, never re-defines HEALTHY/
// COVERED/OUTAGE/etc, and never infers "healthy" beyond what
// classifyObservationCoverage() below makes explicit.
//
// Connection (SOR-187 scope note, refined by SOR-187 review): the
// standalone products/yolna-runs application has no reachable Connection
// data source today — Yolna's core/tact-integration/connection.ts (and its
// tact_connections table) is outside products/yolna-runs' import/DB
// boundary (see scripts/verify/standaloneForbiddenImports.ts and the
// "Cross-product FK removal" comment in
// products/yolna-runs/supabase/migrations/20270101000003_...sql — there is
// no FK, and nothing in Runs Core resolves Connection details). Per Human
// Owner direction (SOR-187 implementation), this file still defines the
// join/label contract against a minimal, independently-declared
// PublicConnection shape (same small-vocabulary-per-module convention as
// downstreamPermission/types.ts) so the UI and this module are ready for a
// real Connection projection later (SOR-212's responsibility — this file
// never imports core/tact-integration and never gains real Connection data
// of its own).
//
// Absolute condition (SOR-187 review): a caller passing `connections: []`
// is NOT, by itself, "zero Connections exist". It could equally mean "the
// read capability for Connections does not exist in this deployment at
// all" — and those are two different facts a consumer must be able to
// tell apart. `connectionReadState` is the explicit, projection-level
// (not a new domain enum) signal for that distinction:
//   - "unavailable": there is no Connection read capability at all (today,
//     always this — see above). The join is never attempted; every
//     surface's connection view carries CONNECTION_READ_UNAVAILABLE_MESSAGE
//     ("接続情報は現在利用できません"), regardless of connectionRef or the
//     (always-empty) connections array.
//   - "available": a real read capability exists (future SOR-212) and
//     `connections` reflects its actual result (possibly legitimately
//     empty). Only then does resolveConnectionForSurface()'s exact-id join
//     run; a surface whose connectionRef doesn't resolve gets
//     CONNECTION_JOIN_UNAVAILABLE_MESSAGE ("接続との紐づきを確認できません")
//     instead — a different fact (join failed) from read-unavailable
//     (nothing to join against in the first place).

import type {
  CaptureGap,
  CaptureGapStatus,
  CoverageStatus,
  ObservationMode,
  ObservationSurface,
  ObservationSurfaceHealth,
} from "../tact-execution/coverage/types";
import type { ExecutionProvider } from "../tact-execution/types";
import { targetSystemLabel } from "./index";

// =========================
// Connection (minimal, independently-declared — see header comment)
// =========================

export type PublicConnectionStatus = "pending" | "active" | "failed" | "revoked";

// projection-level state only (not a tact_execution_coverage domain enum):
// whether this deployment has any Connection read capability at all. See
// the header comment above for why this must stay distinct from "the
// connections array happens to be empty".
export type ConnectionReadState = "available" | "unavailable";

export interface PublicConnection {
  id: string;
  service: string;
  status: PublicConnectionStatus;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

export function connectionStatusJapanese(status: PublicConnectionStatus): string {
  switch (status) {
    case "pending": return "接続待ち";
    case "active": return "接続済み";
    case "failed": return "接続エラー";
    case "revoked": return "無効";
  }
}

// 絶対条件(SOR-187指示): ObservationSurface.connectionRef と
// Connection.idが完全一致する場合のみ紐付ける。provider/service名だけの
// 一致でjoinしない——一致しなければnull(呼び出し元が「接続との紐づきを
// 確認できません」を表示する)。
export function resolveConnectionForSurface(
  surface: Pick<ObservationSurface, "connectionRef">,
  connections: readonly PublicConnection[]
): PublicConnection | null {
  if (surface.connectionRef === null) {
    return null;
  }
  return connections.find((connection) => connection.id === surface.connectionRef) ?? null;
}

// =========================
// Observation mode (coverage/types.tsのOBSERVATION_MODESをそのまま使う、
// 新しいenum値は追加しない)
// =========================

export function observationModeJapanese(mode: ObservationMode): string {
  switch (mode) {
    case "INLINE": return "経路内観測";
    case "INSTRUMENTED": return "計測連携";
    case "RECONCILED": return "事後照合";
    case "OTHER": return "その他 / 確認が必要";
  }
}

// =========================
// Coverage classification (SOR-187指示、絶対条件: 「正常」はHEALTHY +
// COVERED + no active gapの場合のみ。severity順: OUTAGE > PARTIAL(DEGRADED/
// PARTIAL/active gap) > UNKNOWN > HEALTHY。新しいdomain enumは追加しない
// ——既存のObservationSurfaceHealth/CoverageStatus 4値のどちらにも無い
// 5番目の状態を作らない。)
// =========================

export type CoverageClassification = "HEALTHY" | "PARTIAL" | "OUTAGE" | "UNKNOWN";

export function classifyObservationCoverage(
  surface: { health: ObservationSurfaceHealth; coverageStatus: CoverageStatus },
  hasActiveGap: boolean
): CoverageClassification {

  if (surface.health === "OUTAGE" || surface.coverageStatus === "OUTAGE") {
    return "OUTAGE";
  }

  if (surface.health === "DEGRADED" || surface.coverageStatus === "PARTIAL" || hasActiveGap) {
    return "PARTIAL";
  }

  if (surface.health === "UNKNOWN" || surface.coverageStatus === "UNKNOWN") {
    return "UNKNOWN";
  }

  return "HEALTHY";

}

export function coverageClassificationJapanese(classification: CoverageClassification): string {
  switch (classification) {
    case "HEALTHY": return "正常";
    case "PARTIAL": return "一部観測不可";
    case "OUTAGE": return "停止・異常";
    case "UNKNOWN": return "不明";
  }
}

// =========================
// Capture Gap view
// =========================

export interface CoverageGapView {
  gapId: string;
  detectedAt: string;
  affectedFrom: string | null;
  affectedTo: string | null;
  affectedScope: string | null;
  reason: string;
  confidence: CaptureGap["confidence"];
  status: CaptureGapStatus;
  resolvedAt: string | null;
  // status !== "RESOLVED" の行だけがtrue。
  isActive: boolean;
}

function toCoverageGapView(gap: CaptureGap): CoverageGapView {
  return {
    gapId: gap.gapId,
    detectedAt: gap.detectedAt,
    affectedFrom: gap.affectedFrom,
    affectedTo: gap.affectedTo,
    affectedScope: gap.affectedScope,
    reason: gap.reason,
    confidence: gap.confidence,
    status: gap.status,
    resolvedAt: gap.resolvedAt,
    isActive: gap.status !== "RESOLVED",
  };
}

// =========================
// Service Detail view
// =========================

export interface CoverageConnectionView {
  joined: boolean;
  // SOR-187 review: この2つは別の事実——connectionReadStateそのものが
  // "unavailable"(read capability自体が無い)な場合と、
  // "available"だがこのsurfaceのconnectionRefがどのConnectionにも
  // 一致しなかった場合(join失敗)を、unavailableMessageの文面で区別する
  // (推測で片方へ丸めない)。
  readState: ConnectionReadState;
  service: string | null;
  provider: string | null;
  statusLabel: string | null;
  // joined===falseの場合のみ非null。
  unavailableMessage: string | null;
}

export interface CoverageServiceDetailView {
  surfaceId: string;
  source: string;
  provider: ExecutionProvider;
  providerLabel: string;
  classification: CoverageClassification;
  classificationLabel: string;
  observationMode: ObservationMode;
  observationModeLabel: string;
  lastSeenAt: string | null;
  observableCapabilities: readonly string[];
  identityTransport: string | null;
  workContextTransport: string | null;
  permissionPrecheckAvailable: boolean;
  connection: CoverageConnectionView;
  gaps: CoverageGapView[];
  activeGap: CoverageGapView | null;
}

// read capability自体が無い(connectionReadState==="unavailable")場合。
const CONNECTION_READ_UNAVAILABLE_MESSAGE = "接続情報は現在利用できません";

// read capabilityはある(connectionReadState==="available")がjoinが
// 一致しなかった場合。CONNECTION_READ_UNAVAILABLE_MESSAGEとは別の事実。
const CONNECTION_JOIN_UNAVAILABLE_MESSAGE = "接続との紐づきを確認できません";

function toConnectionView(
  connectionReadState: ConnectionReadState,
  connection: PublicConnection | null
): CoverageConnectionView {

  if (connectionReadState === "unavailable") {
    return { joined: false, readState: "unavailable", service: null, provider: null, statusLabel: null, unavailableMessage: CONNECTION_READ_UNAVAILABLE_MESSAGE };
  }

  if (!connection) {
    return { joined: false, readState: "available", service: null, provider: null, statusLabel: null, unavailableMessage: CONNECTION_JOIN_UNAVAILABLE_MESSAGE };
  }

  return {
    joined: true,
    readState: "available",
    service: connection.service,
    provider: connection.provider,
    statusLabel: connectionStatusJapanese(connection.status),
    unavailableMessage: null,
  };

}

export interface BuildCoverageManagementViewInput {
  surfaces: readonly ObservationSurface[];
  gaps: readonly CaptureGap[];
  connectionReadState: ConnectionReadState;
  connections: readonly PublicConnection[];
}

export function buildCoverageServiceDetails(
  input: BuildCoverageManagementViewInput
): CoverageServiceDetailView[] {

  const details = input.surfaces.map((surface) => {

    const surfaceGaps = input.gaps
      .filter((gap) => gap.observationSurfaceId === surface.surfaceId)
      .map(toCoverageGapView);

    const activeGap = surfaceGaps.find((gap) => gap.isActive) ?? null;
    const classification = classifyObservationCoverage(surface, activeGap !== null);

    // 絶対条件(SOR-187 review): connectionReadState==="unavailable"の
    // 場合、joinそのものを一切試みない(呼び出すとjoinを試みたかのような
    // 誤った印象を残しうる、resolveConnectionForSurface()はread
    // capabilityが実在する時だけ呼ぶ)。
    const resolvedConnection = input.connectionReadState === "available"
      ? resolveConnectionForSurface(surface, input.connections)
      : null;

    return {
      surfaceId: surface.surfaceId,
      source: surface.source,
      provider: surface.provider,
      providerLabel: targetSystemLabel(surface.provider, null, null).label,
      classification,
      classificationLabel: coverageClassificationJapanese(classification),
      observationMode: surface.observationMode,
      observationModeLabel: observationModeJapanese(surface.observationMode),
      lastSeenAt: surface.lastSeenAt,
      observableCapabilities: surface.observableCapabilities,
      identityTransport: surface.identityTransport,
      workContextTransport: surface.workContextTransport,
      permissionPrecheckAvailable: surface.permissionPrecheckAvailable,
      connection: toConnectionView(input.connectionReadState, resolvedConnection),
      gaps: surfaceGaps,
      activeGap,
    };

  });

  return details.sort((a, b) => a.source.localeCompare(b.source));

}

// =========================
// Sidebar filter helpers (permissionManagement.tsと同じ精神: filter判定・
// count導出はReact側に置かず、ここへ集約する)
// =========================

export interface CoverageFilterOption {
  id: string;
  label: string;
  count: number;
}

export function summarizeCoverageByClassification(
  details: readonly CoverageServiceDetailView[]
): CoverageFilterOption[] {
  const order: CoverageClassification[] = ["HEALTHY", "PARTIAL", "OUTAGE", "UNKNOWN"];
  return order.map((classification) => ({
    id: classification,
    label: coverageClassificationJapanese(classification),
    count: details.filter((detail) => detail.classification === classification).length,
  }));
}

export function summarizeCoverageByProvider(
  details: readonly CoverageServiceDetailView[]
): CoverageFilterOption[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const detail of details) {
    const entry = counts.get(detail.provider);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(detail.provider, { label: detail.providerLabel, count: 1 });
    }
  }
  return [...counts.entries()].map(([id, { label, count }]) => ({ id, label, count }));
}

export interface CoverageFilters {
  search?: string;
  classification?: CoverageClassification;
  provider?: ExecutionProvider;
}

export function filterCoverageServiceDetails(
  details: readonly CoverageServiceDetailView[],
  filters: CoverageFilters
): CoverageServiceDetailView[] {

  const search = filters.search?.trim().toLocaleLowerCase();

  return details.filter((detail) => {

    if (filters.classification && detail.classification !== filters.classification) return false;
    if (filters.provider && detail.provider !== filters.provider) return false;

    if (search) {
      const haystack = `${detail.source} ${detail.providerLabel}`.toLocaleLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;

  });

}
