# Observation Surface Matrix

Classification is operation-path specific. The presence of adapter code alone
does not make a path `SUPPORTED`.

- `SUPPORTED`: an actual observation path exists and a past Reality Test verified
  the real provider action and persisted readback.
- `PARTIAL`: only a subset of operations or visibility fields is observable.
- `UNSUPPORTED`: current Runs has no acquisition path for the operation.
- `UNKNOWN`: the available evidence is insufficient to classify the path.

| surfaceId | Tool / provider | Operation class | Observation mechanism | Status | Actor visibility | Work ID visibility | Result visibility | Timestamp quality | Retry visibility | Failure visibility | Known gaps | Evidence | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| notion-mcp-v1-rw | Notion / MCP | read, create, update, delete | Explicit instrumented wrapper to Generic Observation Gateway | SUPPORTED | principal and agent available | explicit claim supported when legitimately supplied | final success/failure | provider action completion plus observed time; no start time | invocation ID supports dedup, retry relation not native | final tool failure | Only explicitly wrapped calls; not arbitrary Notion UI or private connector actions | SOR-130 live sandbox test; registry migration rows; `core/tact-execution/adapters/notion/` | HIGH |
| slack-web-api-v1-read | Slack Web API | `auth.test` read | Explicit instrumented wrapper | SUPPORTED | bot principal available; no agent identity | none | final success/failure | completion/observed time | invocation ID only | final API failure | A narrow read action, not general Slack read coverage | SOR-130 live `auth.test`; registry `live_verified` row | HIGH |
| slack-web-api-v1-send | Slack Web API | send message | Explicit instrumented wrapper | PARTIAL | bot principal available; no agent identity | none | adapter carries final result | completion/observed time | invocation ID supports dedup | adapter carries failure | No approved live send test was performed; message content is intentionally excluded | registry `unverified` row; mock-tested adapter | MEDIUM |
| slack-app-mention-v1 | Slack webhook | inbound app mention / create | Reconciled adapter exists | UNSUPPORTED | principal normalization exists in tests | no legitimate production carrier | normalization can describe observed event | webhook timestamp when present | event ID dedup | normalization failure telemetry | Adapter is not wired into the production webhook route | adapter header, registry `mock_only` row, production call-site search | HIGH |
| github-issue-v1 | GitHub API | issue read, create, update/close | Explicit instrumented wrapper | SUPPORTED | principal and agent available | none | final success/failure | completion/observed time | invocation ID supports dedup | final API failure | Limited to issue operations; provider is `custom` + label `github`; no general Git/CLI observation | SOR-130 live disposable/sandbox repository test; registry rows | HIGH |
| github-general | GitHub / git CLI | commits, branches, PRs, files, other API calls | No general Runs adapter; Git history can be independent evidence only | UNSUPPORTED | unavailable to Runs | unavailable | unavailable | Git timestamps usable only in ground truth | unavailable | unavailable | Do not generalize issue-adapter verification to GitHub as a whole | repository call-site and adapter-scope search | HIGH |
| claude-code-cli | Claude Code | local coding-agent execution | Separate coding-task reports capture exit/duration/files, but do not call Canonical Execution capture | UNSUPPORTED | agent identity exists outside Runs | task context exists outside Runs ledger | CLI exit metadata exists outside Runs | local process timing only | handoff attempts exist outside Runs | exit/timeout outside Runs | Not a Runs observation path | `core/tact-agent/codingTaskRunner.ts`, `codingTaskReport.ts`, zero capture call sites | HIGH |
| codex-cli | Codex | local coding-agent execution | Same separate coding-task reporting path | UNSUPPORTED | agent identity exists outside Runs | task context exists outside Runs ledger | CLI exit metadata exists outside Runs | local process timing only | attempts exist outside Runs | exit/timeout outside Runs | Codex execution adapter is not a Canonical Execution adapter | `core/tact-agent/`, zero capture call sites | HIGH |
| chatgpt | ChatGPT | chat/tool activity | No Runs acquisition path found | UNSUPPORTED | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | Product copy mentions ChatGPT but no observation implementation exists | full-repository search | HIGH |
| local-file-operation | Browser File System / local CLI | file read/write/delete | Context-source browser adapter reads workspace context; it is not a Runs execution adapter | UNSUPPORTED | unavailable to Runs | unavailable | unavailable | filesystem/Git time may be ground-truth evidence | unavailable | unavailable | Git/CLI history can prove some actions independently but must not be imported as Runs output | `core/tact-context-source/localWorkspace/`, zero capture call sites | HIGH |
| browser-computer-use | Browser / desktop automation | UI actions | Explicitly deferred from Runs v1 | UNSUPPORTED | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | No Browser/Desktop observation owner or adapter on `origin/main` | Runs v1 observation strategy and full-repository search | HIGH |
| direct-db-api-general | Direct DB/API execution | arbitrary query or provider call | No generic interception; only calls explicitly wrapped by a listed provider adapter are observed | UNSUPPORTED | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | Direct application DB/API calls are not automatically Canonical Executions | capture call-site search | HIGH |

## Interpretation guardrails

The matrix describes `origin/main` at base commit
`ce399876cdad479665a90e87c0042d7d51ba459e`. A `SUPPORTED` row does not mean all
actions in that SaaS are supported. An unsupported path remains in the Reality
Test denominator. A path that was expected visible but produces no Runs record is
reported as `MISSED / CAPTURE GAP`, not as evidence that the operation did not
happen.
