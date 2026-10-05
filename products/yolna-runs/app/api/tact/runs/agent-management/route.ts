import { NextRequest, NextResponse } from "next/server";

import {
  listExecutionsForUser,
  listOwnedPermissionRules,
  listExecutionAttentions,
} from "@tact/runs-core/tact-execution";
import { listWorkTitlesByIdsViaRegistry } from "@tact/runs-core/tact-execution/projection/registry";
import {
  buildAgentManagementInventory,
  buildAgentManagementDetail,
} from "@tact/runs-core/tact-runs-view/agentManagement";
import type { ConnectionReadState, PublicConnection } from "@tact/runs-core/tact-runs-view/coverageManagement";
import type { ConnectionProjectionItem } from "@tact/execution-contract";
import { postgresConnectionProjectionRepository } from "@/lib/projection/postgresConnectionProjectionAdapter";

import { getCurrentUserContext } from "@/core/auth/getUserContext";
// SOR-135 Phase 3 (Standalone Runs): side-effect-only import, same as
// app/api/tact/runs/activity/route.ts — registers this deployment's OWN
// Postgres-backed WorkProjectionRepository so
// listWorkTitlesByIdsViaRegistry() below actually resolves data here.
import "@/lib/projection/postgresProjectionAdapter";

// =========================
// GET /api/tact/runs/agent-management (SOR-186)
// =========================
//
// Observed AI Management — a Work-centric AUXILIARY management view, not
// an Agent fleet console. There is no provider-neutral AI Identity
// Registry in Runs today (SOR-213 is the future owner of that); the only
// canonical identifier available is CanonicalExecution.agentId. This
// route reads exactly the existing, already-established boundaries
// (listExecutionsForUser/listOwnedPermissionRules/listExecutionAttentions/
// listWorkTitlesByIdsViaRegistry/postgresConnectionProjectionRepository —
// SOR-50/47/52/135/212) and hands them to the pure projection
// (core/tact-runs-view/agentManagement.ts) — this route never re-judges
// permission/attention/correlation facts itself.
//
// root core/tact-agent/agentRegistry.ts (Yolna's own Claude Code/Codex
// developer-orchestrator registry) is never imported here — it is not a
// source for this screen (SOR-186 instructions "絶対に使わない正本").
//
// Everything needed to render every agent's detail is returned in one
// response (same "return the full array, select client-side" pattern as
// GET /api/tact/runs/permission-management) — no second round-trip per
// agent selection, and no N+1 DB reads: executions/rules/attentions are
// each read exactly once, already bounded by their own existing limits.

const EXECUTIONS_LIMIT = 200;
const ATTENTIONS_LIMIT = 200;

function toPublicConnection(item: ConnectionProjectionItem): PublicConnection {
  return {
    id: item.externalConnectionId,
    service: item.service,
    status: item.status,
    provider: item.provider,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function GET(request: NextRequest) {

  try {

    const { userId, accessToken } = await getCurrentUserContext(request);

    if (!userId || !accessToken) {
      return NextResponse.json({ success: false, error: "authentication required" }, { status: 401 });
    }

    const [executions, rules, attentions] = await Promise.all([
      listExecutionsForUser(userId, { limit: EXECUTIONS_LIMIT }),
      listOwnedPermissionRules(userId),
      // SOR-18 "Active Inbox" semantics (same as GET /api/tact/runs/
      // attention?status=active): open+acknowledged only — resolved
      // Attentions never reach this screen's default detail.
      listExecutionAttentions(userId, { statuses: ["open", "acknowledged"], limit: ATTENTIONS_LIMIT }),
    ]);

    const items = buildAgentManagementInventory({ executions, rules, attentions });

    // Fail closed, not fail silent (same discipline as GET /api/tact/runs/
    // activity): a Work title projection failure must not be mistaken for
    // "no Work titles exist" — surface it as 503, distinct from the 500
    // catch-all below.
    const workIds = [...new Set(
      executions.map((execution) => execution.workId).filter((id): id is string => id !== null)
    )];

    let workTitles: Map<string, string | null>;

    try {
      workTitles = await listWorkTitlesByIdsViaRegistry(workIds, userId, accessToken);
    } catch (error) {
      console.error("[api/tact/runs/agent-management] Work title projection unavailable", error);
      return NextResponse.json({ success: false, error: "work projection unavailable" }, { status: 503 });
    }

    // A Connection projection read failure must not take down this whole
    // endpoint (same SOR-212/SOR-187 fail-closed discipline as GET
    // /api/tact/runs/coverage) — fail closed to "unavailable", never
    // fabricate "available" or "no Connection exists".
    let connectionReadState: ConnectionReadState = "unavailable";
    let connections: PublicConnection[] = [];

    try {
      const snapshotState = await postgresConnectionProjectionRepository.getSnapshotState(userId);
      if (snapshotState.readState === "available") {
        connectionReadState = "available";
        const projectionItems = await postgresConnectionProjectionRepository.listConnectionsForUser(userId);
        connections = projectionItems.map(toPublicConnection);
      }
    } catch (error) {
      console.error("[api/tact/runs/agent-management] connection projection read failed; reporting unavailable", error);
    }

    const details = items.map((item) =>
      buildAgentManagementDetail({
        agentId: item.agentId,
        executions,
        rules,
        attentions,
        workTitles,
        connectionReadState,
        connections,
      })
    );

    return NextResponse.json({ success: true, items, details });

  } catch (error) {

    console.error("[api/tact/runs/agent-management]", error);

    return NextResponse.json({ success: false, error: "failed to load agent management view" }, { status: 500 });

  }

}
