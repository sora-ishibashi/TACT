# TACT Approval Integrity — ARCH-P1 Design

Status: design only. No production code, migration, or dependency was changed to produce this document. See [Scope](#scope-and-status) at the end.

Related: [borrowed-patterns.md](./borrowed-patterns.md), [tier-s-summary.md](../prior-art/tier-s-summary.md), [preloop.md](../prior-art/preloop.md).

# Executive Summary

TACT's current Approval execution boundary (`core/tact-integration/execution.ts`'s `executeApprovedIntegrationAction()`) is, in practice, well-defended against several of the threats this design was asked to consider: cross-Task misuse, cross-Work misuse, and replay are already structurally prevented by existing code, not just by convention. The actual gap is narrower and more specific than "Approval integrity is unguarded" — it is that **`Approval.payload`'s immutability today is accidental, not verified**. No SQL `UPDATE` statement in the codebase ever touches the `payload` column after `createApproval()` inserts it, so nothing *currently* mutates an approved action before execution — but nothing *checks* that this holds, either. There is no stored record of what was approved independent of the live row, no hash, no version tag, and no verification step. A future feature (an "edit pending approval" UI, a backfill script, a bug in a new Capability) could silently violate the invariant with no test or runtime check ever catching it.

This design turns that implicit, accidental invariant into an explicit, verified one: at Approval-creation time, TACT captures a canonical, versioned, hashed snapshot of exactly what is being authorized; at execution time — immediately before the provider is ever called — TACT re-derives the same canonical form from the live action and confirms it matches the stored snapshot, byte-for-byte. A mismatch fails closed, makes zero provider calls, creates zero Runs, and requires a fresh human decision.

The recommended approach is a **stored, versioned canonical subject plus a hash** (Option E in Step 5), not a hash-only scheme — because TACT's Approval flow is a low-throughput, audit-critical, human-facing safety boundary, not a high-volume system where storage cost matters. Debuggability and auditability dominate the trade-off.

# Existing Approval Flow

Traced end-to-end from real code, no part of this section is inferred.

**1. Approval entity's current type** — `Approval` (`core/tact-work/types.ts:300-332`):
```ts
interface Approval {
  id: string;
  workId: string;
  taskId?: string | null;
  requestedByActorKind: ActorKind;   // "user" | "bot" | "system" | "ai"
  requestedByActorId: string;
  requestedFromActorKind: ActorKind;
  requestedFromActorId: string;
  status: ApprovalStatus;            // pending | approved | rejected | cancelled | expired
  reason: string;
  payload: Record<string, unknown>;
  requestedAt: string;
  respondedAt?: string | null;
  response?: string | null;
  expiresAt?: string | null;
  createdAt: string;
}
```

**2. Table schema** — `tact_approvals` (`supabase/migrations/20260905000000_create_tact_work_tables.sql`). RLS via `EXISTS`-join to `tact_works.user_id` (Approval has no `user_id` of its own — ownership is always derived through Work, ARCH-R2 Section15). FK: `tact_tasks → tact_approvals.task_id` is `ON DELETE SET NULL` (Approval survives Task deletion — audit rows are never cascade-deleted just because a Task record disappears). `tact_works → tact_approvals` is `ON DELETE CASCADE` (Approval is meaningless without its Work).

**3. Payload/action information currently stored** — built by `toApprovalPayload()` (`core/tact-work/approval.ts:102-110`):
```ts
{ scope: "work"|"task"|"action", action: ApprovalActionDescriptor | null, ...metadata }
```
where for Integration writes, `action` is the generic `TaskApprovalAction` shape (`core/tact-orchestrator/task.ts:231-239`): `{ kind, summary, metadata: { service, operation, input, connectionId } }`. `input` (e.g. `{ channel, text }` for `slack.send_message`) is the actual machine-executed argument set. `summary` (e.g. `"Slack「general」チャンネルへメッセージを送信します"`) is the only thing a human ever sees.

**4. Approval creation point** — `runWorkTurn()`'s `onTaskFinished()` hook (`core/tact-work/execution.ts:387-524`). For Integration writes: policy check (`resolveIntegrationActionPolicy`) already happened one layer up, inside the Capability itself (`core/tact-integration/capability.ts:79`, `runIntegrationSlackSendMessageCapability()`), which sets `integrationRequirement.requiresApproval` from the canonical policy allowlist. `onTaskFinished()` resolves the Connection (adds `connectionId` into `action.metadata`), then calls `deps.requestApproval({ ...action: resolvedAction })` (`core/tact-work/execution.ts:567-587`), which delegates to `requestApproval()` in `core/tact-work/approval.ts:123-153` → `createApproval()` in the store.

**5. What Approval decision (`approveApproval`/`rejectApproval`) references** — `core/tact-work/approval.ts:201-339`. Neither function reads `payload` at all. Both operate purely on `Approval.status` and `Work.status` (must be `waiting_for_approval` to transition). This is important: **the decision boundary and the content boundary are already separate** — approving/rejecting never looks at *what* is being approved, only *whether* it's still pending and the Work is still resumable.

**6. Where execution restores the Action** — `extractIntegrationActionFromApproval()` (`core/tact-integration/execution.ts:173-211`). Pulls `payload.action.metadata.{service,operation,input,connectionId}` back out with `typeof` shape checks only (no schema validation library, no hash, no cross-check against anything else). This is the sole source of the action that gets dispatched to the provider.

