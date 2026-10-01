# Measurement Contract

This contract compares an independent ground-truth ledger with a future Runs
export. It defines scoring, not a beta threshold.

## Comparison output

Each ground-truth operation receives one operation class:

- `matched`: one Runs event is linked to the real operation.
- `missed`: the operation was expected visible but no Runs event was linked.
- `unsupported`: the planned path was unsupported; it remains in overall
  visibility.
- `unknown`: evidence cannot establish whether a comparison is valid.

Runs rows that are not the primary match receive `extra/unmatched Runs event` or
`duplicate`. A linked operation also carries zero or more field discrepancies:
`wrong identity`, `wrong Work`, `wrong result`, and `delayed`. This two-part shape
avoids hiding a visible operation merely because one field was wrong.

## Matching rules

Match in descending evidence strength: stable `sourceOperationId` or provider
invocation ID, deterministic target/action evidence, then the timing window plus
provider/tool/target. Timestamp proximity alone is never sufficient for parallel
or near-simultaneous work. Matching must be one-to-one before duplicates are
classified. A duplicate Runs row never creates a second ground-truth operation.

## Coverage

Let `linked(G)` mean a ground-truth operation has exactly one selected primary
Runs match, even if that match has field discrepancies.

`Supported-surface coverage = linked supported operations / all supported operations`

The supported denominator contains ledger rows where
`expectedObservationStatus=SUPPORTED` and
`captureGapExpectation=EXPECTED_VISIBLE`.

`Overall visibility = linked operations / all Reality Test operations`

The overall denominator includes supported, partial, unsupported, failure,
retry, and outage/gap cases. Unsupported paths are never silently removed.
Report numerator, denominator, and counts by support status; never publish a
percentage without them.

## Identity attribution

Classify every linked operation as `Correct`, `Incorrect`, `Unknown`, or
`Unassigned`. `Correct` requires evidence-backed equality with `actorId` and, when
present, `responsibleHuman`; low model confidence cannot be promoted to Correct.
Report all four counts. If an accuracy ratio is shown, its denominator is every
operation for which ground-truth identity is known, so Runs `Unknown` and
`Unassigned` remain visible failures of completeness.

## Work attribution

Report separate counts for `correct auto attribution`, `incorrect auto
attribution`, `unassigned`, `human corrected`, and `still unknown`. The automatic
accuracy snapshot is taken before human correction. A later correction does not
rewrite history or inflate automatic accuracy to 100%. Ground-truth
`workAssignmentBasis=UNKNOWN` is not an auto-attribution failure unless Runs
invented a Work.

## Execution fidelity

Score independently by field or relation:

- execution occurrence;
- success/failure/cancellation;
- action category;
- ordering;
- duplicate count;
- retry grouping and attempt order;
- timestamp inside the allowed timing window;
- provider and tool.

Publish match, mismatch, and unknown counts per field. A single aggregate score,
if later proposed, must retain the field-level table and weighting rationale.

## Permission / governance

Classify as `correct allowed`, `correct denied`, `correct approval-required`,
`false positive`, `false negative`, or `unknown / not evaluated`. A false positive
means Runs denied or required approval where ground truth says allowed. A false
negative means Runs allowed an action ground truth says denied or
approval-required. Missing permission evidence is `unknown / not evaluated`, not
an inferred success.

## Outcome

Outcome is scored only when an independent outcome writer/evidence source exists.
Otherwise `expectedOutcomeStatus=UNKNOWN`. If ground truth contains a result but
Runs has no asserted outcome, Runs remains `UNKNOWN`; the evaluator must not copy
the ground-truth result into Runs or infer it from execution success.

## Capture Gap handling

Ledger expectations are `EXPECTED_VISIBLE`, `PARTIALLY_VISIBLE`, `UNSUPPORTED`,
or `SUSPECTED_OUTAGE`. When an operation exists in ground truth and an
`EXPECTED_VISIBLE` Runs record is absent, classify it as `missed` and emit a
`MISSED / CAPTURE GAP` finding. `SUSPECTED_OUTAGE` remains a separate finding for
comparison with the future SOR-136 product output; this directory does not
implement that product feature.

## Evidence confidence

- `HIGH`: API/SaaS history, Git commit/history, or deterministic fixture.
- `MEDIUM`: a human record made immediately at operation time.
- `LOW`: retrospective human memory.

Every metric must be stratifiable by confidence. Do not merge `LOW` evidence
into a headline result without disclosing its count.

## Timestamp comparison

Use `abs(runsOccurredAt - occurredAt) <= comparisonTimingWindowSeconds` after
normalizing to UTC. `recordedAt` measures ledger-entry latency and is not a proxy
for operation time. If the source only had local time, retain the paired
`sourceLocalTime` and `sourceTimezone` for audit, while `occurredAt` remains the
normalized UTC value.

## Go / No-Go boundary

No percentage in this document is a release threshold. SOR-145 owns the final
beta Go/No-Go decision. SOR-143 only supplies reproducible denominators,
classifications, and optional threshold inputs.
