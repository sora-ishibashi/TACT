# Capture Coverage contract (SOR-136)

`tact_observation_surfaces` describes the ability to observe a declared source;
`tact_capture_gaps` is append-oriented history of evidence-backed gaps. Neither
table stores execution, permission, or Work-correlation state.

Metric mapping to SOR-143:

| SOR-143 expectation | SOR-136 product state |
| --- | --- |
| `EXPECTED_VISIBLE` | `COVERED` unless an evidenced gap is open |
| `PARTIALLY_VISIBLE` | `PARTIAL` |
| `UNSUPPORTED` | no Observation Surface is registered |
| `SUSPECTED_OUTAGE` | `UNKNOWN`, `GAP_DETECTED`, or `OUTAGE`, according to evidence |

Capture coverage measures observable-surface availability. Attributable execution
rate remains a separate execution-to-identity measurement. An absence of an
execution never creates `HEALTHY`; it remains `UNKNOWN` until a health observation
is recorded. Open `PARTIAL`, `GAP_DETECTED`, and `OUTAGE` gaps are eligible for
the small Attention/security-review hook, but do not alter permission decisions.