**7. Approval ↔ Task** — `Approval.taskId`, set once at creation, never reassigned. Critically, `executeApprovedIntegrationAction(workId, userId, accessToken, approvalId, ...)` takes **no `taskId` parameter at all** — the Task it acts on is always `approval.taskId`, read from the fetched row itself (`core/tact-integration/execution.ts:462`). A caller cannot substitute a different Task even if it wanted to.

**8. Approval ↔ Run** — no direct FK. Linkage is by convention: `Run.externalRef.approvalId` is set at completion time (`core/tact-integration/execution.ts:338-340`) and is how dedup finds "was this Approval already executed" (`findAlreadyExecutedRun()`, line 213-223). Runs do not exist at Approval-creation time — they are created only inside `executeIntegrationActionCore()`, at actual dispatch (`core/tact-integration/execution.ts:310-320`).

**9. Approval ↔ Work** — `Approval.workId`, and `getApproval(workId, userId, accessToken, approvalId)` requires the row's own `work_id` column to equal the passed `workId` (`core/tact-work/store.ts:899-916`) *and* the calling `userId` to own that Work. A mismatched `workId` simply returns "not found."

**10. Duplicate approve** — `approveApproval()`: if `approval.status === "approved"` already, returns `{status: "already_resolved", approval}` without any further DB write (`core/tact-work/approval.ts:216-218`).

**11. `already_resolved` + approved re-entry semantics** — `handleApprovalDecisionAsTrustedActor()`'s `shouldAttemptExecution()` (`core/tact-bot/execution/trustedApprovalDecision.ts:136-148`) explicitly treats `already_resolved` with `approval.status === "approved"` as "attempt execution again" — deliberately re-entering `executeApprovedIntegrationAction()`. Safety for this re-entry is delegated entirely to that function's own dedup (`already_executed`) and Task-state precondition (`task_not_executable`) — by design, not by accident (comment explicitly says so).

**12. Reject path** — `rejectApproval()` never calls `executeApprovedIntegrationAction()`; `handleApprovalDecisionAsTrustedActor()` returns immediately after `rejectApproval()` on `decision === "reject"` (`core/tact-bot/execution/trustedApprovalDecision.ts:164-178`). No code path exists from reject to provider execution.

**13. External write execution boundary** — `executeApprovedIntegrationAction()` (`core/tact-integration/execution.ts:390-487`), the sole entry point. Order today: Work ownership → Approval ownership → status===approved → Work runnable → extract action → **policy re-verification (must not be `read`)** → Connection ownership+active → **dedup (already_executed)** → shared core (`executeIntegrationActionCore`) → Task-state precondition (must be `pending`) → create Run → dispatch to provider → complete/fail Run → update Task.

**14. Current dedup boundary** — `findAlreadyExecutedRun()`: a completed `Run` whose `externalRef.approvalId` equals the current `approvalId`. Provider is never called twice for the same Approval once one execution has completed successfully. No automatic retry anywhere in this path (confirmed by repeated explicit comments: "1回だけ呼ぶ、自動retryしない").

**15. Current mutation-detection** — **none**. Confirmed absence, not inference: `updateApprovalStatus()` (`core/tact-work/store.ts:929-964`) only ever sets `status`/`responded_at`/`response` — the `UPDATE` statement's payload literally does not include `payload`. There is no other function in the repository that writes to `tact_approvals.payload`. Immutability today is a property of "no code path exists to mutate it," not a checked invariant.

# Current Gap

Stated precisely, given the above: **`Approval.payload` is immutable by omission, not by design contract.** Nothing computes, stores, or re-verifies a canonical representation of what was approved. Two concrete, currently-live consequences:

- **Threat N (partial/hidden mutation) is structurally unguarded**, even though today's single code path happens to avoid it. `summary` (what the human sees) and `input` (what gets executed) are sibling fields on the same `TaskApprovalAction` object, built from the same local variables in the same function call (`runIntegrationSlackSendMessageCapability()`, `core/tact-integration/capability.ts:99-123`). They are consistent *today* because of how that one function happens to be written — not because anything checks they stay consistent, including in future Capabilities that are not yet written.
- **Threat G (policy mutation) is unguarded.** `resolveIntegrationActionPolicy()` is a static in-code lookup (`POLICY_ALLOWLIST`, `core/tact-integration/policy.ts:73-76`) re-evaluated fresh at execution time. If a deploy between Approval-creation and execution changes an operation's `riskClass` (e.g. `write` → `destructive`), execution only checks "is it still not `read`" — it has no记录 of what risk class the human's decision was actually based on.

