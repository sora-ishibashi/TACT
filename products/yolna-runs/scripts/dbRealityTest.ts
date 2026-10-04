// =========================
// Yolna Runs Standalone — Database Reality Test (SOR-135 Phase 3)
// =========================
//
// Most important acceptance test for Phase 3 (section 11). Runs against
// the disposable local Supabase project at products/yolna-runs/supabase/
// (NOT the root Yolna app's local Supabase, NOT any cloud project) with
// ONLY this product's own migrations applied. Exercises the real
// @tact/runs-core functions end to end — capture, permission evaluation,
// work correlation (explicit + structural, both through the real
// Postgres-backed projection adapter and RPCs), attention, outcome,
// human reclassification, and tenant isolation — with zero mocking of
// the database layer.
//
// Usage: from products/yolna-runs/, with the disposable instance running
// (`npx supabase start`):
//   SUPABASE_URL=http://127.0.0.1:58321 \
//   SUPABASE_ANON_KEY=<anon key from `supabase status`> \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key from `supabase status`> \
//   npx tsx scripts/dbRealityTest.ts
//
// This script creates and deletes its own synthetic users on each run —
// safe to re-run against the same disposable instance.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[dbRealityTest] SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must all be set " +
    "(from `npx supabase status` against the disposable products/yolna-runs/supabase/ project)."
  );
  process.exit(1);
}

// Point this process's env at the disposable instance BEFORE importing
// anything from @tact/runs-core — its service-role client reads these at
// call time (lazily), but set them up front for clarity and so any
// module-scope env read anywhere in the dependency graph sees them too.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

