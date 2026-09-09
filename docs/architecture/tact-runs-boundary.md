# TACT Runs Boundary — ARCH-RUNS-1

Status: design synthesis only, grounded in code actually read this session (`core/tact-work/**`, `core/tact-runtime/**`, `core/tact-integration/**`, `core/tact-conversation/orchestration.ts`, `core/tact-bot/execution/**`, `core/tact-orchestrator/task.ts`, `core/tact-artifact/**`, `supabase/migrations/20260905000000_create_tact_work_tables.sql`, `supabase/migrations/20260912000000_create_tact_audit_events.sql`). No production code was moved, no migration was written, no public API/SDK/Dashboard/billing/auth was created. Where something was not verified directly this session, it is marked **[UNVERIFIED THIS SESSION]**.

Builds directly on, and does not revise, [P2–P5 Final Architecture Synthesis](./p2-p5-final-architecture.md) and [Approval Integrity](./approval-integrity.md). This document assumes P2–P6b (Policy, Approval, Clarification, Audit, RuntimeAdapter, Runtime routing, reconciliation, durable resume, canonical resume execution) are already live, per this session's own prior work.

---

## 1. Purpose

Formally name and separate three responsibility boundaries that already exist *de facto* inside TACT's current code, without moving any of it yet:

- **TACT Core** — decides *what* should happen and *whether it may happen*.
- **TACT Runs** — decides *how an execution attempt is held, tracked, and driven to completion without being lost or duplicated*.
- **Integration Boundary** — decides *how to actually talk to a specific external Runtime/SaaS/Provider*.

TACT Runs is a **design boundary inside TACT**, not a new package, service, or product. TACT itself is Runs' first and largest consumer, and will remain so through many more Fast Port phases before any extraction is considered.

## 2. Non-goals (restated from the brief, binding)

No large code move. No DB table rename. No migration except where Step 18 explicitly allows a minimal, additive, non-behavior-changing type file. No public API, SDK, Developer Dashboard, external auth, or billing. No Trigger.dev-specific or Temporal-specific concept in the Runs canonical contract. No change to TACT's current Production flow. `Conversation` is never treated as `Work`. Runtime is never an Authorization layer. Runs is never a Policy or Approval decision owner. Runs never contains Slack-specific logic, Planner reasoning, or Context Selection. `.env` untouched. `tmp-reference*.png` untouched.

## 3. Current architecture (Step 1 inventory)

Grounded module-by-module. "Owner today" is the literal file/folder; "Ideal boundary" is this document's classification; "Violation" is only listed where the *current* file's own dependencies cross the ideal boundary line, evidenced by an actual `import`.