This is a **live gap**, not a future one: `Approval` is already wired into production (`core/tact-work/execution.ts` → the Slack Bot's `executeApprovedIntegrationAction()` flow, established earlier in this session).

# Threat Model

| # | Category | Currently | Classification |
|---|---|---|---|
| A | Payload mutation (channel A→B) | Structurally prevented — `payload` is never `UPDATE`d by any code path | **must invalidate** if this protection is ever removed/bypassed; today's fail-closed subject check makes this explicit rather than accidental |
| B | Argument mutation (amount changes) | Same as A — no mutation path exists today | **must invalidate** |
| C | Action mutation (send→delete) | Same as A; also: `service`/`operation` are part of the same immutable payload | **must invalidate** |
| D | Target mutation (channel X→Y) | Same as A | **must invalidate** |
| E | Provider mapping mutation (adapter injects new default at execution vs. approval time) | **Out of scope for this design** — canonical `input` is what's bound; provider-adapter-injected fields are not part of the canonical Approval subject by design (Provider neutrality). Currently, the one live write mapping (`slack.send_message`) injects no extra semantic fields (confirmed: only field renaming, `text`→`markdown_text`) | **does not invalidate** via this mechanism; must be guarded separately by adapter-level review discipline (see Open Questions) |
| F | Credential mutation (personal→org connection) | `connectionId` already lives inside the same immutable `payload.action.metadata` | **must invalidate** — covered by the same subject-binding mechanism as A–D |
| G | Policy mutation (policy v1→v2 between approval and execution) | **Unguarded today** (see Current Gap) | **must invalidate** — new: capture a risk-class snapshot at approval time, compare at execution |
| H | Context mutation | No Context-read binding exists in the current Approval flow at all (Approval only carries the write-action payload, not a Context snapshot) | **out of scope** for ARCH-P1 — Context Permission is a separate future concern (see `borrowed-patterns.md`'s Context Permission row); noted, not solved here |
| I | Task mutation (plan/metadata changes after Approval) | Execution never re-reads Task fields to reconstruct the action — only `Approval.payload` is used | **does not invalidate** — Task mutation cannot affect what executes, by construction; only Approval.payload can, which is covered by A–D |
| J | Replay (same Approval used for a second execution) | Already defended: `findAlreadyExecutedRun()` dedup | **does not invalidate** (already solved, out of this design's scope to re-solve) |
| K | Cross-Task misuse | Already structurally impossible: `taskId` is never a caller-supplied parameter, always `approval.taskId` | **does not invalidate** (already solved) |
| L | Cross-Work misuse | Already defended: `getApproval(workId, ...)` requires `approval.work_id === workId` plus ownership | **does not invalidate** (already solved) |
| M | Stale approval (environment changed over hours/days) | Partially defended (Connection active-status is re-checked live at execution); `expiresAt` column exists but **no code path ever sets it**, so approvals never actually expire today | **must invalidate** on genuine staleness once expiry is wired (see Open Questions — small, separable fix, not core to this design) |
| N | Partial mutation (hidden argument differs from presentation) | Unguarded today (see Current Gap) | **must invalidate** — this and G are the two genuinely new protections this design adds |

# Approval Subject Definition

```ts
interface ApprovalSubject {
  subjectVersion: number;       // canonicalization schema version, see Canonicalization Strategy
  workId: string;
  taskId: string | null;
  service: string;
  operation: string;
  canonicalInput: Record<string, unknown>;  // the exact `input` that was approved
  connectionId: string | null;              // TACT canonical Connection.id, not a provider ref
  riskClassSnapshot: "read" | "write" | "destructive" | null;
}
```

Decisions, against the ten design questions posed:

1. **Work binding — yes, but not hashed.** Already enforced at the ownership/RLS layer (`getApproval(workId, ...)`). Included in the subject as a plain field for completeness/audit readability, not as a security mechanism in its own right (redundant with existing structural protection).
2. **Task binding — yes, primary binding.** A Run does not exist at Approval-creation time (confirmed above), so Task is the natural, already-live binding level — matching the design brief's own hint.
3. **Run binding — no.** Cannot exist; Runs are created after Approval resolution.
4. **Action identity — `service` + `operation`.** Already the canonical, provider-neutral action identity throughout the codebase (`IntegrationAction`). No change needed, just formalized as part of the subject.
5. **Canonical payload — the `input` object**, exactly as approved, canonicalized (see next section). This is the crux of the whole design.
6. **Provider-specific fields — excluded.** Consistent with "Provider-specific IDs do not define canonical authorization" (Security Invariant 3). See Threat E.
7. **Credential identity — `connectionId` only**, not `providerConnectionRef`. `connectionId` is TACT's own canonical reference; `providerConnectionRef` is resolved fresh, live, at execution time via `getConnection()` and is never stored on the Approval today — pulling it into the subject would require storing a provider-adjacent value earlier than the existing architecture resolves it, and would weaken (not strengthen) the existing "don't trust caller-supplied provider refs" invariant.
8. **Policy version — a lightweight `riskClassSnapshot`, not a formal version number system.** `POLICY_ALLOWLIST` has no versioning today; building one is bigger scope than ARCH-P1 needs. Snapshotting the single field that actually matters (`riskClass`) is the minimum viable answer to Threat G. Formal policy versioning is deferred (see Open Questions and `borrowed-patterns.md`'s ARCH-P2 row).
9. **Expiry — noted, not solved here.** `expiresAt` exists but is unwired; wiring actual expiry-setting is a small, separable fix, not core to subject binding (see Open Questions).
10. **Human-facing presentation vs. machine-bound subject — no new binding mechanism recommended.** `summary` and `input` are already sibling fields built together, in one function call, from the same source variables — structurally correct by construction today. Making this a *tested*, not just *conventional*, guarantee (e.g. templating `summary` mechanically from `input`) is flagged as an Open Question for a later Phase, not required for ARCH-P1's core protection (which is about *storage-time-vs-execution-time* drift, a different axis than *presentation-vs-execution* drift).

# Canonicalization Strategy

**Plain `JSON.stringify(payload)` is not sufficient**, for one concrete, non-hypothetical reason: `input` objects are built as object literals (e.g. `{ channel, text }`) whose key order depends on how the *code that builds them* is written, not on their semantic content. Two logically-identical inputs built by differently-ordered code (a future Capability, a refactor) would `JSON.stringify` to different byte strings, and a naive hash comparison would spuriously reject a legitimate, unmutated re-submission. This is latent, not yet observed, but must not be built into a security check.

Required normalization for `canonicalInput` (and the subject as a whole):
- **Key order**: recursively sort object keys before serialization (a small "stable stringify," not `JSON.stringify` directly).
- **Arrays**: preserve order (array order is semantically meaningful; do not sort).
- **`undefined`**: must not silently vanish via `JSON.stringify`'s default behavior — the canonicalizer should either reject `undefined` values explicitly (fail closed on non-JSON-representable input) or normalize them to an explicit documented rule (recommend: reject, since a `TaskApprovalAction.metadata`/`input` containing `undefined` should never have been constructible in the first place — canonical actions are meant to be JSON-serializable by contract).
- **`null`**: significant, preserved as-is (distinct from absent/`undefined`).
- **Numbers**: standard finite JS numbers serialize deterministically via `JSON.stringify`; no special handling needed beyond documenting that `NaN`/`Infinity` are rejected (already true — they are not valid JSON).
- **Nested objects/arrays**: canonicalization recurses.
- **Unicode**: `JSON.stringify` already produces deterministic UTF-8/UTF-16-safe output; no extra normalization needed.
- **Optional field omission vs. default value**: the canonicalizer should not "fill in" defaults — it captures `input` exactly as the Capability produced it. A Capability that omits a field must consistently omit it in both the approval-time and execution-time reconstruction (which it will, since both derive from the same `Approval.payload` in the current architecture).
- **`subjectVersion`**: pinned into the canonical form itself, so a future change to *what* gets canonicalized (e.g. adding `riskClassSnapshot` handling in a later revision) is distinguishable from a genuine content mismatch. An execution-time comparison against a subject of an unsupported/older version must fail closed rather than attempt a best-effort compare.

**Provider-injected defaults are explicitly out of scope for the hash.** The canonical subject covers only the TACT canonical `input` as approved — never what a Provider Adapter does to it afterward (Composio's toolkit-side defaults, e.g. `limit:100` for the unrelated `list_channels` read). This is a deliberate boundary, not an oversight: Approval Integrity protects the canonical layer; a Provider Adapter injecting an undisclosed *semantically significant* default into a *write* operation is a different failure mode (an adapter-mapping correctness bug), which this design does not claim to catch and which should instead be caught by adapter-level mapping tests (the same discipline already used for `mapComposioListChannelsResultToCanonical()` in this codebase). This boundary is recorded explicitly in Open Questions so it isn't silently assumed solved.

# Binding / Hash Strategy

Evaluated against all eleven listed axes:

| Option | Verdict |
|---|---|
| A. Raw canonical JSON hash only | Rejected — poor debuggability (mismatch tells you *that*, never *what*), and TACT's Audit-first principle wants inspectable records, not opaque digests |
| B. Structured `ApprovalSubject` hash (no version) | Rejected alone — better than A (excludes presentation noise like `summary`/`kind`) but still opaque, and has no story for evolving the subject shape later |
| C. Versioned canonical subject + hash | Good, but hash-only comparison still can't show *which* field diverged |
| D. No hash, exact stored subject comparison | Good on debuggability/auditability/simplicity, but forgoes a cheap single-value tamper-evidence check useful for audit receipts |
| **E. Stored subject + hash, versioned** | **Recommended** |

Why E: TACT's Approval flow is low-throughput and safety/audit-critical, not high-volume — the storage and comparison cost of keeping the full structured subject is negligible, while the benefits are not: **determinism** is a non-issue once canonicalization is deterministic by construction, independent of hashing; **debugging** is best-in-class (an internal diagnostic can report exactly which field changed, without ever surfacing raw payload/hash to the Bot per Security Invariant 12); **migration** is purely additive (new nullable columns); **auditability** is maximized (a human-inspectable record of exactly what was approved, directly useful to the future ARCH-P4 Audit Event Model); **backward compatibility** is handled cleanly (rows without a stored subject fail closed, see Migration Strategy); **schema evolution** is handled by `subjectVersion`; **provider neutrality** is preserved by construction (only canonical fields are ever included); **performance** is trivial at this scale; **operational simplicity** favors field-by-field comparison logic over hash-collision reasoning; **collision concern** is moot (comparison is field-by-field, hash is a convenience, not the sole check); **replay resistance** is unaffected (orthogonal, already solved elsewhere).

**Hash algorithm**: SHA-256 over the canonicalized (sorted-key) JSON string of the versioned subject, via Node's built-in `crypto.createHash('sha256')` — no new dependency, consistent with the existing use of `node:crypto` elsewhere in this codebase (Slack signature verification). Not implemented in this Phase; named here only as the recommended choice for the eventual implementation.

# Lifecycle Semantics

**`INVALIDATED` is not added as an `ApprovalStatus` value.** Recommendation, directly addressing the design brief's own hint: **"the fact that a human approved" and "whether that Approval can currently be used for execution" are different concepts, and should be represented differently.**

- `Approval.status` continues to record the immutable historical fact of the human's decision (`pending/approved/rejected/cancelled/expired`) — this must never be retroactively altered by an execution-time integrity failure. A human who said "yes" to what they were shown really did say yes; rewriting that fact after the fact would corrupt the audit trail, not protect it.
- "Can this Approval currently authorize an execution" is instead an **execution-time, ephemeral judgment**, recorded as a new terminal outcome on the *execution attempt* (extending `IntegrationActionExecutionOutcome`, exactly the same way `approval_not_approved`/`task_not_executable`/`invalid_action` already work today) — not as a mutation of the Approval row.

This keeps `ApprovalStatus` at its current 5 values (no explosion) and keeps the historical record honest, while still making execution refuse to act on drifted content.

# Execution-Time Verification

Slots into the existing `executeApprovedIntegrationAction()` sequence (`core/tact-integration/execution.ts`) at a specific, reasoned position — inserted, not reordering what already exists:

1. Work ownership *(existing)*
2. Approval ownership *(existing)*
3. `Approval.status === "approved"` *(existing)*
4. Work runnable (`status === "running"`) *(existing)*
5. Extract current action from `Approval.payload` *(existing)*
6. Policy re-verification (`riskClass !== "read"`) *(existing)*
7. Connection ownership + active status *(existing)*
8. **Execution dedup (`already_executed`) — unchanged position, checked before the new step.** This ordering is deliberate: if the action already executed successfully, integrity verification is irrelevant to that already-completed side effect and must not spuriously override the correct `already_executed` response (e.g. if a Connection was legitimately rotated *after* a successful send). Preserving `already_executed`'s current precedence is required by Security Invariant 11 ("re-entry after already-approved decision must re-verify integrity" — for genuinely *new* execution attempts, not for reporting on ones that already happened).
9. **Approval Integrity Verification (new)**: canonicalize the action extracted in step 5 using the exact function used at Approval-creation time; compare against the stored `subject_json`/`subject_hash`/`subject_version`. Any of: missing stored subject, unsupported version, or field mismatch → new outcome `approval_subject_changed`. **Zero provider calls, zero Run creation** on this path — consistent with every other pre-flight rejection in this boundary (`work_not_runnable`, `connection_unavailable`, `invalid_action`, `task_not_executable` none of them create a Run either; a rejected pre-condition is not a Run under TACT's own definition of Run as "one execution attempt" — no attempt occurred).
10. Task-state precondition (`pending`) *(existing, inside the shared core)*
11. Create Run, dispatch to provider *(existing)*

# Re-approval / Supersession

Under the current, audited architecture, `Approval.payload` cannot actually drift via any existing code path — this section is deliberately forward-looking defense, not a fix for an observed bug, and the recommendation reflects that:

- On integrity failure, **do not auto-create a replacement Approval.** Auto-creating one would reintroduce an implicit-approval risk (a system silently re-proposing an action without a fresh human decision). The safe default is: the failed attempt is recorded (via the new outcome status; a proper Audit Event is ARCH-P4's job, not this Phase's), `Approval.status` stays `approved` (historically accurate), and any future re-proposal requires an explicit new `requestApproval()` call triggered by whatever business logic detected the drift.
- A new Approval created this way **may** carry an optional `supersedes_approval_id` pointing at the old one, purely for audit-trail readability — not for any automatic authority transfer. Recommended as a deferred, optional schema addition (see Schema Draft), not required for the P1 minimum.
- **No automatic reuse/dedup of identical-content Approvals is proposed.** `requestApproval()` always creates a new row today; this design does not change that. Duplicate-approval-spam prevention across Turns is flagged honestly as an **Open Question** — this audit did not fully verify whether a second Conversation Turn could re-decompose and create a duplicate Task+Approval pair for the same underlying request while the original Task is still `pending` awaiting Approval. Not asserting an answer here would be more honest than guessing.
- Policy-only or credential-only changes (no `input` change) are still treated as full integrity failures — fail-closed uniformity over cleverness, matching TACT's stated default and avoiding status/branch explosion.

# Anti-Self-Approval Boundary

**Already substantially satisfied by the existing actor trust boundary — assessed, not newly designed.**

- `receiveBotApprovalDecision()` always resolves the external Slack actor through `identityResolver.resolve()` to a server-verified `tactUserId` before any decision function is called (`core/tact-bot/gateway/receiveApprovalDecision.ts:175`). The raw external actor id is never used as the deciding identity.
- `Approval.requestedByActor` is always `{kind: "ai", id: capability}` for orchestrator-proposed actions (`core/tact-work/execution.ts:577`) — the proposer is explicitly, permanently recorded as non-human.
- `Approval.requestedFromActor` is always `{kind: "user", id: userId}` — the Work owner — and `approveApproval()`/`rejectApproval()` are only reachable with an ownership-verified `userId` (via `getApproval(workId, userId, ...)`).
- There is no code path anywhere in the repository where a Capability, the Orchestrator, or an LLM call itself resolves an Approval it proposed.

**The gap is that this is an emergent property of the current call graph, not a checked invariant.** Nothing would catch a future bug (a new internal automation hook, a batch-approval admin tool) that called `approveApproval()`/`rejectApproval()` with a system/AI actor context.

**Recommendation (ADOPT PATTERN, small, provider-neutral addition)**: add an explicit guard inside `approveApproval()`/`rejectApproval()` in `core/tact-work/approval.ts` — the canonical, channel-agnostic layer already used identically by today's Bot path and any future Web/Teams/API decision path — asserting the resolving actor is not `kind === "ai"`/`"system"` and is not the same actor recorded as `requestedByActor`. Because this lives in `core/tact-work/`, not `core/tact-bot/`, it automatically covers every future decision channel without per-channel duplication — directly satisfying "Provider-specific IDs do not define canonical authorization" and keeping this a canonical-layer decision, never a provider adapter's.

# Schema Draft

Proposed additive columns on `tact_approvals` (non-destructive; existing rows get `NULL` in all new columns):

| Column | Required/Nullable | Purpose | Source of Truth | Backward Compat | Migration Impact | Necessary now? |
|---|---|---|---|---|---|---|
| `subject_version` | nullable `integer` | Canonicalization schema version tag | Set at Approval creation by the capturing code | `NULL` = pre-P1 approval, treated as unsupported (fail closed) | `ALTER TABLE ... ADD COLUMN`, zero risk | **Yes — P1a minimum** |
| `subject_json` | nullable `jsonb` | The stored canonical `ApprovalSubject`, exactly as approved | Written once at creation, never updated | `NULL` = fail closed at execution time | Same, zero risk | **Yes — P1a minimum** |
| `subject_hash` | nullable `text` | SHA-256 hex digest of the canonicalized subject; tamper-evidence/audit convenience | Derived from `subject_json` at write time | `NULL` = fail closed | Same, zero risk | **Yes — P1a minimum** |
| `subject_captured_at` | nullable `timestamptz` | When the subject was captured (expected ≈ `requested_at`, kept explicit for future-proofing) | Set alongside the above | `NULL` for old rows, harmless | Same, zero risk | Recommended, low cost |
| `supersedes_approval_id` | nullable `uuid references tact_approvals(id)` | Optional audit-trail lineage for re-approval (Step 8) | Set only if/when a re-proposal flow is built | Fully optional | Same, zero risk | **Deferred** — no current feature produces this scenario |
| `invalidated_at` / `invalidated_reason` | — | Considered and **rejected** for this design | — | — | — | **Not adding** — this is exactly the "status vs. fact" conflation the design brief warned against; the equivalent information belongs on the execution outcome / future Audit Event, not as a mutation annotation on the Approval row itself |

No changes to existing columns. No changes to RLS policies (new columns inherit the existing row-level policy automatically since Postgres RLS is row-scoped, not column-scoped).

# Type / API Draft

Proposed to live in `core/tact-work/` (not `core/tact-integration/`), because Approval Integrity must protect *any* future protected-write Capability using the existing generic `TaskApprovalAction`/`ApprovalActionDescriptor` shape (`core/tact-orchestrator/task.ts`), not only Integration/Composio actions. `core/tact-integration/execution.ts` already depends one-directionally on `core/tact-work/` — this fits the existing dependency direction without introducing a new one.

New file (proposed name, not final): `core/tact-work/approvalIntegrity.ts`.

```ts
// Pure, no DB access — mirrors the existing style of toApprovalPayload()
// and extractIntegrationActionFromApproval().

function buildApprovalSubject(
  action: ApprovalActionDescriptor,
  context: { workId: string; taskId: string | null; connectionId?: string | null; riskClassSnapshot?: IntegrationRiskClass | null }
): ApprovalSubject;

function canonicalizeApprovalSubject(subject: ApprovalSubject): string;   // deterministic, sorted-key JSON

function hashApprovalSubject(canonicalJson: string): string;              // SHA-256 hex

type ApprovalIntegrityResult =
  | { ok: true }
  | { ok: false; reason: "subject_missing" | "subject_version_unsupported" | "subject_mismatch"; mismatchedFields?: string[] };
  // mismatchedFields: internal diagnostics only — never surfaced to a Bot/user-facing message (Security Invariant 12)

function verifyApprovalIntegrity(
  storedSubject: { version: number | null; json: Record<string, unknown> | null; hash: string | null },
  currentAction: ApprovalActionDescriptor,
  currentContext: { workId: string; taskId: string | null; connectionId?: string | null; riskClassSnapshot?: IntegrationRiskClass | null }
): ApprovalIntegrityResult;
```

`core/tact-integration/execution.ts` would call `verifyApprovalIntegrity()` with data it already has at that point in the sequence (no new DB queries required beyond reading the already-fetched `Approval` row, which would now include the new columns via the existing `getApproval()`/`toApproval()` mapping). Provider adapters (`core/tact-integration/providers/composio/**`) are never imported by, or aware of, this module — matching the explicit instruction that Provider Adapters must not make this judgment.

# Compatibility Analysis

- **`integration.slack.send_message`**: the only currently-implemented protected write; directly exercised by this design, also its primary test case.
- **approve/reject**: unaffected — `approveApproval()`/`rejectApproval()` never read `payload` and are not touched by subject verification, only by the separately-recommended anti-self-approval guard (additive, does not change existing signatures or return types).
- **`already_resolved` + approved re-entry**: remains safe — re-entry still flows through `executeApprovedIntegrationAction()`, dedup is checked *before* the new integrity step (see ordering above), so a legitimately-already-executed Approval still returns `already_executed` correctly even under future subject drift.
- **`executeApprovedIntegrationAction()`**: gains one new internal step and one new outcome value (`approval_subject_changed`); existing outcomes, signatures, and the 9-step responsibility comment are otherwise unchanged.
- **Dedup**: unaffected, explicitly preserved by construction (see above).
- **Task lifecycle**: unaffected — a mismatch produces zero Task-state changes (Task remains `pending`, matching the existing behavior for every other pre-flight rejection in this boundary).
- **Work completion reconciliation**: unaffected — `reconcileWorkCompletionStatus()` is only called after a Run completes/fails; an integrity mismatch creates no Run, so reconciliation is not invoked for that attempt (Work stays `running`, awaiting either a fresh human decision or another Turn).
- **Bot approval presentation** (`toBotRequestApprovalAction()`): unaffected — still built from `approval.payload.action.summary`, which this design does not change.
- **Bot decision receiver** (`receiveBotApprovalDecision`/`handleApprovalDecisionAsTrustedActor`): gains exactly one new `switch` case in `buildExecutionAckMessage()`, following the exact existing pattern.
- **Conversation flow**: unaffected — this boundary is entirely below the Conversation layer.
- **Future non-Slack protected writes**: directly benefit without extra work, since the design lives at the generic `core/tact-work/` layer, not inside Integration/Composio-specific code.

# Failure Semantics

**One new outcome, not five.** Directly heeding the instruction to avoid status explosion: `approval_subject_changed` is the only new value added to `IntegrationActionExecutionOutcome`. The other candidate names from the design brief (`approval_mismatch`, `approval_stale`, `approval_invalidated`) all collapse into this single outcome — they'd be internal `reason` sub-classifications inside `ApprovalIntegrityResult`, never separate top-level statuses. `approval_expired` needs no new outcome at all: once expiry is wired (Open Questions), `Approval.status` simply becomes `"expired"`, which the *existing* step 3 check (`status !== "approved"`) already correctly routes to the *existing* `approval_not_approved` outcome with `approvalStatus: "expired"` attached.

**Bot-facing message** (extending `buildExecutionAckMessage()`'s existing `switch`, `core/tact-bot/gateway/receiveApprovalDecision.ts:122-162`, same pattern, no raw payload/hash/provider detail):

```ts
case "approval_subject_changed":
  return "承認後に実行内容が変更されたため、再度ご確認をお願いします。";
```

Wording is a design-time suggestion only, not final copy.

# Test Plan

Mapped against the 22 required cases, targeting `tests/tact/integration/execution.test.ts` (existing file, already covers the surrounding boundary):

1. Exact same action → execute normally (regression: existing "happy path" tests must still pass unmodified)
2–4. Payload/target/action changed → `approval_subject_changed`, provider call count 0, Run count 0
5–6. Cross-Task / cross-Work Approval reuse → already covered by *existing* tests (ownership/`not_found`), assert they remain unaffected by the new step
7. Exact duplicate execution → existing `already_executed` dedup semantics unchanged (assert integrity check is not even reached / does not override dedup)
8. Approved re-entry, unchanged subject → succeeds (or correctly reports `already_executed`)
9. Approved re-entry, changed subject → `approval_subject_changed`
10. Canonical key-order difference (`{channel,text}` vs `{text,channel}`, same content) → treated as identical (canonicalizer determinism test)
11. `null` vs. omitted-field semantics → explicit, documented, tested distinctly
12. Provider-injected non-semantic default → not part of canonical subject, does not affect the check (documents the Threat E boundary)
13. Provider-injected semantic default (write-path) → explicitly noted as **out of scope** for this mechanism; test would document the boundary, not claim protection
14. Credential/connection owner changed → `approval_subject_changed`
15. Policy version/riskClass changed → `approval_subject_changed`
16. Expired Approval → existing `approval_not_approved` path (once expiry is wired; otherwise documents current no-op)
17. Old Approval superseded → out of scope for P1 core (deferred feature); no test required until built
18. Rejected Approval never executes → existing behavior, unaffected, regression-only
19. Malformed stored subject (`subject_json` present but doesn't parse as expected shape) → fail closed, `subject_mismatch` or equivalent, never a silent pass
20. Missing/unsupported `subject_version` (pre-P1 approval) → fail closed, `subject_missing`/`subject_version_unsupported`
21. Bot never receives raw hash/payload → assert `buildExecutionAckMessage()`'s new case emits only the fixed string, nothing dynamic
22. Provider call count = 0 on any integrity failure path → asserted alongside every mismatch test above (mirrors the existing pattern already used for `work_not_runnable`/`connection_unavailable`/etc.)

# Migration Strategy

Three-step rollout, each independently deployable and testable, chosen specifically so verification logic never assumes data that doesn't exist yet:

1. **Schema only** (P1a): add the four new nullable columns. No application code reads or writes them yet. Zero behavioral change, zero risk to existing data or flows.
2. **Capture** (P1b): `requestApproval()`/`createApproval()` start populating `subject_version`/`subject_json`/`subject_hash`/`subject_captured_at` on every *new* Approval. Existing (already-created) Approvals remain untouched (still `NULL`). No execution-time behavior change yet — still purely additive.
3. **Verification** (P1c): `executeApprovedIntegrationAction()` starts calling `verifyApprovalIntegrity()`. Any Approval lacking a stored subject (i.e., anything created before P1b shipped) is treated as `subject_missing` → fails closed. Given this is a low-volume, single-workspace pilot today, the number of genuinely affected in-flight `pending`/`approved`-but-not-yet-executed Approvals at deploy time is expected to be small to zero; this is an accepted, explicit transition cost, not a silent regression, and should be called out at deploy time.

No destructive migration at any step. No column is ever removed or repurposed.

# Security Invariants

Restated from the design brief, each mapped to how this design satisfies it:

1. **Approval never authorizes a mutated subject.** → Execution-time `verifyApprovalIntegrity()` compares live-extracted action against the stored, versioned, hashed subject before any provider call.
2. **Approval is bound to canonical TACT action semantics, not UI text.** → The subject binds `service`/`operation`/`canonicalInput`/`connectionId`, never `summary` (the UI text) — `summary` display is unaffected and un-relied-upon for security.
3. **Provider-specific IDs do not define canonical authorization.** → Subject fields are exclusively canonical TACT types (`IntegrationService`, `connectionId` as TACT's own reference); no `providerConnectionRef`, tool slug, or other provider-specific identifier is ever part of the subject.
4. **Integrity verification occurs before provider side effect.** → Ordered immediately before Task-state precondition and Run creation, strictly before `executeIntegrationActionCore()`'s provider dispatch.
5. **Integrity mismatch fails closed.** → `approval_subject_changed` on any mismatch, missing subject, or unsupported version; no ambiguous "maybe OK" path.
6. **Integrity mismatch never auto-approves.** → No new Approval is auto-created; a fresh explicit human decision is required (Re-approval section).
7. **LLM/Agent/Tool cannot self-approve.** → Assessed as already substantially satisfied; hardened further by the recommended explicit actor-kind guard in `approveApproval()`/`rejectApproval()`.
8. **Approval for one Task cannot authorize another Task.** → Already structurally guaranteed (`taskId` is never caller-supplied, always `approval.taskId`); unaffected by this design, confirmed unchanged.
9. **Approval for one Work cannot authorize another Work** (if Work binding is adopted). → Work binding is adopted (subject includes `workId`); already independently enforced at the ownership layer too (defense in depth).
10. **Provider call count = 0 on integrity failure.** → Verification is inserted strictly before Connection dispatch/Run creation; no code path reaches the provider after a mismatch is detected.
11. **Re-entry after already-approved decision must re-verify integrity.** → Every non-dedup-shortcut execution attempt re-runs `verifyApprovalIntegrity()` fresh; nothing is cached across calls.
12. **Secrets must never be included in approval subject hash material; hash inputs must avoid secret leakage into audit/debug paths.** → Subject fields are exclusively canonical, non-secret values (`service`/`operation`/`input`/`connectionId` — a logical reference, never a token); `mismatchedFields` (internal diagnostic detail) is explicitly scoped to never reach the Bot-facing message, matching the existing `buildExecutionAckMessage()` discipline of surfacing only a fixed enum-driven string.

# Open Questions

1. **Policy versioning**: lightweight `riskClassSnapshot` (recommended for P1) vs. a formal `POLICY_ALLOWLIST` version-numbering system (bigger scope, likely ARCH-P2 territory — see `borrowed-patterns.md`).
2. **Expiry wiring**: `expiresAt` is a small, separable fix (nothing currently sets it). Bundle into ARCH-P1 for coherence, or file as its own tiny fix? Recommend deciding at Phase-kickoff time, not in this design.
3. **Cross-Turn duplicate Task/Approval creation**: whether a second Conversation Turn can create a duplicate pending Task+Approval for the same underlying request while the first is still awaiting decision. **Not verified in this audit** — flagged honestly rather than guessed at.
4. **Structured/templated `summary` generation**: whether a future Phase should make the presentation↔input binding mechanically testable (e.g. template `summary` from `input`) rather than relying on "built in the same function call." Not required for ARCH-P1.
5. **Exact placement/naming** of `verifyApprovalIntegrity()` and friends (`core/tact-work/approvalIntegrity.ts` proposed, not final) — implementation-time decision.
6. **`supersedes_approval_id` / re-approval flow**: deferred entirely; no current feature produces the scenario that would need it. Revisit if/when an "edit and resubmit" UI is proposed.
7. **Provider-adapter semantic-default injection** (Threat E boundary): explicitly out of this design's protection; needs its own adapter-review discipline, not solved by hashing the canonical layer.

# Recommended Implementation Plan

**Split into P1a / P1b / P1c — recommendation is B, not A.**

Reasoning: P1c touches the live execution boundary of an already-shipping production flow (`executeApprovedIntegrationAction()`). Bundling schema, capture, and verification into a single change makes it materially harder to isolate a regression if the new verification step behaves unexpectedly in production, and departs from the Phase discipline this session has used successfully throughout (S1a/S1b/S1c, C2.1c-a/b/c, C2.2/C2.2a/b/c) — each of those splits let a Phase be independently tested, reported, and checkpointed before the next one touched anything riskier. The same reasoning applies here, more so, because P1c is the one Phase in this whole design that can actually change behavior for real, already-flowing traffic.

- **P1a** — Schema (four additive nullable columns) + pure canonicalization/hashing functions + their unit tests. Zero behavioral change. Fully revertible by simply not calling the new functions.
- **P1b** — Wire subject *capture* into `requestApproval()`/`createApproval()`. New Approvals get a stored subject; old ones don't. Still zero execution-time behavior change — verifiable purely by inspecting newly-created Approval rows/test fixtures.
- **P1c** — Wire *verification* into `executeApprovedIntegrationAction()`, add the new outcome, add the Bot message case, flip fail-closed behavior on for approvals lacking a stored subject. This is the only Phase that changes what a live request can do, and should ship alone, with focused regression testing against every existing `integration/execution.test.ts` case plus the new cases from the Test Plan above.

# Scope and Status

This document is the entire deliverable of this Phase. No file outside `docs/architecture/approval-integrity.md` (and this cross-reference note in `borrowed-patterns.md`, if added) was created or modified. No production code, migration, dependency, or test file was changed. No external API, Supabase, Slack, or Vercel call was made while producing this document.