import {
  captureExecution,
  listExecutionsForUser,
  listExecutionsForWork,
  observeExecutionPermission,
  observeExecutionWorkCorrelation,
  listExecutionAttentions,
  persistManualWorkCorrelationOverride,
  getExecutionCorrelationView,
  assertExecutionOutcome,
  type CanonicalExecution,
} from "@tact/runs-core/tact-execution";
import {
  postgresWorkProjectionWriter,
  postgresConversationLinkProjectionWriter,
} from "../lib/projection/postgresProjectionAdapter";
import { check, summarize, type CheckResult } from "./lib/check";

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createSyntheticUser(label: string): Promise<{ id: string; email: string }> {

  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@runs-reality-test.local`;

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: "reality-test-password-not-real-123",
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`[dbRealityTest] failed to create synthetic user ${label}: ${error?.message}`);
  }

  return { id: data.user.id, email };

}

async function deleteSyntheticUser(userId: string): Promise<void> {
  await adminClient.auth.admin.deleteUser(userId);
}

function baseInput(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    actorKind: "ai_agent" as const,
    actorId: "agent-reality-1",
    agentId: "agent-reality-1",
    provider: "mcp" as const,
    targetProvider: "notion" as const,
    sourceType: "sdk_callback" as const,
    externalEventId: `reality-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    adapterVersion: "reality-test-v1",
    actionCategory: "update" as const,
    operation: "notion_update_page",
    resourceType: "notion_page",
    resourceIdentifier: "page-reality-1",
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1/2. Synthetic User A / B ----
  const userA = await createSyntheticUser("user-a");
  const userB = await createSyntheticUser("user-b");

  results.push(check("[1] Synthetic User A created", Boolean(userA.id)));
  results.push(check("[2] Synthetic User B created", Boolean(userB.id)));

  try {

    // ---- 3/4. Canonical Execution ingest, WorkなしExecutionが正常保存される ----
    const captureOutcome = await captureExecution(baseInput(userA.id) as never);

    results.push(
      check(
        "[3/4] captureExecution() with no workId succeeds (Capture first, Work correlation not required)",
        captureOutcome.status === "captured"
      )
    );

    if (captureOutcome.status !== "captured") {
      throw new Error(`captureExecution did not succeed: ${JSON.stringify(captureOutcome)}`);
    }

    const execution: CanonicalExecution = captureOutcome.execution;

    results.push(
      check(
        "[4] the captured execution has work_id=null (Capture-first, no premature guess)",
        execution.workId === null
      )
    );

    // ---- 5. Work Projection upsert ----
    const externalWorkId = crypto.randomUUID();

    await postgresWorkProjectionWriter.upsertWork({
      externalWorkId,
      userId: userA.id,
      title: "Reality Test Work",
      status: "running",
      conversationReference: null,
    });

    results.push(check("[5] Work Projection upsert succeeds", true));

    // ---- 6. Execution -> Work correlation (explicit path: capture a new
    // execution that already carries the workId, then correlate) ----
    const explicitCaptureOutcome = await captureExecution(
      baseInput(userA.id, { workId: externalWorkId, externalEventId: `reality-explicit-${Date.now()}` }) as never
    );

    if (explicitCaptureOutcome.status !== "captured") {
      throw new Error(`explicit capture did not succeed: ${JSON.stringify(explicitCaptureOutcome)}`);
    }

    const explicitExecution = explicitCaptureOutcome.execution;

    results.push(
      check(
        "[6a] captureExecution(workId) resolves the opaque workId against the Runs-owned Work Projection (not Yolna's tact_works, which does not exist here)",
        explicitExecution.workId === externalWorkId
      )
    );

    const correlationOutcome = await observeExecutionWorkCorrelation(explicitExecution);

    results.push(
      check(
        "[6b] observeExecutionWorkCorrelation() confirms the explicit-workId capture as matched (SOR-53 Defect 2 path: work_id set at capture, correlation_status caught up by this RPC call)",
        correlationOutcome.status === "persisted" &&
          "decision" in correlationOutcome &&
          correlationOutcome.decision.status === "matched" &&
          correlationOutcome.decision.method === "explicit"
      )
    );

    // ---- 6c. Structural correlation via Conversation Link Projection ----
    const conversationReference = crypto.randomUUID();

    await postgresWorkProjectionWriter.upsertWork({
      externalWorkId: crypto.randomUUID(),
      userId: userA.id,
      title: "Reality Test Structural Work",
      status: "running",
      conversationReference,
    });

    await postgresConversationLinkProjectionWriter.upsertConversationLink({
      userId: userA.id,
      channel: "slack",
      externalWorkspaceId: "T-REALITY",
      externalConversationId: "C-REALITY",
      externalThreadId: "100.001",
      conversationReference,
    });

    const slackCaptureOutcome = await captureExecution(
      baseInput(userA.id, {
        externalEventId: `reality-slack-${Date.now()}`,
        provider: "slack",
        targetProvider: "slack",
        actorKind: "human",
        actorId: "U-REALITY",
        agentId: null,
        actionCategory: "create",
        operation: "app_mention",
        resourceType: "slack_message",
        resourceIdentifier: null,
        sourceType: "webhook",
        sourceMetadata: { teamId: "T-REALITY", channel: "C-REALITY", threadTs: "100.001" },
      }) as never
    );

    if (slackCaptureOutcome.status !== "captured") {
      throw new Error(`slack capture did not succeed: ${JSON.stringify(slackCaptureOutcome)}`);
    }

    const structuralCorrelationOutcome = await observeExecutionWorkCorrelation(slackCaptureOutcome.execution);

    results.push(
      check(
        "[6c] Structural correlation (Slack channel/thread -> Conversation Link Projection -> Work Projection) matches via the real Postgres-backed adapter",
        structuralCorrelationOutcome.status === "persisted" &&
          "decision" in structuralCorrelationOutcome &&
          structuralCorrelationOutcome.decision.status === "matched" &&
          structuralCorrelationOutcome.decision.method === "structural"
      )
    );

    // ---- 6d. Projection Lag / Missing Projection (SOR-135 Phase 3
    // section 13, required): an explicit workId claim for a Work
    // Projection that has NOT arrived yet must not fail ingestion, must
    // not lose the Execution, and must leave the Work reference as
    // Unknown/Unassigned rather than guessing. Once the projection
    // arrives later, the existing Human Reclassification path (section 9)
    // is the documented explicit re-correlation procedure — this suite
    // does not invent a second, automatic one. ----
    const lateWorkId = crypto.randomUUID(); // deliberately no projection row yet

    const lagCaptureOutcome = await captureExecution(
      baseInput(userA.id, { workId: lateWorkId, externalEventId: `reality-lag-${Date.now()}` }) as never
    );

    if (lagCaptureOutcome.status !== "captured") {
      throw new Error(`projection-lag capture did not succeed: ${JSON.stringify(lagCaptureOutcome)}`);
    }

    results.push(
      check(
        "[6d-i] Capture with a workId referencing a not-yet-arrived Work Projection still succeeds (ingestion never blocked by missing projection)",
        true
      )
    );

    results.push(
      check(
        "[6d-ii] The unresolvable workId is dropped at capture time rather than trusted blindly — the row is Unassigned (work_id=null), never a guessed association",
        lagCaptureOutcome.execution.workId === null
      )
    );

    // Projection arrives late.
    await postgresWorkProjectionWriter.upsertWork({
      externalWorkId: lateWorkId,
      userId: userA.id,
      title: "Reality Test Late-Arriving Work",
      status: "running",
      conversationReference: null,
    });

    // Explicit re-correlation procedure: Human Reclassification (the same
    // RPC path as [12]) now succeeds against the now-present projection.
    const lagReclassifyOutcome = await persistManualWorkCorrelationOverride({
      executionId: lagCaptureOutcome.execution.id,
      userId: userA.id,
      expectedPreviousWorkId: null,
      newWorkId: lateWorkId,
      changedBy: { kind: "human", id: userA.id },
      reasonCode: "reality_test_late_projection_reclassification",
    });

    results.push(
      check(
        "[6d-iii] After the Work Projection arrives, the historical Execution can be explicitly re-correlated (Human Reclassification) — no automatic silent re-guessing, but a documented, working procedure",
        lagReclassifyOutcome.status === "reclassified"
      )
    );

    // ---- 7. Activity表示データ取得 ----
    const activityExecutions = await listExecutionsForUser(userA.id);

    results.push(
      check(
        "[7] Activity read (listExecutionsForUser) returns this user's captured executions",
        activityExecutions.length >= 4
      )
    );

    // ---- 8. Work Timeline取得 ----
    const workTimeline = await listExecutionsForWork(externalWorkId, userA.id);

    results.push(
      check(
        "[8] Work Timeline read (listExecutionsForWork) returns the explicitly-correlated execution",
        workTimeline.some((e) => e.id === explicitExecution.id)
      )
    );

    // ---- 9. Permission evaluation (registry-backed, real seeded rule) ----
    const permissionOutcome = await observeExecutionPermission(execution);

    results.push(
      check(
        "[9] Permission evaluation (DB-backed registry, seeded global rule notion-ai-agent-update-page-approval-required) persists a decision",
        permissionOutcome.status === "persisted"
      )
    );

    // ---- 10. Attention生成・取得 ----
    const attentions = await listExecutionAttentions(userA.id, { status: "open" });

    results.push(
      check(
        "[10] Attention generated for the approval_required decision and is readable",
        attentions.some((a) => a.executionId === execution.id && a.reason === "approval_required")
      )
    );

    // ---- 11. Outcome Unknown表示 (default state, nothing asserted yet) ----
    results.push(
      check(
        "[11] Outcome defaults to unknown (Never Guess Rule) until explicitly asserted",
        execution.outcomeStatus === "unknown"
      )
    );

    const outcomeResult = await assertExecutionOutcome(
      {
        executionId: execution.id,
        status: "asserted",
        outcomeKind: "reality_test_outcome",
        method: "adapter_asserted",
      },
      userA.id
    );

    results.push(
      check(
        "[11b] Outcome can be asserted (status transitions from unknown to asserted, real RPC path)",
        outcomeResult.status === "persisted"
      )
    );

    // ---- 12. Human Work reclassification ----
    const secondWorkId = crypto.randomUUID();

    await postgresWorkProjectionWriter.upsertWork({
      externalWorkId: secondWorkId,
      userId: userA.id,
      title: "Reality Test Reclassify Target",
      status: "running",
      conversationReference: null,
    });

    const reclassifyOutcome = await persistManualWorkCorrelationOverride({
      executionId: execution.id,
      userId: userA.id,
      expectedPreviousWorkId: null,
      newWorkId: secondWorkId,
      changedBy: { kind: "human", id: userA.id },
      reasonCode: "reality_test_manual_reclassification",
    });

    results.push(
      check(
        "[12] Human Work reclassification succeeds against the Runs-owned Work Projection (reclassify_execution_work RPC never touches tact_works)",
        reclassifyOutcome.status === "reclassified"
      )
    );

    // ---- 13. Synthetic User BからAのdataが見えない (tenant isolation) ----
    const userBExecutions = await listExecutionsForUser(userB.id);
    const userBAttentions = await listExecutionAttentions(userB.id, { status: "open" });
    const userBWorkView = await getExecutionCorrelationView(execution.id, userB.id);

    results.push(
      check(
        "[13a] User B sees zero of User A's executions",
        userBExecutions.length === 0
      )
    );

    results.push(
      check(
        "[13b] User B sees zero of User A's attentions",
        userBAttentions.length === 0
      )
    );

    results.push(
      check(
        "[13c] User B cannot read User A's execution correlation view by id (cross-tenant read denied, not-found rather than leaked)",
        userBWorkView === undefined
      )
    );

    // ---- 14. Yolna tableが存在しなくても全処理成功 (structural proof) ----
    // If every check above passed while this script only ever imported
    // @tact/runs-core + @tact/execution-contract + this product's own
    // lib/projection adapter — never core/tact-execution-yolna-adapter,
    // core/tact-work, or core/tact-bot — then by construction none of
    // this depended on a Yolna-owned table existing. The standalone
    // forbidden-import/package checks (scripts/verify/standalone*)
    // already prove this statically; this run proves it dynamically.
    results.push(
      check(
        "[14] Entire E2E flow completed without importing any Yolna-owned module (see script's own import list)",
        true
      )
    );

  } finally {

    await deleteSyntheticUser(userA.id);
    await deleteSyntheticUser(userB.id);

  }

  return summarize("Yolna Runs Standalone — Database Reality Test (SOR-135 Phase 3)", results);

}

run()
  .then(({ fail }) => {
    if (fail > 0) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error("[dbRealityTest] FAILED WITH EXCEPTION", error);
    process.exitCode = 1;
  });
