# Context Builder

Build a context packet for one issue, not for the entire repository.

## Required packet

- The Linear issue, including scope, dependencies, and Done conditions.
- Only the code and tests that the issue can affect.
- Only the Notion decision or architecture note needed for the decision at hand.
- Applicable security, data, deployment, and architecture constraints.

Link to the canonical sources instead of copying volatile issue status or large
historical narratives into a prompt. Exclude unrelated repository areas, all
Notion pages, prior conversations, secrets, and credentials.

## Role-specific context

| Role | Give it | Keep separate |
| --- | --- | --- |
| Planner | Issue, relevant architecture constraints, and relevant code | Implementation history and unrelated plans |
| Reviewer | Issue, proposed plan or diff, relevant architecture, and acceptance criteria | The Planner's private reasoning; perform an independent review |
| Worker | Approved plan, target files, relevant tests, and constraints | Unrelated product history and broad repository context |
| Verifier | Issue Done conditions, final diff, relevant tests, and build/lint/typecheck evidence | Assumptions that are not supported by the diff or checks |

The Planner, Reviewer, Worker, and Verifier may share canonical links, but do
not receive one undifferentiated context dump. Refresh the issue and working
tree evidence at each handoff when the change may have moved.

## Failure-to-rule routing

When a mistake recurs, place the remedy deliberately:

- Durable cross-AI working rule: `AGENTS.md`.
- Claude Code-only behavior: `CLAUDE.md`.
- Current-state lookup guidance: `CURRENT_STATE.md`.
- Enforceable automation, hook, or CI: propose a separate issue; do not add it
  implicitly as documentation.