| Concept | Owner module today | Current responsibility | Ideal boundary | Boundary violation today | Future move candidate |
|---|---|---|---|---|---|
| **Work** | `core/tact-work/types.ts` / `store.ts` (table `tact_works`) | Canonical unit of user-facing intent; `status: created\|planning\|running\|waiting_for_input\|waiting_for_approval\|completed\|failed\|cancelled` | **Core** | None found | Stays in Core permanently |
| **Task (canonical)** | `core/tact-work/types.ts` (`WorkTask`, table `tact_tasks`) | Persisted unit of "what must be done"; `status: pending\|running\|completed\|failed\|cancelled`, `assignedCapability` | **Core**, with a caveat (Section 5) | `status` values conflate business and execution meaning (Section 5) | Stays in Core; only the *execution-phase projection* is a Runs candidate |
| **Task (ephemeral)** | `core/tact-orchestrator/task.ts` (`Task`, in-memory only) | Planner/Executor-internal unit carrying `assignedModel`/`assignedProvider`/`context`/`tableSchema`; never persisted directly | **Core** (Orchestrator is Core) | None — this is Planner-internal state, converted into canonical `WorkTask` by `core/tact-work/execution.ts`'s task creation, and the LLM-specific fields (`assignedModel`/`assignedProvider`/`context`) never leak into the canonical row. Already a clean seam. | N/A |
| **Run** | `core/tact-work/types.ts` (table `tact_runs`) | "One execution attempt": `attempt`, `capability`, `provider`, `status: running\|completed\|failed`, `externalRef`, `result`, `cost` | **Runs** | Table/type physically lives inside the `tact-work` (Core) module | `tact_runs` schema is already Runs-shaped; only its *file location* is a Core-module artifact, not its content |
| **Run creation / lifecycle** | `core/tact-integration/execution.ts` (`prepareRunForExecution`, `executeIntegrationActionCore`) | The *only* place `createRun()`/`completeRun()`/`failRun()` are called | **Runs** | This file also does Policy live recheck and Approval Integrity verification (Core concerns) in the same function body — a 3-way mixing (Section 12) | Runs-shaped logic (attempt numbering, Task pending-gate, externalRef attach) should eventually live behind a Runs contract; Policy/Integrity checks stay in Core and must precede the call |
| **PolicyDecision** | `core/tact-integration/policy.ts` | `evaluatePolicyDecision()`, static allowlist, 4-outcome model | **Core** | Physically lives in the `tact-integration` folder, whose *name* suggests Integration Boundary even though its content is pure Core authorization logic | Folder name is misleading today; no import-direction violation exists (nothing in `policy.ts` touches a provider) |
| **Approval** | `core/tact-work/approval.ts` (table `tact_approvals`) | Human decision to permit a protected write; Approval Integrity (subject hash) | **Core** | None found | Stays in Core permanently |
| **Clarification** | `core/tact-work/clarification.ts` (table `tact_clarifications`) | Human-provided missing input | **Core** | None found | Stays in Core permanently |
| **Resume eligibility / resume request** | `core/tact-work/resume.ts` (P6a) | `evaluateTaskResumeEligibility()` / `requestTaskResume()`, pure read-only judgment | **Core** | None — deliberately imports no Provider/Trigger/createRun API (verified by this session's own tests) | Stays in Core; this is exactly "resume eligibility," listed as a Core responsibility candidate in Section 4 |
| **Canonical resume execution** | `core/tact-conversation/orchestration.ts` (`executePreparedTaskResume`, P6b) | Re-checks eligibility/Policy, then delegates to the existing execution boundary | **Core → Runs contract call site** | Lives in the Conversation composition module rather than a dedicated Core→Runs contract module | Natural Stage-2/3 candidate (Section 13) for consolidation behind a named contract |
| **RuntimeAdapter (contract)** | `core/tact-runtime/types.ts` | `RuntimeAdapter` interface, `RuntimeExecutionRequest/Outcome`, provider-neutral | **Runs / Integration Ports boundary** | None — this file itself imports nothing provider-specific | Already exactly Runs-Contract-shaped; earliest extraction candidate |
| **Trigger.dev Adapter** | `core/tact-runtime/providers/triggerDev.ts` | Concrete `RuntimeAdapter` implementation; sole importer of `@trigger.dev/sdk` | **Integration Boundary** | None — deliberately the only file allowed to import the SDK (its own header comment states this) | Stays in Integration Boundary permanently |
| **Runtime enablement (flag/config resolution)** | `core/tact-runtime/enablement.ts` | The one chokepoint deciding whether Trigger.dev routing is active | **Integration Boundary** (it is the thing that *chooses* a concrete adapter) | Called directly from `core/tact-conversation/orchestration.ts` (Section 12) | Should eventually be called only from behind a Runs-owned dispatch function, not from Conversation |
| **Runtime routing decision** (`executeReadIntegrationActionWithRuntimeRouting`) | `core/tact-conversation/orchestration.ts` | Chooses Runtime-dispatch vs. direct/native execution for reads | **Runs** | Lives in the Conversation module (Section 12, most visible violation) | Natural candidate to move behind a Runs contract call in a later stage |
| **Ambiguous start handling / reconciliation** | `core/tact-runtime/reconciliation.ts`, `reconcileOneShotEntrypoint.ts`, `reconcileOneShotIntegrationReadAsTrustedActor.ts` | "Started, but did the request actually land?" recovery; explicitly never re-executes Provider/creates a new Run | **Runs** | None found — these files already import only `core/tact-work/store.ts` read/attach functions and `core/tact-runtime` types | Already Runs-shaped; a strong template for what "Runs contract behind" code should look like |
| **externalRef** | `Run.externalRef` (jsonb column, `tact_runs`) | Opaque pointer to a Runtime execution (e.g. `{provider:"trigger_dev", executionId}`) | **Runs** (the column) / **Integration** (its content shape) | None | Stays as-is; `toRunExternalRefFields()`/`readRuntimeExecutionHandle()` (`core/tact-runtime/types.ts`) are already the correct seam |
| **Integration execution (write)** | `core/tact-integration/execution.ts` (`executeApprovedIntegrationAction`) | Policy recheck → Approval Integrity → dedup → Run → Provider dispatch, in one function | Core (Policy/Integrity) + **Runs** (Run lifecycle) + **Integration** (Provider dispatch, via `gateway.ts`) | The clearest 3-boundary mixing in the codebase today (Section 12) | Primary Stage-2 candidate: split responsibilities behind a contract without moving files yet |
| **Composio Adapter** | `core/tact-integration/providers/composio/**` | Sole importer of `@composio/core` | **Integration Boundary** | None — deliberately isolated, mirrors the Trigger.dev Adapter's own isolation discipline | Stays in Integration Boundary permanently |
| **Connection** | `core/tact-integration/connection.ts` (table `tact_connections`) | `id/userId/service/status` (Core-visible ownership) + `providerConnectionRef` (opaque) | Split: canonical row = **Core-adjacent/shared reference**, `providerConnectionRef` = **Integration** | None | No move needed; the row already separates the two by column |
| **Artifact** | `core/tact-artifact/**` (table `tact_artifacts`) | Structured deliverable content (`blocks`), optional `workId` link | **Core** | None — contains no Run id, no provider file id, no execution-attempt concept anywhere in `Artifact`/`ArtifactBlock` today | See Section 8 for the future-facing split; nothing to fix now |
| **Cost** | `Run.cost` (jsonb, `LLMCost` shape, `core/llm/types.ts`) | Present only on `Run`; no separate Work-level cost interpretation exists today | **Runs** (raw) / **Core** (interpretation, not yet built) | None — `WorkCostSummary` (`core/tact-work/types.ts`) is declared but **[UNVERIFIED THIS SESSION]** whether any code populates it | See Section 9 |
| **Timestamps** | `Work`: `startedAt/completedAt/failedAt/cancelledAt`. `WorkTask`: only `createdAt/updatedAt` (no started/completed). `Run`: `startedAt/completedAt` | Task itself never records *when it executed* — only Run does | Confirms Run already owns execution timing; Task owns none | None | Nothing to change; this is evidence the boundary is already partially correct by omission |
| **Completion semantics** | `core/tact-work/completion.ts` (`reconcileWorkCompletionStatus`) | "Is every Task terminal, and does that mean Work succeeded/failed?" | **Core** | None — reads `listTasksForWork`/`listApprovalsForWork` only, no Provider/Runtime knowledge | Stays in Core permanently |
| **Failure semantics (business vs. execution)** | Split across `core/tact-integration/execution.ts` (`IntegrationActionExecutionOutcome`) and `core/tact-runtime/types.ts` (`RuntimeError`) | Two separate, non-overlapping vocabularies already exist | Core (`approval_integrity_failed`, `invalid_action`) vs. Runs/Integration (`runtime_unavailable`, `runtime_rejected`) | None — already cleanly separated in practice (Section 9) | Nothing to change |
| **Audit** | `core/tact-work/audit.ts` (table `tact_audit_events`) | Single append-only ledger, `category` discriminator, written by both Core (`approval.*`, `policy.*`) and Runs/Integration-shaped code living in `tact-integration` (`run.*`, `provider.*`) | **Core** (ledger identity, schema, append-only invariant) with Runs/Integration as **event producers** | None structural — this is the intended "single table + discriminating field" design from P4a | Stays in Core; only the *producers* physically living in `tact-integration/execution.ts` are a location artifact, not a design flaw |

## 4. TACT Core — formal responsibilities

Core owns: Work meaning, Task meaning, Capability intent, user intent, completion condition (`reconcileWorkCompletionStatus`), Policy (`evaluatePolicyDecision`), Authorization, Approval (including Approval Integrity), Clarification, Human Interaction semantics generally, task eligibility and resume eligibility (`evaluateTaskResumeEligibility`/`requestTaskResume`), "what to do," "may this happen," and "did this Work complete."

Core deliberately does not know: a Trigger.dev execution id, a Temporal workflow id, provider retry internals, network ambiguity classification, worker lifecycle, queue implementation, or runtime transport details. Confirmed today: no file under `core/tact-work/` imports `@trigger.dev/sdk`, `@composio/core`, or any file under `core/tact-runtime/providers/`.

## 5. TACT Runs — formal responsibilities

Runs owns: Run lifecycle, execution attempt (`attempt` numbering), execution claim (the atomic guarantee behind "exactly one new Run," Section 12 of the ARCH-RUNS-1 brief and already backed by the existing `idx_tact_runs_task_id_attempt` unique index — see the P6b work this session), start, resume execution (the *mechanics* of resuming, not the *decision* to allow it), retry attempt (always a new Run), cancellation **[not yet implemented — no `cancelExecution` exists today]**, timeout **[not yet implemented]**, durable execution state, `externalRef`, reconciliation, ambiguous execution handling, idempotency/duplicate protection, execution timestamps and duration, execution error history, runtime-neutral execution state, execution audit/provenance data, execution cost record (raw), and Artifact execution linkage (Section 8).

Runs never decides: whether an action is dangerous, whether Approval is required, who the approver is, user intent, Context Selection, Planner reasoning, why a particular SaaS was chosen, or the business meaning of Work completion.

**Canonical Task State vs. Canonical Run State (Step 3, the most important finding of this document):**

`WorkTask.status` (`pending|running|completed|failed|cancelled`) is used *both* as a business state and as an execution-attempt signal today, and this session's own reading of the code confirms the overload is real, not hypothetical:

- `"pending"` means *both* "never attempted" *and* "blocked on a pending Approval/Clarification" — `core/tact-work/execution.ts`'s `onTaskFinished()` leaves a Task at `pending` in both cases, and only the presence of a pending Approval/Clarification row (a Core entity) actually distinguishes the two. There is no Task-level signal that says "I am waiting" independent of querying Approval/Clarification.
- `"running"` is set by `prepareRunForExecution()` (`core/tact-integration/execution.ts`) at the *exact same moment* a new `Run` row is created, and is a 1:1 mirror of "a Run is currently in flight" — it carries no additional business meaning beyond that.
- `"completed"`/`"failed"` are set at the *exact same moment* the backing `Run` completes/fails (`executeIntegrationActionCore()`), and, as verified this session, **no code path today resets a `failed` Task back to `pending` to allow a second attempt** — the `attempt`-based retry model exists in the schema (`tact_runs.attempt`) but currently has no live producer that creates a second attempt after a first Integration-execution failure. (Note: `core/tact-orchestrator/executor.ts` has its own, separate, LLM-Capability-level retry loop that is unrelated to this Task/Run model and out of scope here.)

**Resolution for this document (no schema change, per the brief):** the *conceptual* ownership split is: **Canonical Task State (Core)** = "has this unit of work reached a business-final outcome, or is a decision/input still needed" — this is what `reconcileWorkCompletionStatus()` actually consumes. **Canonical Run State (Runs)** = "is an execution attempt currently in flight, and what happened to the most recent one." Today, `WorkTask.status` conflates both roles into one column, and `"running"` in particular is really a *Runs-owned execution-phase projection* being read directly off the Core entity. This document names the distinction explicitly so future work does not assume `WorkTask.status` is purely a Core concept; it recommends (not schema, not now) that a future phase evaluate deriving an *execution-phase view* (e.g., "is there an active Run for this Task") as a computed projection rather than continuing to overload the Task's own persisted status column, once that becomes an actual blocker rather than a documented tension.

## 6. Integration Boundary — formal responsibilities

Integration owns: `RuntimeAdapter` implementations (Trigger.dev today, Temporal or others in the future — this is the extension point, not a commitment), Composio adapter, Pipedream/MCP/other future provider adapters **[none of these exist in code today; named only as future extension points, per the existing `ConnectionProviderKind = "composio"` single-value union]**, native provider calls (`core/tact-integration/gateway.ts` → `executeIntegrationAction()`), provider auth/transport, and provider-specific error normalization (`normalizeTriggerDevError()`, the `IntegrationErrorCode` taxonomy in `core/tact-integration/types.ts`).

## 7. Work / Task / Run ownership (Step 3 resolution, restated)

**Work = Core. Task = Core (with the Section 5 caveat on its `status` column's dual role). Run = Runs (already correctly shaped; only its file location is a Core-module artifact).** No schema change is made or proposed by this document.

## 8. Human Interaction boundary (Step 4)

Approval/Clarification remain 100% Core, unchanged. The brief's proposed signal shape is adopted as a **design-only** contract element (not implemented this phase):

```ts
// Core → Runs, conceptual only — not implemented in P6b's ExecutionRequest today
interface ExecutionBlockedSignal {
  reasonReference: string; // opaque to Runs — e.g. an Approval/Clarification id
}
```

Runs never learns *why* an Approval is required — it only needs to know, if it ever needs to know at all, that "this Task's execution is blocked" as an opaque fact. As of this session, Runs does not even need this signal directly: the actual mechanism (`evaluateTaskResumeEligibility()` returning `blocked`/`already_terminal` with a reason code) already lives entirely in Core (`core/tact-work/resume.ts`) and is consulted *before* any Runs-owned code (`prepareRunForExecution`) is reached. `Run.status` itself has no `"waiting"`/`"suspended"` value today (`RunStatus = "running"|"completed"|"failed"`) — a Task blocked on Approval simply never has a Run created for it yet, so there is currently no live case where Runs itself needs to represent "waiting." This is recorded as a **future extension point**, not a current requirement.

## 9. Artifact boundary (Step 5)

Read directly from `core/tact-artifact/types.ts`/`store.ts` this session. Today's `Artifact`/`ArtifactBlock` contain **zero** Run/attempt/provider-file-id concepts — they are pure Core content (title, blocks, optional `workId` link, `version`). Proposed future split (not implemented):

- **Core**: Artifact meaning, Artifact role (block types: finding/evidence/table/chart/recommendation/etc.), semantic relationship to `Work`, whether it is a final deliverable.
- **Runs**: which Run/attempt produced or updated a given block, generation timestamp, linkage to a failed/partial execution attempt. **None of this exists today** — `ArtifactBlock`'s common fields are `id/title/order/createdAt/updatedAt` only, with no `runId`.
- **Integration**: provider-specific storage metadata (a Google Drive file id, a Notion page id) — **does not exist in code today**; named only as a future possibility, not a current gap to fix.

## 10. Cost boundary (Step 6)

- **Runs**: provider/model execution cost per attempt (`Run.cost`, already exists, `LLMCost` shape from `core/llm/types.ts`), duration (`Run.startedAt`/`completedAt`, already exists), token usage reference.
- **Core**: Work-level cost interpretation (`WorkCostSummary`, declared in `core/tact-work/types.ts` — **[UNVERIFIED THIS SESSION whether any code path actually populates it]**), budget policy, pricing/plan/credit logic (**does not exist in code today**).
- **Integration**: raw provider usage metadata as returned by a provider call (**does not exist as a distinct concept in code today** — provider results are normalized before reaching Runs).

No implementation in this phase.

## 11. Execution Contract (Core → Runs, Step 7)

Design-only. Not implemented as a literal new type this phase (Step 18 permits a minimal type file only if it prevents further violations; this document instead formalizes the contract **as already expressed** by the actual parameters `dispatchIntegrationReadToRuntime()`/`executeApprovedIntegrationAction()`/`executePreparedTaskResume()` accept today, so a future Stage-1 phase can lift it into a named type without inventing new shape):

```ts
// Conceptual shape, matching what RuntimeExecutionRequest (core/tact-runtime/types.ts)
// and executeApprovedIntegrationAction()'s resolved inputs already carry today.
interface ExecutionRequest {
  workId: string;
  taskId: string;
  capabilityRef: string;      // today: WorkTask.assignedCapability, e.g. "integration.slack.list_channels"
  actionRef: { service: string; operation: string; connectionId: string };
  correlationId?: string | null;
  idempotencyKey?: string;    // today: derived inside TriggerDevRuntimeAdapter from runId, never passed in
  executionConstraints?: Record<string, unknown>; // reserved, unused today
}
```

Confirmed **never** passed into today's actual Runs-shaped functions (`dispatchIntegrationReadToRuntime`, `TriggerDevRuntimeAdapter.startExecution`, `reconcileRuntimeExecution`): raw Slack message content, conversation history, Planner prompt text, user intent text, Approval UI metadata (Slack block-kit, etc.), provider credentials, or a Trigger.dev task id as a *caller-supplied* value (it is only ever produced internally by the Adapter and returned as an opaque `externalRef`). This is already true of the current code, not merely a proposal — this document names it as a contract so it stays true.

## 12. Execution Outcome Contract (Runs → Core, Step 8)

Design-only. `IntegrationActionExecutionOutcome` (`core/tact-integration/execution.ts`) and `RuntimeReadDispatchOutcome`/`RuntimeStartOutcome` (same file / `core/tact-runtime/types.ts`) **already are** this contract in substance — the brief's candidate names (`ExecutionAccepted`/`ExecutionRunning`/`ExecutionWaiting`/`ExecutionCompleted`/`ExecutionFailed`/`ExecutionAmbiguous`/`ExecutionCancelled`) map onto existing values rather than requiring new ones:

| Brief's candidate | Existing equivalent today |
|---|---|
| ExecutionAccepted | `{status:"dispatched"}` (`RuntimeReadDispatchOutcome`) |
| ExecutionRunning | `Run.status === "running"` |
| ExecutionWaiting | not yet needed (Section 8) — no live case exists |
| ExecutionCompleted | `{status:"completed", run}` |
| ExecutionFailed | `{status:"failed", run}` / `{status:"runtime_start_failed"}` |
| ExecutionAmbiguous | `{status:"ambiguous", run}` (already exists, P5d) |
| ExecutionCancelled | **does not exist today** — no cancellation path exists anywhere in the current codebase |

**Recommendation**: do not introduce a new unified `ExecutionOutcome` type yet — it would duplicate two already-correct, already-tested unions for no behavior gain, exactly the "P6b独自のRun statusを追加しない" discipline already applied this session. Returned to Core: canonical execution state, `runId`, `attempt` (via `Run`), timestamps, `result`/`resultOutput`, `externalRef` (as a reference, never expanded), error classification (`IntegrationErrorCode`/`RuntimeError.code`). Never returned to Core: raw Trigger.dev SDK response objects, provider secrets, or internal worker details — confirmed structurally by this session's own P5/P6 test suites (`triggerDev.test.ts`'s secret-safety checks, `reconciliation.test.ts`'s secret-safety check).

## 13. Failure taxonomy (Step 9)

Already correctly separated in the current code, restated as a taxonomy:

- **Core business decisions, never a Runs failure**: `PolicyDecisionOutcome.deny`/`require_approval`/`require_input` (`core/tact-integration/policy.ts`); an Approval being `rejected` (`core/tact-work/approval.ts`); `approval_integrity_failed` (Approval Integrity mismatch).
- **Runs/execution failures**: `runtime_unavailable`, `runtime_rejected`, `unknown_runtime_error` (`RuntimeError.code`, `core/tact-runtime/types.ts`); `invalid_request` (a malformed dispatch request — this is a Runs-boundary validation failure, not a business one); a Composio/provider 5xx (`provider_execution_failed`, `IntegrationErrorCode`, `core/tact-integration/types.ts`); a request timeout with unknown delivery outcome (`RuntimeError.outcomeKnown === false`, mapped to `"ambiguous"` — never to a definite failure, per the P5d invariant this session reconfirmed and relied on in P6b).
- **New candidate names from the brief not yet needed as distinct values**: `execution_rejected`, `duplicate_claim`, `invalid_execution_state`, `reconciliation_failed` — each already has a close existing equivalent (`invalid_request`, `concurrent_resume_detected` (P6b, new this phase), `task_not_executable`, and reconciliation's own `still_unknown`/`confirmed_failed` respectively). No new taxonomy values are introduced by this document.

## 14. State ownership matrix (Step 10)

| State / Data | Core | Runs | Integration |
|---|---|---|---|
| Work status | **Owner** | — | — |
| Task status | **Owner** (Section 5 caveat: execution-phase meaning is read *from* it, not owned by it) | reads/derives | — |
| Run status | reference only | **Owner** | — |
| Approval status | **Owner** | — | — |
| Clarification status | **Owner** | — | — |
| PolicyDecision | **Owner** | — | — |
| externalRef | reference only | **Owner** (column) | provides shape/content |
| attempt number | reference only | **Owner** | — |
| runtime execution id | never sees raw value | reference only (inside externalRef) | **Owner** |
| Artifact semantic metadata | **Owner** | — | — |
| Artifact execution provenance | — | **Owner** (not yet implemented) | — |
| provider file id | — | — | **Owner** (not yet implemented) |
| execution cost (per attempt) | reference only | **Owner** | raw source |
| customer credit / billing | **Owner** (not yet implemented) | — | — |
| execution duration | reference only | **Owner** | — |
| retry count | reference only | **Owner** (`attempt`) | — |
| idempotency key | never generates | **Owner** (derived from `runId` inside the Adapter) | consumes |
| Conversation | **Owner** | never referenced | never referenced |
| Context (research/organizational) | **Owner** | never referenced | never referenced |
| Audit | **Owner** (ledger/schema) | producer (execution/provider events) | producer (provider events) |
| completion condition | **Owner** | — | — |

No cell has two owners; every non-owner cell is explicitly a reference or a producer, never a second source of truth — consistent with the brief's "複数ownerは禁止" rule.

## 15. Dependency direction (Step 11)

Ideal:

```
TACT Core
   ↓
TACT Runs Contract   (design-only today — Section 11/12)
   ↓
TACT Runs            (core/tact-runtime/* + the Run-lifecycle half of core/tact-integration/execution.ts)
   ↓
Integration Ports     (RuntimeAdapter, gateway.ts's executeIntegrationAction() signature)
   ↓
Runtime / Provider adapters   (providers/triggerDev.ts, providers/composio/**)
```

Forbidden directions and their current status: `Runs → tact-bot` (not found — `core/tact-runtime/**` imports nothing from `tact-bot`); `Runs → tact-conversation` (not found); `Runs → Slack` (not found — no `@slack/web-api` or Slack-shaped identifier anywhere under `core/tact-runtime/**`); `Runs → Planner` (not found); `Runs → Context Selection` (not found); `Core → TriggerDevRuntimeAdapter` directly (not found — `core/tact-work/**` never imports `core/tact-runtime/providers/**`); `Integration → Policy` (not found — `core/tact-integration/providers/composio/**` never imports `policy.ts`); circular dependency (not found anywhere in this inventory).

## 16. Current boundary violations (Step 12, code-grounded only)

1. **`core/tact-integration/execution.ts` mixes Core (Policy live recheck, Approval Integrity) + Runs (Run lifecycle) + Integration (Provider dispatch via `gateway.ts`) in single functions** (`executeApprovedIntegrationAction`, `executeIntegrationActionCore`). — **Classification: C (DEFER)**. This is the load-bearing, production-proven execution boundary; splitting it is a real refactor with real regression risk, not something to do opportunistically.
2. **`core/tact-conversation/orchestration.ts` directly calls `resolveRuntimeIntegrationReadAdapter()` and owns the Runtime-vs-native routing decision** (`executeReadIntegrationActionWithRuntimeRouting`), rather than that decision living behind a Runs-owned dispatch call. — **Classification: B (next natural implementation time)**. The next Fast Port phase that touches read-execution routing should move this decision point, not before.
3. **`core/tact-integration/policy.ts` (pure Core logic) lives inside the `tact-integration` folder**, whose name suggests Integration Boundary. — **Classification: C (DEFER)**. Purely a naming/location issue with zero import-direction violation; safe to leave until a broader rename is worth doing.
4. **`Run`'s canonical type/table lives inside the `tact-work` module** even though its responsibility is Runs. — **Classification: C (DEFER)**. Same reasoning as #3 — content is already correctly Runs-shaped, only the file's home is a Core-module artifact.
5. **`core/tact-bot/execution/trustedApprovalDecision.ts` composes a Core operation (Approval resolution) with a Runs-adjacent one (resume execution invocation) in one file**, even after this session's P6b decoupling of the *call structure*. — **Classification: C (DEFER)**. This is the same class of "trusted composition boundary" as `core/tact-conversation/orchestration.ts` itself (already a sanctioned composition root) — acceptable as-is.

No violation in this list is classified **A (fix now)** — consistent with the brief's explicit priority ("本体開発を遅らせないことを最優先").

## 17. Migration strategy (Step 13)

- **Stage 0 (this document)**: responsibility boundary document only. **Done, this phase.**
- **Stage 1**: write the provider-neutral Runs Contract as an actual type file (e.g. `core/tact-runs/contract.ts`) capturing Section 11/12's shapes literally, with zero behavior change — a pure type-level lift of what already exists as inline parameters.
- **Stage 2**: make `core/tact-integration/execution.ts`'s Run-lifecycle half (violation #1) call through that contract type internally, without moving the file.
- **Stage 3**: make `core/tact-conversation/orchestration.ts` consume the Runs Contract for the read-routing decision (violation #2) instead of calling `resolveRuntimeIntegrationReadAdapter()` directly.
- **Stage 4**: move `providers/triggerDev.ts` and `providers/composio/**` to be consumed only through Integration Ports defined by the Runs Contract (largely true already; formalize it).
- **Stage 5**: only once Stage 1–4 are stable and load-bearing, consider physically relocating files (e.g. a `core/tact-runs/` folder for `tact_runs`-adjacent logic) — **not scheduled, not this phase, not the next phase by default**.
- **Stage 6**: only after Section 18's extraction gate is met, consider a separate package/module.

## 18. TACT Runs extraction gate (Step 14)

Do **not** extract TACT Runs into a separate package/module/service until **all** of the following hold:

1. Substantial internal Run volume/history exists inside TACT itself (not merely test coverage).
2. Resume/retry/reconciliation have been exercised in real production incidents, not only in this session's synthetic concurrency tests.
3. At least two genuinely different runtime/provider pairs share the same contract without special-casing (today: Trigger.dev only; Composio is a provider, not a second RuntimeAdapter — this condition is **not yet met**).
4. TACT-specific imports (Slack, Conversation, Approval types) can be fully removed from whatever code would move, with zero remaining reference — **not yet true**, per violation #1/#2/#5 above.
5. A Runs unit test suite can run and pass with zero import of anything under `core/tact-work/`, `core/tact-conversation/`, or `core/tact-bot/` — **not yet true**: today's Runs-shaped tests (`reconciliation.test.ts`, `reconcileOneShotEntrypoint.test.ts`) already import `core/tact-work/types.ts` for shared shapes (`Run`, `Work`), which would need to become contract-only types first.
6. A second, non-TACT agent use case has been evaluated against the contract without it breaking — **not yet applicable, no second consumer exists.**

## 19. Productization gate (Step 15)

Do not build a public API, SDK, Developer Dashboard, billing, external auth, or SLA commitments until:

1. TACT itself has run a large volume of executions through the Runs boundary.
2. Failure/recovery has real production track record (ambiguous-start handling, reconciliation, resume — all live as of P5d/P6a/P6b, but young).
3. The contract's behavior is demonstrably generic — not shaped by any single TACT Capability's quirks.
4. The contract has been evaluated against at least one other agent/product use case, hypothetically or concretely.
5. Multiple external developers have expressed concrete demand, not speculative interest.

None of these are met today, and none are pursued by this phase.

## 20. Naming (Step 16)

**"TACT Runs" is the name of the execution-management *design boundary*** described in Sections 5, 11, 12, 14, and 18 of this document — it is not a literal folder, package, or service today, and this phase deliberately does not create one. **`Run`** (singular, `core/tact-work/types.ts`, table `tact_runs`) is one canonical *entity* inside that boundary — "one execution attempt" — and is not itself "TACT Runs." Other terms considered and their relationship to "TACT Runs": **"Work Runtime"** and **"Execution Layer"** are treated as informal synonyms for the same boundary, used interchangeably in prose elsewhere in this repo's docs (e.g. `p2-p5-final-architecture.md`'s "durable execution substrate"); **"Execution Control Plane"** is reserved as a possible *future* name for Stage 5+'s physically-separated module, should extraction ever happen — it is not used as a synonym for "TACT Runs" today, to avoid implying a separation that does not yet exist.

---

## Final Verdict

**ARCH-RUNS-1 Execution Boundary Extraction = PASS.**

- All three boundaries (Core/Runs/Integration) have grounded, code-checked responsibility definitions (Sections 4–6).
- Work/Task/Run ownership is resolved with an explicit, honestly-reported tension (`WorkTask.status`'s dual role, Section 5) rather than a false claim of a clean split.
- Human Interaction, Artifact, and Cost boundaries are defined for the future without any implementation this phase (Sections 8–10).
- Execution Request/Outcome contracts are defined as *already implicit* in existing code, avoiding invented new types (Sections 11–12).
- Failure taxonomy is confirmed already separated correctly in practice (Section 13).
- State ownership matrix has exactly one owner per row (Section 14).
- Dependency direction is confirmed clean in every forbidden direction, checked against actual imports (Section 15).
- Five real boundary violations are named with evidence and triaged (none urgent) rather than invented or ignored (Section 16).
- A six-stage migration strategy, an extraction gate, and a productization gate are defined without scheduling any of them prematurely (Sections 17–19).
- Naming is clarified to prevent "TACT Runs" from being confused with the `Run` entity or with a literal module that does not exist yet (Section 20).

No code was moved. No migration was written. No public surface was created.
