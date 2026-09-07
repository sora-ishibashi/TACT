# TACT Prior Art Blitz — Tier S Summary

Synthesis of 5 individual investigations: [preloop.md](./preloop.md), [boundflow.md](./boundflow.md), [humanlayer-acp.md](./humanlayer-acp.md), [axme.md](./axme.md), [chowki.md](./chowki.md).

Investigation date: 2026-09-07. This is a documentation-only deliverable — no production code, DB schema, migrations, or dependencies were changed while producing it.

## Corrections Applied (2026-09-08)

The first pass of this summary treated some Prior Art recommendations as more authoritative than TACT's own Canonical Model. **The TACT Canonical Model always takes precedence over Prior Art** — Prior Art is reference evidence, not a design authority. Three corrections were applied after re-reading this session's instructions and TACT's actual existing code (`core/tact-work/types.ts`, `supabase/migrations/20260905000000_create_tact_work_tables.sql`):

1. **Retry semantics reversed.** The original recommendation to adapt BoundFlow's "same Run, mutable `attempts` counter" pattern is now **REJECT_FOR_TACT_CANONICAL_MODEL**. TACT's canonical rule is: every execution attempt is a **new** `Run` row; Runs are never mutated/overwritten to represent a retry. This is not a hypothetical preference — `core/tact-work/types.ts`'s `Run` type **already has an `attempt: number` field** and its own doc comment already states "Task 1 → N Run（Retryごとに新しいRun）" (Architecture Migration Phase B1, predates this Prior Art review). The earlier Kill-Question-6 verdict of "MODIFY" is retracted; it should have been **KEEP** — TACT had already made the correct decision before this Blitz started, and BoundFlow's contrary design should not have been given priority over it.
2. **State-model recommendations softened.** "ADD" verdicts for Work/Task/Run state gaps have been downgraded to **REVIEW** — Prior Art states like BoundFlow's `paused`/`cooldown`/`disabled`/`suspended` describe a **recurring Workflow definition's** scheduling/enablement control, not an individual Work **instance's** execution lifecycle (TACT's `Work` has no "definition vs. instance" duality the way BoundFlow's `workflows` table does — TACT's `Work` is instance-only). Copying those state names into `WorkStatus` without first confirming they describe the same *layer* of the system would blur a Concept Boundary TACT does not currently have a problem with. See the corrected Kill Question table below.
3. **External execution engine conclusion narrowed.** The prior phrasing ("TACT should keep building its own durable runtime") overstated what this Blitz actually established. The accurate conclusion is narrower: **none of the 4 identified Tier S targets can be adopted wholesale while satisfying TACT's Canonical Model, Supabase-as-source-of-truth, and Provider-neutrality requirements simultaneously.** This says nothing about Temporal, Trigger.dev, n8n, LangGraph, or other durable-execution infrastructure not evaluated in this round — those remain open questions for a dedicated future comparison. The verdict stays **DEFER**, not "reject external engines in general."

## Target identification results

