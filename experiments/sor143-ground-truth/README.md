# SOR-143 Independent Ground Truth Ledger

This directory defines the scoring input for the three-day NexaWorks Reality
Test. It is deliberately independent of Yolna Runs: no Canonical Execution row,
Runs projection, or Runs-derived classification may be copied into the ledger as
ground truth.

## Sources and trust boundary

Ground truth may be assembled from a human record made at operation time, Git or
CLI history, SaaS test history, a deterministic synthetic fixture, or another
independently verifiable source. Evidence confidence is recorded per operation.
`LOW` evidence is never silently promoted to the same certainty as `HIGH`.

The ledger stores metadata only. Do not store prompts, message/email/document
bodies, provider payloads, passwords, tokens, API keys, authorization headers,
or third-party personal data. Use synthetic or pseudonymous identifiers for
people and targets.

## Files

- `ground-truth-schema.json` is the machine-readable ledger contract.
- `ground-truth-template.jsonl` is a valid one-record starter ledger.
- `synthetic-example.jsonl` is a fully synthetic ten-operation example.
- `validate-ledger.ts` validates JSONL without connecting to Runs or a cloud
  service.
- `validate-ledger.test.ts` covers the validator's required acceptance cases.
- `observation-surface-matrix.md` records code-grounded observation support.
- `measurement-contract.md` fixes comparison and scoring semantics.

## Usage

```powershell
npx tsx experiments/sor143-ground-truth/validate-ledger.ts `
  experiments/sor143-ground-truth/synthetic-example.jsonl

npx tsx experiments/sor143-ground-truth/validate-ledger.test.ts
```

The validator is offline. It does not read Runs, Supabase, SaaS APIs, or local
credentials.

## Timestamp contract

`occurredAt` and `recordedAt` are UTC ISO-8601 timestamps and `timezone` is
`UTC`. When the source only supplies local time, preserve `sourceLocalTime` and
`sourceTimezone` together. Comparison uses `comparisonTimingWindowSeconds`, not
an equality assumption, because polling, webhook delivery, processing latency,
and clock skew exist.

## Work attribution contract

Every operation uses one evidence-backed basis:

- `EXPLICIT`: the action carried a Work ID.
- `DETERMINISTIC`: a stable external record maps to exactly one Work.
- `HUMAN_CONFIRMED`: a human confirmed or corrected the assignment.
- `UNKNOWN`: the Work cannot be established.

`UNKNOWN` requires both `expectedWorkId` and `expectedWorkTitle` to be null. The
validator never guesses a Work. A later human correction is append-only and may
refer to the earlier ledger event through `attributionRevisionOfEventId`.

## Required Reality Test scenarios

The Reality Test plan must allocate stable scenario IDs and expected action IDs
for all of the following. One operation may support more than one stress
condition, but the plan must make that overlap explicit.

| ID | Scenario | Expected scoring behavior |
|---|---|---|
| A | Work ID present | Grade explicit Work transport. |
| B | Work ID absent | `UNKNOWN` is valid; no inferred Work is created. |
| C | Two or more Works in parallel | Match by stable action ID and evidence, not nearest timestamp alone. |
| D | Operations at nearly the same instant | Use the timing window plus provider/tool/target evidence. |
| E | Retry | Preserve `retryGroupId` and increasing `attemptNumber`. |
| F | Intentional failure | The failure is a real operation and remains in every denominator. |
| G | Partial success | Represent component operations separately; do not invent a `PARTIAL` result. |
| H | Duplicate event | Ground truth keeps one real operation; duplicate Runs rows are comparison findings. |
| I | Unsupported observation path | Keep the operation in overall visibility as `UNSUPPORTED`. |
| J | Observation outage/gap | Record `SUSPECTED_OUTAGE`; never reinterpret absence as no action. |
| K | Unknown permission | Use `UNKNOWN` or `NOT_EVALUATED`; do not infer allow/deny. |
| L | Unknown Outcome | Use `UNKNOWN`; do not copy the ground-truth result into Runs. |
| M | Human reclassification | Preserve the initial classification and append the correction. |
| N | AI delegation chain | Preserve parent/delegation evidence; partial/unsupported is acceptable when honest. |

## SOR-142 fixture integration contract

This directory does not import the SOR-142 branch. A future NexaWorks fixture
must provide stable synthetic employee IDs, Work IDs, scenario IDs, and expected
action IDs. They map respectively to `actorId`/`responsibleHuman`,
`expectedWorkId`, `scenarioId`, and `sourceOperationId`. SOR-143 remains usable
without that fixture by using the included synthetic example.

## Scope boundary

This work defines measurement only. It does not implement Capture Gap product
features (SOR-136), change Runs product code, create a sandbox, mutate cloud
services, or set a beta Go/No-Go threshold. SOR-145 owns the final threshold.
