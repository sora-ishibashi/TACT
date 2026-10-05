# Yolna → Runs Governance Transport (SOR-138)

Status: describes the current, live, root-side (Yolna/TACT) half of the SOR-138
Runs Governance transport, as actually implemented through Slice 3A-2. This is
an operator/architecture reference, not a design proposal — it records what
exists today and the non-claims below, nothing more.

This document is the canonical **root-side** counterpart to this slice. It is
deliberately a separate document from
[`tact-runs-boundary.md`](./tact-runs-boundary.md): that document is about the
historical/internal **TACT Runs** design boundary (Work/Run/Task responsibility
separation inside TACT itself), a different concept from the standalone
**Yolna Runs** governance product this document describes. Do not merge the
two — see that document's own Section 1 for the distinction it draws.

## 1. Current live scope

Exactly one governed action exists today:

```
service:   slack
operation: list_channels
```

No other Slack operation and no other service is governed by this transport.
Extending scope to any other action is a deliberate future change (Slice 3A-3,
3B, or later), not an incidental side effect of this slice.

## 2. Feature gate

```
RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED
```

- **Default: OFF.** Only the exact string `"true"` enables the gate — any
  other value, including unset, `"TRUE"`, `"1"`, or a value with surrounding
  whitespace, leaves governance disabled and preserves the exact pre-3A-2
  execution path (see `core/tact-integration/execution.ts`'s
  `isRunsGovernanceSlackListChannelsEnabled()`).
- When disabled, `executeReadIntegrationAction()` takes the exact pre-3A-2
  code path for `slack.list_channels`: no Runs Governance network call, no
  routing change, no Run lifecycle change.

## 3. Current routing rule

While the gate is **ON**, `slack.list_channels` is forced through the
**governed direct** execution path and does **not** use Trigger.dev, even if
Trigger.dev routing (`TACT_RUNTIME_TRIGGER_DEV_ENABLED`) is itself enabled and
correctly configured for that same action.

This precedence is enforced in
`core/tact-conversation/orchestration.ts`'s
`executeReadIntegrationActionWithRuntimeRouting()`: the governance gate is
checked, and short-circuits to the direct path, before the Trigger.dev runtime
adapter is ever resolved — see that function's own
`decideIntegrationReadRoute()` helper for the full routing decision table
(`legacy_direct` / `runtime` / `governed_direct` / `runtime_misconfigured`).

**This is intentional and temporary** — it holds only until Slice 3B
propagates governance `invocationId`/`decisionId` through the Trigger.dev
runtime path. Slice 3A-2 does not govern the Trigger.dev worker path at all;
it only ensures Trigger.dev is never silently used as an ungoverned bypass for
this one action while the gate is on.

### Post-Preflight revalidation (pre-commit correction)

Runs Preflight is a network round-trip. TACT's own local Work/Connection/
Task/Run state can change during that wait (the Task is cancelled or
completes elsewhere, the Work stops running, the Connection is revoked, a
concurrent caller claims a Run, or the planned attempt is no longer the next
one). After Preflight returns `ALLOW` and before any Run is created,
`core/tact-integration/execution.ts`'s `revalidateGovernedExecutionState()`
re-reads that state and fails closed into an existing outcome status
(`work_not_runnable` / `connection_unavailable` / `task_not_executable`) on
any drift. It never re-plans, never allocates a different attempt number, and
never re-asks Preflight — the originally-planned attempt (and the
`GovernanceDecision` Preflight was asked about) is either claimed exactly as
planned or not claimed at all.

## 4. Root environment contract

Five environment variables, all consumed only by
`core/tact-integration/runsGovernance.ts`:

| Variable | Purpose |
|---|---|
| `RUNS_GOVERNANCE_SLACK_LIST_CHANNELS_ENABLED` | The feature gate (Section 2). |
| `RUNS_GOVERNANCE_BASE_URL` | Origin of the Runs governance HTTP endpoint. |
| `RUNS_GOVERNANCE_CALLER_ID` | Caller identity included in the signed request. |
| `RUNS_GOVERNANCE_KEY_ID` | Identifies which HMAC key signed the request. |
| `RUNS_GOVERNANCE_HMAC_KEY` | Base64-encoded HMAC signing key (≥32 decoded bytes). |

Operational rules:

- `RUNS_GOVERNANCE_BASE_URL` must be `https://` for any non-loopback host.
  Plaintext `http://` is accepted only for exact loopback development hosts
  (`localhost`, `127.0.0.1`, `[::1]`) — never for any other host, public or
  private-network, regardless of environment.
- `RUNS_GOVERNANCE_BASE_URL` is treated strictly as an origin: no path
  prefix, credentials, query string, or fragment. A configured path prefix is
  rejected (`invalid_base_url`), not silently normalized away.
- Governance HMAC credentials are **environment-scoped**. Do not reuse the
  same `RUNS_GOVERNANCE_HMAC_KEY` value across Production, Staging, Preview,
  or Development — this transport's signature format does not itself bind
  the environment a request was signed for; the key material is the only
  thing that keeps a signed request scoped to its intended deployment.
- If the gate is ON but configuration is missing or invalid, the client
  fails closed (`unconfigured` / `invalid_base_url` / etc., surfaced through
  `GovernanceClientUnavailable`) — the governed action is blocked, never
  silently allowed and never silently routed around governance.
- No secret **values** belong in any documentation, including this file —
  only variable names and behavior are described here.

This document does not configure any of these values anywhere, and none were
set, changed, or read from a real deployment as part of writing it.

## 5. Non-claims

This slice (through 3A-2) does **not** yet provide:

- Complete capture — `callRunsGovernanceComplete()` exists in
  `runsGovernance.ts` but is not called from anywhere (remains unwired).
- Complete Mediation of all protected actions — only `slack.list_channels`
  is governed; every other action is entirely unaffected by this transport.
- Trigger.dev governance propagation — the Trigger.dev runtime path itself
  carries no governance `invocationId`/`decisionId` yet.
- Protected-write governance — only a read action is governed; no write/
  destructive action goes through Runs Preflight today.
- Transaction- or target-bound authorization — an `ALLOW` verdict authorizes
  the planned execution attempt's identity, not a specific target/value/
  transaction digest.
- Executable Human Approval grant integrity — an `APPROVAL_REQUIRED` verdict
  with `approval.status === "approved"` does **not** authorize execution;
  this slice has no transaction-bound execution grant mechanism. See
  Section 6.

## 6. Related future work

- **Slice 3A-3** — wiring `callRunsGovernanceComplete()`.
- **Slice 3B** — Trigger.dev runtime governance propagation.
- **SOR-160 / SOR-164 / SOR-169** — target/value binding, transaction
  digests, leases/expiry/nonce, state-version authorization, and any
  generic TOCTOU framework remain explicitly out of this slice's scope.