| Target | Identified? | Repository | License |
|---|---|---|---|
| Preloop | ✅ Confirmed | github.com/preloop/preloop | Apache-2.0 |
| BoundFlow | ✅ Confirmed | github.com/boundflow/boundflow | Apache-2.0 (backend) / MIT (Python SDK) |
| HumanLayer Agent Control Plane | ✅ Confirmed (but stale — last commit 2025-07-02, org's flagship product has since pivoted away from this repo) | github.com/humanlayer/agentcontrolplane | Apache-2.0 |
| AXME | ✅ Confirmed | github.com/AxmeAI/axme + github.com/AxmeAI/axp-spec | MIT |
| chowki | ❌ **対象不確定** — no real project matching this name in the described problem space could be found after a thorough search | N/A | N/A |

All 4 identified targets are young, low-to-moderate adoption projects (weeks to ~8 months old, single-digit to low-hundreds of stars). None should be treated as a "battle-tested, widely-adopted reference architecture" — they are useful as **independent design evidence and vocabulary**, not as proof of scale-tested correctness.

## Comparison Table

| TACT Concern | Preloop | BoundFlow | HumanLayer ACP | AXME | chowki | Best Source |
|---|---|---|---|---|---|---|
| Policy | Strong — YAML+CEL policy-as-code, priority-ordered rules, fail-closed on evaluator error | Two-layer: `RuntimePolicy` (hard, in-execution) + `LifecyclePolicy` (autonomous, oversteps TACT's Optimizer/Brain limits) | Weak — no dynamic policy engine found, only static `ApprovalContactChannel` presence | Named only (`policy_engine` service, `policy_denied` error code); implementation closed-source | 対象不確定 | **Preloop** |
| Task lifecycle | No unified Task concept (three semi-independent subsystems: MCP firewall / model gateway / Flows) | `workflows` table = versioned Task-like entity, but conflates execution state into itself | `Task` CRD ≈ one LLM conversation instance (closer to Run-grain than Task-grain) | `Intent` ≈ Task-like, but no attempt/Run separation (idempotency-key dedup instead) | 対象不確定 | **BoundFlow** |
| Run lifecycle | Not modeled | `customer_requests` (Run, append-only history) + `jobs` (mutable attempt slot) — explicit two-table split | No distinct Run entity; Task itself is the execution unit | No distinct Run entity; idempotency-key handles retry-safety at Intent level | 対象不確定 | **BoundFlow** |
| Durable execution | Not modeled (single call/flow scope only) | `server`/`scheduler`/`worker` processes share Postgres; claim+lease crash recovery | `ContextWindow` persisted as Kubernetes CR status (etcd); checkpoint on every tool call/delegation | Event-sourced Intent lifecycle (spec-level only; runtime is closed-source SaaS) | 対象不確定 | **BoundFlow** (code-verified) |
| Pause / Resume | Blocking or async approval wait (`get_approval_status` poll) | `ApprovalGate`/`InputGate` returned by workflow code; control plane — not agent code — enforces the pause | `ExternalCallID` single-field resume token + 5s poll / 15s backoff | `WAITING` status + mandatory `waiting_reason` enum (`_HUMAN`/`_TOOL`/`_AGENT`/`_TIME`) | 対象不確定 | **BoundFlow** (mechanism) / **HumanLayer ACP** (token simplicity) |
| Retry | Not modeled at Task level | `jobs.attempts` incremented on the *same* row; cap enforced in the SQL `WHERE` clause itself — **rejected for TACT, see Corrections above** | Poll retry w/ backoff (5s/15s, inferred) — not a Task-execution retry model | Idempotency-key based retry-safety, not an attempt-count model | 対象不確定 | **None matches TACT's model as-is.** TACT's own `Run.attempt` (new row per attempt, Phase B1, predates this review) is already stricter/more correct than any of the 4 — this row exists to document that a real gap was checked, not to import a pattern. |
| Human interaction | `ask_user` in-band tool + explicit anti-self-approval boundary | `ApprovalGate` (approve/reject) vs `InputGate` (free-form answer) as distinct gate types | `Approval` vs `HumanContact` as distinct `ToolType`s | 8 built-in human task types: approval/review/form/manual_action/override/confirmation/assignment/clarification | 対象不確定 | **AXME** (taxonomy breadth) / **Preloop** (safety) |
| Approval safety | **Anti-self-approval boundary**: in-band agent-session replies are informational-only, never accepted as the real answer | "nothing irreversible runs until the branch it's gated behind does" — engine-enforced, not agent-enforced | `AllowedResponderIDs` restricts who may approve via Slack | Thin `{decision: approve\|reject, comment?}` endpoint — no explicit anti-self-approval or payload-binding found | 対象不確定 (this was chowki's specific focus — **unanswered by any source**) | **Preloop** |
| Audit | `AuditLog` + `ApprovalEvent`; **no confirmed immutability guarantee** | `audit_events` (tenant/workflow/request/event_type/actor/occurred_at/details jsonb) — clean, ready-to-adapt shape | Kubernetes Events only — generic, not a dedicated audit model | `intent.event.v1` — event-sourced, monotonic `seq`, timestamped, actor-attributed | 対象不確定 | **BoundFlow** (schema) / **AXME** (event ordering) |
| Idempotency | Not focal | claim-before-execute + lease + bounded attempts (`internal/storage/postgres/job.go`) | Not focal (only implicit via `ExternalCallID`) | **Idempotency-key + correlation-id composite dedup; same key + different payload ⇒ conflict, not silent overwrite** | 対象不確定 (this was chowki's specific focus — **unanswered by any source**) | **AXME** |
| Recovery | `execution_recovery.py`/`checkpoint_runtime.py` exist (file names only, not read in depth) | claim/lease + `SweepAbandonedJobs()` ticker — concrete, code-verified crash recovery | etcd-native Kubernetes reconciliation; full `ContextWindow` as recoverable state | Unconfirmed (closed-source runtime) | 対象不確定 | **BoundFlow** |
| Provider neutrality | Strong — OpenAI/Anthropic-compatible gateway, LiteLLM-style multi-provider routing | Weak — Python SDK core directly depends on `anthropic>=0.40` | Moderate — `LLM` CRD supports OpenAI/Anthropic/Vertex/Mistral | Mixed — protocol is provider-neutral in principle, but **transport is hard-locked to Matrix/Synapse** (explicit cautionary example) | 対象不確定 | **Preloop** |

## Tier S Borrow Candidates

| TACT Concept | Source | Exact Pattern | Classification | License | Why | Implementation Risk |
|---|---|---|---|---|---|---|
| Policy Gate | Preloop | Evaluate-before-invoke in `DynamicMCPServer.handle_call_tool`; fail-closed (`require_approval`) if the evaluator itself errors | ADAPT | Apache-2.0 | Direct precedent for "Policy/Permission/Approval enforced deterministically at the Execution Layer" | Low — pattern only, reimplement in TS |
| Anti-self-approval boundary | Preloop | `ask_user_inband.py` — in-band notice to the agent's own session is informational-only; the real answer must arrive through a separate governed channel | ADAPT | Apache-2.0 | Reinforces "LLMs must never be trusted with Authorization" at the protocol level, not just the prompt level | Low |
| Approval status enum | Preloop | `PENDING / APPROVED / DECLINED / EXPIRED / CANCELLED` | ADAPT | Apache-2.0 | Distinguishes declined (explicit no) vs expired (timeout) vs cancelled (withdrawn) — useful if TACT currently collapses these | Low |
| Task/Run two-table split | BoundFlow | `workflows` (Task) vs `customer_requests` (Run, append-only) | REFERENCE_ONLY — TACT already has this as `WorkTask`/`Run` (Phase B1) | Apache-2.0 | Confirms TACT's own Task/Run separation is directionally sound; not something to newly borrow, already built | Low — no action needed, already implemented |
| Retry = same Run, attempt counter (mutable row) | BoundFlow | `jobs.attempts`, incremented via `RequeueJob` with `attempts < max` enforced in the SQL `WHERE` clause | **REJECT_FOR_TACT_CANONICAL_MODEL** | Apache-2.0 | Directly contradicts TACT's canonical rule "Run = one execution attempt, retries are new Runs, never overwritten." TACT's `Run.attempt: number` (already implemented) is the correct mechanism — it numbers a *new row* per attempt, it does not mutate a shared row. | N/A — explicitly not adopted |
| Retry-attempt linkage (future candidate, not decided) | BoundFlow (`jobs.request_id → customer_requests.id`, informal FK) / AXME (`correlation_id`) | Neither project's *exact* field should be copied, but both confirm that "which Runs belong to the same logical retry sequence" is a real question worth an explicit field | REFERENCE_ONLY | N/A | TACT's `Run.attempt` already orders attempts within a Task, but there is no explicit `retry_of_run_id` / `execution_group_id` linking a specific failed Run to the Run that retried it, nor a `retry_group_id` grouping a whole retry sequence. Not needed today; worth deciding explicitly in a future Run-schema Phase, not silently added now. | Deferred — no schema change in this investigation |
| `audit_events` schema | BoundFlow | `tenant_id / workflow_id / request_id / event_type / actor / occurred_at / details jsonb` | ADAPT | Apache-2.0 | Near-direct template for a TACT Audit receipt table | Low |
| `ApprovalGate` / `InputGate` split | BoundFlow | Two distinct gate message types in `operation.proto` | ADAPT | Apache-2.0 | Direct precedent for separating Approval from general HumanInteraction | Low |
| Gate-as-return-value | BoundFlow | Approval expressed as a function return value (`AwaitApproval(...)`); the *engine*, not the agent's own code, enforces the pause | REFERENCE_ONLY | Apache-2.0 | Validates "protected write never executes before Approval is granted" as a workable real-world pattern | Low (concept only) |
| Single-field resume token | HumanLayer ACP | `ToolCallStatus.ExternalCallID string`, used as the poll key to correlate an async human response | ADAPT | Apache-2.0 | Minimal correlation-id pattern for TACT's pause/resume design | Low |
| Approval vs HumanContact split | HumanLayer ACP | `ToolType: MCP \| HumanContact \| DelegateToAgent`, with `AwaitingHumanApproval` vs `AwaitingHumanInput` as distinct phases | ADAPT | Apache-2.0 | Reinforces Approval/HumanInteraction as genuinely separate concepts | Low |
| `WAITING` + mandatory `waiting_reason` | AXME | `intent.lifecycle.v1.json` — JSON Schema `if/then` requires `waiting_reason` whenever `status == WAITING` | ADAPT | MIT | Direct answer to Kill Question 5 | Low |
| Idempotency-key + correlation-id dedup rule | AXME | Composite dedup key; **same key + different payload ⇒ conflict**, not silent overwrite | ADAPT | MIT | Precise, adoptable-as-written policy statement for "never casually re-execute a successful external side effect" | Low |
| 8-type human task taxonomy | AXME | `approval / review / form / manual_action / override / confirmation / assignment / clarification` | REFERENCE_ONLY | MIT | Independent cross-check for TACT's own proposed 7-type Human Interaction list; AXME has `Override`/`Form` that TACT's list lacks | Low |
| Event-sourced lifecycle, monotonic `seq` | AXME | `intent.event.v1.json` — every transition is a discrete, ordered, timestamped, actor-attributed event | ADAPT (concept) | MIT | Reference shape for an Audit/event-log entity | Medium — event sourcing is a bigger architectural commitment than a single table |

## Explicitly Rejected (do not adopt, noted as risk/counter-evidence)

- **Same-Run mutation for retry** (BoundFlow's `jobs.attempts` counter on a single mutable row) — contradicts TACT's canonical "Run = one execution attempt; retries are new Runs" rule, which TACT had already implemented (`Run.attempt`, Phase B1) before this review. REJECT_FOR_TACT_CANONICAL_MODEL.
- **AI-decided approvals** (Preloop's `decided_by_ai`/`ai_confidence` fields) — directly conflicts with "LLMs must never be trusted with Authorization decisions." REJECT.
- **LifecyclePolicy autonomous workflow-version rollback** (BoundFlow) — exceeds what TACT's rules allow Optimizer/Brain to do (evaluation-only, no direct control over execution/Agent selection). REJECT.
- **Kubernetes CRD/Operator + etcd as source of truth** (HumanLayer ACP) — incompatible with "Supabase is the single source of truth." REJECT as infrastructure (pattern-level ideas still usable).
- **Matrix/Synapse hard transport lock-in** (AXME) — a real, documented lock-in decision *within AXME itself*; cited as a cautionary example of "borrow first" turning into deep coupling, not as something to replicate. REJECT.
- **Closed-source managed runtimes as a dependency** (AXME Cloud) — reintroduces exactly the vendor lock-in "Provider neutrality" exists to prevent. REJECT as infrastructure.

## Architecture Kill Questions — Verdicts (corrected 2026-09-08)

Full reasoning for each is in the chat report (Section 7 of the correction report). Verdict legend: KEEP / MODIFY / ADD / REVIEW / REMOVE / DEFER. Changes from the first pass are marked.

| # | Question | Verdict | Change |
|---|---|---|---|
| 1 | Work/Task/Runの3層は妥当か | KEEP | unchanged |
| 2 | Workに不足しているstateはあるか | **REVIEW** | was ADD — see Correction 2: Prior Art states largely describe a Workflow-*definition* concept TACT's instance-only `Work` doesn't have; needs Concept Boundary review before adding anything |
| 3 | Taskに不足しているstateはあるか | **REVIEW** | was ADD — same reasoning; TACT's `TaskStatus` currently has no waiting state at all, worth reviewing but not auto-adding |
| 4 | Runに不足しているstateはあるか | **REVIEW** | was ADD — narrow, concrete question worth reviewing: `Run` has no `cancelled` state (Work/Task both do) — flag for review, not an automatic add |
| 5 | waiting reasonをstatusとして持つべきか、別fieldにすべきか | REVIEW (undecided) | was "ADD, 別field" — TACT's `WorkStatus` already bakes two specific waiting states (`waiting_for_input`, `waiting_for_approval`) directly into the top-level enum, which is a *different* design choice than AXME's generic `WAITING` + `waiting_reason`. Both are defensible; this is a real open question for ARCH-P3, not something to decide by Prior Art precedent alone |
| 6 | Retryは新Runとして表現すべきか | **KEEP** | was MODIFY — **correction**: TACT's `Run.attempt` (Phase B1, predates this review) already implements exactly this — new Run row per attempt. The original MODIFY verdict incorrectly gave BoundFlow's contrary same-row-mutation design priority over TACT's own already-correct Canonical Model. See Corrections Applied above |
| 7 | Durable executionに必要なentityが不足しているか | ADD | unchanged |
| 8 | Checkpoint entityが必要か | DEFER | unchanged |
| 9 | Event logが必要か | ADD | unchanged — reinforced: TACT's own Phase B1 migration comment already named Event as a deliberately-deferred Canonical Model entity ("実際の必要性が生じるまで"); this Blitz's Audit findings are exactly that trigger |
| 10 | Snapshotが必要か | DEFER | unchanged |
| 11 | HumanInteractionをApprovalから独立entityにするべきか | ADD | unchanged |
| 12 | Approval対象payloadをhash/bindするべきか | ADD (highest priority) | unchanged — reinforced: TACT's live `Approval.payload: Record<string, unknown>` (already used in production via `core/tact-work/execution.ts`) has no hash/binding field today. This is not a future risk, it is a live gap |
| 13 | Approval後のpayload mutationをどう検知すべきか | ADD (same priority as #12) | unchanged, same reinforcement |
| 14 | Policy decision型を正式化すべきか | ADD | unchanged |
| 15 | Context PermissionとAction Permissionをどこで分離すべきか | MODIFY | unchanged |
| 16 | Credential Owner conceptが必要か | DEFER | unchanged |
| 17 | AuditをRun metadataで済ませてよいか、独立event/receiptが必要か | ADD (独立entity必要) | unchanged |
| 18 | HTTP lifecycleからWork executionを切り離すために何が必要か | ADD (design known; implementation is its own future Phase) | unchanged |
| 19 | 外部execution engineを採用すべきか | DEFER | unchanged, scope narrowed — see Correction 3 |
| 20 | TACT自身で作る必要がない部分は何か | DEFER | was KEEP — **correction**: narrowed per Correction 3. This Blitz did not establish "build everything yourself forever," only that these specific 4 targets aren't wholesale-adoptable. Whether e.g. Temporal/Trigger.dev/n8n is worth adopting for a *specific bounded piece* (not the whole Canonical Model) remains open and deferred to a future comparison Phase |

## Notable cross-cutting finding

**No surveyed project (including the intended "chowki" target, which could not be identified) provides a confirmed, code-verified answer to "how do you detect that an Approved payload has since mutated before execution."** Preloop's `ApprovalRequest` carries no confirmed content hash; BoundFlow's `ApprovalGate` carries `justification`/`metadata` but no confirmed binding; AXME's approval-decision endpoint is a thin approve/reject with no payload reference beyond IDs. This is a genuine gap across the entire Tier S sample, not a solved problem TACT can borrow — it should be treated as original design work for TACT, informed by (but not copied from) the patterns above (see Kill Questions 12–13).

**This is not a theoretical future concern.** TACT's own `Approval` type (`core/tact-work/types.ts`) already has a `payload: Record<string, unknown>` field with no hash/version/binding companion, and it is already wired into a live production path (`core/tact-work/execution.ts` imports and uses `Approval`/`Work` from this module, powering the Slack Bot's `executeApprovedIntegrationAction()` flow established earlier in this session). ARCH-P1 (Approval Integrity) closes a gap in code that already ships, not a gap in a future design.
