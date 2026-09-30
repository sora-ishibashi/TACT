# Runs v1 — Observation-First Connection Strategy — SOR-131

Status: formalization of already-implemented, already-verified behavior. This document introduces no new runtime, no new SaaS adapter, and no new `ExecutionProvider` value. Every claim below is grounded in code merged to `main` (SOR-129, SOR-130, SOR-14) at commit `37dcb92f27c868f16df79d4e402953a714daea3b`, and every verification claim is grounded in `tact_execution_observation_registry` (SOR-14), which this document treats as the single source of truth.

**Naming note**: this repository already has a document named [`tact-runs-boundary.md`](./tact-runs-boundary.md) ("TACT Runs Boundary — ARCH-RUNS-1"). That document is about a *different* concept that happens to share the word "Runs": the internal execution-attempt lifecycle for Capability/RuntimeAdapter dispatch (`tact_runs` table, Trigger.dev/Composio routing, `core/tact-integration/`, `core/tact-runtime/`, `core/tact-work/`). It never mentions Canonical Execution, the Observation Gateway, or `core/tact-execution/`, and this document never mentions `tact_runs` or RuntimeAdapter dispatch. The two documents describe non-overlapping subsystems that both happen to use the word "Runs." Do not conflate them.

---

## 1. Purpose

