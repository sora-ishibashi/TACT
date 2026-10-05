// =========================
// TACT Runs — Coverage / Connection Management Projection Tests (SOR-187)
// =========================
//
// 対象: core/tact-runs-view/coverageManagement.ts の純粋変換関数群。
// DBアクセスを持たないため、fixture(ObservationSurface / CaptureGap /
// PublicConnection)を直接組み立てて各関数へ渡すだけで検証できる。

import {
  buildCoverageServiceDetails,
  classifyObservationCoverage,
  resolveConnectionForSurface,
  type PublicConnection,
} from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { CaptureGap, ObservationSurface } from "@tact/runs-core/tact-execution/coverage/types";
import { check, summarize, type CheckResult } from "../lib/check";

function baseSurface(overrides: Partial<ObservationSurface> = {}): ObservationSurface {
  return {
    surfaceId: "surface-1",
    userId: "user-1",
    source: "Notion MCP",
    provider: "notion",
    observationMode: "INSTRUMENTED",
    connectionRef: null,
    scopeRef: null,
    observableCapabilities: [],
    identityTransport: null,
    workContextTransport: null,
    permissionPrecheckAvailable: false,
    lastSeenAt: "2026-09-24T00:00:00.000Z",
    health: "HEALTHY",
    coverageStatus: "COVERED",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

function baseGap(overrides: Partial<CaptureGap> = {}): CaptureGap {
  return {
    gapId: "gap-1",
    userId: "user-1",
    observationSurfaceId: "surface-1",
    detectedAt: "2026-09-24T00:00:00.000Z",
    affectedFrom: null,
    affectedTo: null,
    affectedScope: null,
    reason: "webhook_delivery_failure",
    detectionMethod: "heartbeat",
    confidence: "MEDIUM",
    status: "GAP_DETECTED",
    resolvedAt: null,
    evidenceRef: null,
    provenance: {},
    ...overrides,
  };
}

function baseConnection(overrides: Partial<PublicConnection> = {}): PublicConnection {
  return {
    id: "connection-1",
    service: "notion",
    status: "active",
    provider: "composio",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // HEALTHY + COVERED + no gap -> 正常
  // =========================
  results.push(check(
    "[SOR-187] HEALTHY + COVERED + no active gap classifies as HEALTHY (正常)",
    classifyObservationCoverage({ health: "HEALTHY", coverageStatus: "COVERED" }, false) === "HEALTHY"
  ));

  // =========================
  // PARTIAL -> 一部観測不可
  // =========================
  results.push(check(
    "[SOR-187] coverageStatus=PARTIAL classifies as PARTIAL (一部観測不可)",
    classifyObservationCoverage({ health: "HEALTHY", coverageStatus: "PARTIAL" }, false) === "PARTIAL"
  ));
  results.push(check(
    "[SOR-187] health=DEGRADED also classifies as PARTIAL",
    classifyObservationCoverage({ health: "DEGRADED", coverageStatus: "COVERED" }, false) === "PARTIAL"
  ));

  // =========================
  // OUTAGE -> 停止・異常
  // =========================
  results.push(check(
    "[SOR-187] health=OUTAGE classifies as OUTAGE (停止・異常), outranking PARTIAL signals",
    classifyObservationCoverage({ health: "OUTAGE", coverageStatus: "PARTIAL" }, true) === "OUTAGE"
  ));
  results.push(check(
    "[SOR-187] coverageStatus=OUTAGE also classifies as OUTAGE",
    classifyObservationCoverage({ health: "HEALTHY", coverageStatus: "OUTAGE" }, false) === "OUTAGE"
  ));

  // =========================
  // UNKNOWN -> 不明
  // =========================
  results.push(check(
    "[SOR-187] health=UNKNOWN classifies as UNKNOWN (不明)",
    classifyObservationCoverage({ health: "UNKNOWN", coverageStatus: "COVERED" }, false) === "UNKNOWN"
  ));
  results.push(check(
    "[SOR-187] coverageStatus=UNKNOWN classifies as UNKNOWN",
    classifyObservationCoverage({ health: "HEALTHY", coverageStatus: "UNKNOWN" }, false) === "UNKNOWN"
  ));

  // =========================
  // active gapありを正常にしない
  // =========================
  results.push(check(
    "[SOR-187] an active (non-RESOLVED) gap prevents HEALTHY even when health/coverage are otherwise clean",
    classifyObservationCoverage({ health: "HEALTHY", coverageStatus: "COVERED" }, true) === "PARTIAL"
  ));

  {
    const surface = baseSurface();
    const activeGap = baseGap({ status: "GAP_DETECTED" });
    const details = buildCoverageServiceDetails({ surfaces: [surface], gaps: [activeGap], connectionReadState: "unavailable", connections: [] });
    results.push(check(
      "[SOR-187] buildCoverageServiceDetails never reports HEALTHY while an active gap exists for that surface",
      details[0].classification !== "HEALTHY" && details[0].activeGap !== null
    ));
  }

  // =========================
  // resolved gapのみならcanonical health/coverageへ従う
  // =========================
  {
    const surface = baseSurface();
    const resolvedGap = baseGap({ status: "RESOLVED", resolvedAt: "2026-09-25T00:00:00.000Z" });
    const details = buildCoverageServiceDetails({ surfaces: [surface], gaps: [resolvedGap], connectionReadState: "unavailable", connections: [] });
    results.push(check(
      "[SOR-187] a RESOLVED-only gap history does not block HEALTHY; canonical health/coverageStatus decide",
      details[0].classification === "HEALTHY" && details[0].activeGap === null && details[0].gaps.length === 1 && details[0].gaps[0].isActive === false
    ));
  }

  // =========================
  // connectionRef exact matchだけjoin
  // =========================
  {
    const surface = baseSurface({ connectionRef: "connection-1" });
    const connection = baseConnection({ id: "connection-1" });
    const resolved = resolveConnectionForSurface(surface, [connection]);
    results.push(check(
      "[SOR-187] connectionRef === Connection.id joins successfully",
      resolved !== null && resolved.id === "connection-1"
    ));
  }

  // =========================
  // providerだけ一致ではjoinしない
  // =========================
  {
    const surface = baseSurface({ connectionRef: "connection-does-not-exist", provider: "notion" });
    const connection = baseConnection({ id: "connection-1", service: "notion" }); // same provider/service, different id
    const resolved = resolveConnectionForSurface(surface, [connection]);
    results.push(check(
      "[SOR-187] matching provider/service alone never joins a Connection — only an exact connectionRef===id match does",
      resolved === null
    ));
  }

  {
    const surface = baseSurface({ connectionRef: null });
    const connection = baseConnection({ id: "connection-1" });
    const details = buildCoverageServiceDetails({ surfaces: [surface], gaps: [], connectionReadState: "available", connections: [connection] });
    results.push(check(
      "[SOR-187] with connectionReadState=available, a surface with no connectionRef renders as join-unavailable, never guessed",
      details[0].connection.joined === false &&
      details[0].connection.readState === "available" &&
      details[0].connection.unavailableMessage === "接続との紐づきを確認できません"
    ));
  }

  // =========================
  // connectionReadState: read capability自体が無い(unavailable)場合、
  // join failureのmessageとは別の文言になり、joinそのものを試みない
  // (connections配列にconnectionRefと一致する行があっても無視する)。
  // =========================
  {
    const surface = baseSurface({ connectionRef: "connection-1" });
    const connection = baseConnection({ id: "connection-1" });
    const details = buildCoverageServiceDetails({ surfaces: [surface], gaps: [], connectionReadState: "unavailable", connections: [connection] });
    results.push(check(
      "[SOR-187] connectionReadState=unavailable never attempts the join, even with a matching connectionRef present",
      details[0].connection.joined === false &&
      details[0].connection.readState === "unavailable" &&
      details[0].connection.unavailableMessage === "接続情報は現在利用できません"
    ));
  }

  // =========================
  // connections: [] 単体を「0件」と解釈しない — read-unavailableと
  // join-unavailableは別のmessageになることを明示的に区別する。
  // =========================
  {
    const surface = baseSurface({ connectionRef: "connection-does-not-exist" });
    const unavailableDetails = buildCoverageServiceDetails({ surfaces: [surface], gaps: [], connectionReadState: "unavailable", connections: [] });
    const availableDetails = buildCoverageServiceDetails({ surfaces: [surface], gaps: [], connectionReadState: "available", connections: [] });
    results.push(check(
      "[SOR-187] an empty connections array means two different things depending on connectionReadState, and the UI message reflects which",
      unavailableDetails[0].connection.unavailableMessage !== availableDetails[0].connection.unavailableMessage &&
      unavailableDetails[0].connection.unavailableMessage === "接続情報は現在利用できません" &&
      availableDetails[0].connection.unavailableMessage === "接続との紐づきを確認できません"
    ));
  }

  // =========================
  // connectionRef exact matchだけjoin(connectionReadState=available時)
  // =========================
  {
    const surface = baseSurface({ connectionRef: "connection-1" });
    const connection = baseConnection({ id: "connection-1" });
    const details = buildCoverageServiceDetails({ surfaces: [surface], gaps: [], connectionReadState: "available", connections: [connection] });
    results.push(check(
      "[SOR-187] connectionReadState=available with an exact connectionRef===id match joins successfully",
      details[0].connection.joined === true &&
      details[0].connection.service === "notion" &&
      details[0].connection.unavailableMessage === null
    ));
  }

  return summarize("runsView/coverageManagementProjection", results);

}