Formally fix, as v1 policy, the connection strategy that SOR-129 (Generic Observation Gateway), SOR-130 (live Reality Tests across Notion/Slack/GitHub), and SOR-14 (Integration & Observation Registry) already established through working, tested code — so that future work (starting with SOR-131's own follow-ups, and eventually SOR-31/SOR-33) has one canonical statement of what Runs v1 actually does, instead of that policy existing only implicitly, split across adapter comments and migration files.

This is **not** an issue about adding new connectors. TACT does not compete on the number of supported SaaS products. It formalizes *how* a connection is judged ready, not how many connections exist.

## 2. Non-goals (binding for v1)

No new SaaS adapter. No new `ExecutionProvider` enum value (GitHub's `provider="custom"` + `provider_label="github"` workaround is a known, deliberately-kept gap — see §9). No new migration (SOR-14's schema already expresses everything this document formalizes). No Execution Router. No "Connector Catalog" UI or marketing surface. No change to `core/tact-execution/permission/`, `core/tact-execution/correlation/`, or `core/tact-orchestrator/` — these already contain zero provider-specific branching, which this document treats as a **standing invariant**, not a goal to achieve. No change to `core/tact-work/`'s pre-existing `"slack"|"notion"|"gmail"` string-literal branching in its delegated-completion / organizational-context-resolution code (`execution.ts`, `delegatedCompletion.ts`, `gmailReplyProposal.ts`, `approvalIntegrity.ts`, `store.ts`) — that is a different, pre-existing subsystem unrelated to Canonical Execution, out of this document's scope, and not touched here.

## 3. The ten basic principles (formalized)

1. **Runs does not compete on SaaS count.** A larger `ExecutionProvider` enum is not a v1 goal. Depth of observation on a small number of paths beats breadth of shallow "connected" badges.
2. **Observe the Execution Path first.** Before asking "can TACT act on this SaaS," Runs asks "can TACT observe what already happened or is happening on this SaaS." Action orchestration is downstream of observation, not a prerequisite for it.
3. **SaaS differences are absorbed by the Observation Adapter / Semantic Mapper layer**, never by Core. Concretely: `core/tact-execution/adapters/*/normalize*.ts` files are the only place provider-specific shapes are read. (The "Semantic Mapper" as a *named, dedicated contract* is SOR-33's scope, not yet started — see §8.) **The default when adding a new SaaS is path connection + semantic mapping into Canonical Execution — not building a full native connector/execution integration first.** A new provider earns Registry rows by proving one or more observation paths (a `normalize*.ts` + Reality Test), the same way Notion/Slack/GitHub did; it does not require, or default to, a complete native execution/action integration before it can be observed.
4. **Everything normalizes into Canonical Execution.** `core/tact-execution/store.ts`'s `tact_canonical_executions` (SOR-50, frozen v1 contract per SOR-45) is the only persisted shape for "an external action happened." There is no per-provider table.
5. **Permission, Work Correlation, and Attention own no provider-specific branch.** Verified directly in code for v1: `core/tact-execution/permission/*.ts` and `core/tact-execution/correlation/*.ts` contain zero `provider === "..."` conditionals or provider-name string literals. This is confirmed as a standing fact, not merely a design intention.
6. **Native SaaS audit-log/API access is a complement, never a prerequisite.** `observationMode: "reconciled"` (webhook/event/poll) is a first-class, permanent tier — not a fallback awaiting a "real" API. GitHub and Notion in v1 use direct API calls (`instrumented`); Slack's inbound path uses `reconciled`. Both tiers are equally legitimate Runs v1 citizens. **Not requiring a premium audit-log plan does not mean bypassing the provider's own access rules.** Every observation path must still go through the provider's normal API permissions, OAuth/auth scopes, licensing terms, and account/eligibility requirements — the same real credential path already used by `tact_connections` and the SOR-130 Reality Tests (Composio-managed OAuth for Notion/Slack, a user-provided fine-grained PAT for GitHub). "Audit-log optional" is a statement about which *tier of API* Runs requires, never license to route around what a provider actually permits.
7. **Unverified is never reported as supported.** `verification_status` has exactly three values (`live_verified` / `mock_only` / `unverified`) and defaults to `unverified`. Nothing is promoted to `live_verified` without an actual Reality Test (SOR-130-style, real credentials, real external API, queried-back persisted row). Google Workspace and CRM (Salesforce/HubSpot) have **zero rows** in the Registry, by design — not "unverified" rows, no rows at all, because their action surface itself is unknown (see SOR-14 migration comment, §5).
8. **A missing Work ID carrier is a normal state, never a fabricated one.** `work_context_carrier` defaults to `'none'`. `'explicit_claim'` is reserved for a path that *currently, in production*, has a legitimate, operating mechanism for carrying a real Work ID (today: only Notion, via SOR-53 Path A). A field merely being typed as accepting an optional `workId` does not qualify — this exact conflation was caught and corrected during SOR-14 landing review for `slack-app-mention-v1` (was wrongly `explicit_claim`, corrected to `none`; see SOR-74/SOR-95 product truth: production Slack has no legitimate explicit carrier yet, and the real carrier design is SOR-95's scope, not invented here).
9. **Permission-policy availability and observation availability are different questions, tracked separately.** The Registry never stores whether a permission policy is configured for a provider — `permissionPolicyConfigured` is computed at read time from `tact_execution_permission_rules` (`core/tact-execution/registry/store.ts`). GitHub's `permission_status = "unknown"` (no policy configured for it yet) is not, and must never be read as, an observation failure. These are independent facts and the schema keeps them independent.
10. **Execution capability is not Runs v1's responsibility.** Whether TACT can *act on* a SaaS (send a message, create a page) on an agent's behalf is SOR-31's scope (Yolna-side Model/Agent/Tool execution capability registry) — a different, not-yet-started ticket. Runs v1 (SOR-14's Registry) answers only "what can be observed," never "what can be done."

## 4. Runs v1 observation priority (formal ordering)

```
1. INLINE        — Runs observes directly, synchronously, in the execution path itself.
2. INSTRUMENTED  — Runs' own code explicitly wraps the real provider call (SDK / MCP / wrapper).
3. RECONCILED    — Runs discovers the action after the fact (webhook / event / poll / audit log).
4. Browser/Desktop observation — deferred. Not v1. No code exists for this tier today.
```

This ordering is a **preference order for future adapter work**, not a hierarchy of legitimacy — a `reconciled` path can be just as `live_verified` as an `instrumented` one. The only `reconciled` path in the Registry today, `slack-app-mention-v1`, happens to be `mock_only`, but that is because it is not wired into the production webhook route, not because `reconciled` is a lesser tier. When building a new observation path, prefer the highest tier that is honestly achievable; do not force a lower-fidelity tier's data into pretending to be a higher tier.

No adapter uses `inline` today. This is stated directly in `core/tact-execution/types.ts`'s own comment on `ExecutionObservationMode`: `"inline"` is "a contract slot for a future genuine runtime-dispatch path; no adapter uses this mode today." This document does not change that.

As a machine-readable artifact, `core/tact-execution/registry/types.ts` exports `OBSERVATION_MODE_PRIORITY_V1` — the ordered 3-tuple `["inline", "instrumented", "reconciled"]` — so this ordering is available to code (e.g. future SOR-131-follow-up tooling that ranks observation paths), not only to prose.

## 5. The ten formal metrics (Registry column mapping)

Every metric below is a column (or a store-layer derived field) on `tact_execution_observation_registry` / `ObservationCapabilityWithPermissionInfo` (`core/tact-execution/registry/types.ts`). This document does not introduce new metrics — it names the ten that already exist as the official v1 dashboard for "is this path ready."

| # | Metric | Registry column / derivation |
|---|---|---|
| 1 | Observable execution-path coverage | row existence, keyed by `(provider, provider_label, observation_path, action_category)` |
| 2 | Verification status | `verification_status` (`live_verified` / `mock_only` / `unverified`) |
| 3 | Observation mode | `observation_mode` (`inline` / `instrumented` / `reconciled` / `null`) |
| 4 | Action normalization coverage | the set of `action_category` rows present per `observation_path` (partial coverage is a first-class, expected shape — see Slack) |
| 5 | Principal attribution confidence | `principal_attribution_available` + `principal_attribution_confidence` |
| 6 | Agent attribution confidence | `agent_attribution_available` + `agent_attribution_confidence` |
| 7 | Work context carrier availability | `work_context_carrier` (`none` / `explicit_claim` / `reconciled_correlation`) |
| 8 | Permission pre-check availability | **not stored** — `permissionPolicyConfigured`, derived at read time by `core/tact-execution/registry/store.ts` from `tact_execution_permission_rules` (kept independent per principle 9) |
| 9 | Reconciliation availability | `reconciliation_available` |
| 10 | Privacy characteristics | `excludes_raw_payload` + `privacy_notes` + `credential_custody` |

`GET /api/tact/execution/observation-registry` (`app/api/tact/execution/observation-registry/route.ts`) is the read boundary that already anticipates this document — its own header comment states it is "SOR-131が読む前提のoutput" (built for SOR-131 to read), not an Execution Router and not a Connector Catalog.

## 6. SOR-130 evidence, as formally adopted v1 baseline

This is the actual, current content of `tact_execution_observation_registry` (10 rows, `supabase/migrations/20261105000000_create_tact_execution_observation_registry.sql`). Nothing here is aspirational.

| Provider | Observation path | Actions | Mode | Verification | Work carrier | Notes |
|---|---|---|---|---|---|---|
| Notion | `notion-mcp-v1` | read, create, update, delete | instrumented | **live_verified** (all 4) | `explicit_claim` | Only path with a real, operating Work ID carrier (SOR-53 Path A) |
| Slack | `slack-web-api-v1` | read | instrumented | **live_verified** | none | real `auth.test` call |
| Slack | `slack-web-api-v1` | send | instrumented | **unverified** | none | adapter exists, mock-tested only; no approved live test channel at SOR-130 time |
| Slack | `slack-app-mention-v1` | create | reconciled | **mock_only** | none | not wired into the production webhook route; unit-tested only |
| GitHub | `github-issue-v1` (`provider=custom`, `provider_label=github`) | read, create, update | instrumented | **live_verified** (all 3) | none | `provider="custom"` is a known, kept gap (§9); `permission_status=unknown` because no policy is configured for GitHub yet — an independent fact from the above, per principle 9, never conflated with observation failure |
| Google Workspace (Gmail/Calendar/Drive) | — | — | — | **no rows** | — | no credentials, no adapter code; absence, not an `unverified` row, is the honest representation |
| CRM (Salesforce/HubSpot) | — | — | — | **no rows** | — | same as above |

This table is generated from, and must be kept consistent with, live queries against `tact_execution_observation_registry` — it is not a separate source of truth. If the Registry's seed data changes, this table must be updated to match, not the other way around.

## 7. Adopted for v1 / not adopted / deferred

**Adopted for v1:**
- The 5-way separation of concerns (observation capability / permission-policy availability / execution capability / verification status / per-action coverage) — SOR-14's design, now official policy.
- The three-tier observation-mode ordering (inline > instrumented > reconciled), with Browser/Desktop explicitly out of scope.
- SOR-14's Registry as the single source of truth for "is this path ready," superseding any ad hoc "is this SaaS connected" framing for Runs purposes.
- `tact_connections`' connection-status (`pending`/`active`/`failed`/`revoked`) remains a legitimate, separate concept — it answers "is there a live OAuth/credential," not "what can be observed." Both concepts coexist; neither replaces the other.

**Not adopted for v1:**
- Any `ExecutionProvider` enum expansion (including adding `"github"` as a first-class value) — deferred to SOR-45's scope, not decided here.
- Any Execution Router or capability-dispatch mechanism — that is SOR-31's scope, not Runs'.
- Any dedicated "Semantic Mapper" contract module — SOR-33's scope; today, normalization logic lives ad hoc inside each `normalize*.ts` adapter file, which is sufficient for v1's three providers and is not being refactored by this document.

**Deferred (explicitly out of v1, with an owner):**
- Browser/Desktop observation — no owner ticket yet.
- Slack SEND live verification — needs an approved test channel; SOR-130 follow-up, not this document.
- Slack production webhook wiring for `slack-app-mention-v1` (currently `mock_only`) — a one-line fire-and-forget wiring change, deliberately deferred since SOR-50, still deferred here.
- A real, legitimate Slack explicit Work ID carrier — SOR-95's scope.
- GitHub's `provider="custom"` workaround — SOR-45's scope to resolve (or explicitly decide not to).
- Google Workspace / CRM adapters — no owner ticket yet; credentials do not exist.

## 8. Responsibility boundaries (SOR-14 / SOR-31 / SOR-33 / SOR-45)

- **SOR-14** (this Registry): owns the question "what can be observed, how, and how confidently has that been verified" for Runs. Implemented, merged, this document's primary grounding.
- **SOR-31** (Yolna-side, not started): owns "what can Yolna's Model/Agent/Tool actually *execute*" — a different registry, for a different consumer, about a different verb (execute vs. observe). Zero code or docs exist for it in this repository today (verified by full-repo and git-log search) — it is referenced only as a forward-pointing scope-boundary comment inside SOR-14's own files (`core/tact-execution/registry/types.ts`, the SOR-14 migration). This document does not create SOR-31 content and does not narrow its future scope beyond restating that boundary.
- **SOR-33** (not started): owns a dedicated, named "Semantic Mapper / Observation Adapter" common contract — i.e., a shared abstraction over the pattern each `normalize*.ts` file currently implements ad hoc. Zero code or docs exist for it today. This document does not build that abstraction; it only names where SaaS differences are absorbed today (§3.3) as the future seam SOR-33 would formalize.
- **SOR-45** (Canonical Execution v1, frozen): owns the `tact_canonical_executions` schema itself, `ExecutionProvider`, `ExecutionActionCategory`, `ExecutionObservationMode`. This document treats that contract as frozen and proposes no change to it. The "frozen v1 contract" statement previously existed only inside the SOR-14 migration file's comments (`supabase/migrations/20261105000000_...sql`); this document is now the second, doc-level place that states it, for discoverability.

## 9. Known, deliberately kept gaps

- **GitHub has no first-class `ExecutionProvider` value.** It is represented as `provider="custom"` + `provider_label="github"`. This is not an observation failure and not a bug — it is an honest gap, explicitly deferred to SOR-45. Do not "fix" it by adding `"github"` to the enum as a side effect of unrelated work; that decision belongs to SOR-45.
- **`core/tact-work/` contains pre-existing `"slack"|"notion"|"gmail"` provider-literal branching** in its delegated-completion / organizational-context-resolution code (unrelated files: `execution.ts`, `delegatedCompletion.ts`, `gmailReplyProposal.ts`, `approvalIntegrity.ts`, `store.ts`). This predates and is unconnected to Canonical Execution / the Observation Gateway. It does not violate principle 5 (which is scoped to `core/tact-execution/permission/` and `core/tact-execution/correlation/`, both confirmed clean). It is out of this document's scope and is not touched here.

## 10. What would invalidate this document

If any of the following becomes true, this document must be revised, not silently ignored:
- A new adapter is added whose normalizer branches inside `core/tact-execution/permission/` or `core/tact-execution/correlation/` (violates principle 5, a standing invariant this document asserts is currently true).
- Any Registry row's `verification_status` is set to `live_verified` without a corresponding real Reality Test that queried back the persisted row (violates principle 7).
- Any adapter sets `work_context_carrier: 'explicit_claim'` for a path with no actual, currently-operating production carrier (the exact mistake this document's §3.8 documents having already been caught and fixed once).
