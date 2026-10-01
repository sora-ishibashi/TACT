<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Shared AI development rules

These rules apply to every AI contributor. Keep this file for durable working
rules only; do not record an issue's progress, a branch name, a commit, or a
temporary defect here.

## Sources of truth

| Source | Owns |
| --- | --- |
| GitHub and the repository | Implemented behavior, code, migrations, tests, and code-level architecture |
| Linear | Issue scope, priority, dependencies, status, and delivery plan |
| Notion | Design decisions, rationale, and learning |
| `AGENTS.md` | Durable AI development rules |
| `docs/ai/CURRENT_STATE.md` | How to find and verify the current state; not a competing source of truth |
| `CLAUDE.md` | Claude Code-specific supplement only |

When sources disagree, do not silently choose one. Treat the repository and
GitHub as the evidence for implemented behavior, Linear as the plan, and Notion
as the decision record; report a material conflict to the Human Owner.

## Before changing anything

1. Read `docs/ai/CURRENT_STATE.md` as a navigation aid, then verify its
   pointers against the canonical sources.
2. Read the matching Linear issue and its Done conditions.
3. Read only the Notion decision and architecture documents relevant to that
   issue.
4. Check the current branch, `git status`, and diff. Do not treat an old local
   document as evidence of the current plan or implementation state.
5. Use an issue-scoped branch and worktree. Do not directly change, commit to,
   or push `main`.
6. Do not touch another AI's worktree or uncommitted work. When parallel work
   would substantially edit the same files, sequence it or obtain explicit
   coordination first.

## Scope, safety, and approval

- Work autonomously on low-risk, in-scope changes. Do not seek unnecessary
  approval for ordinary reversible implementation work.
- Keep unrelated cleanup and speculative refactors out of the change.
- Ask the Human Owner before a material product or architecture direction
  change, removing existing functionality, a destructive or incompatible API change, a database migration,
  production action, a security-boundary change, or a credential/secret change.
- Never place a secret in source, a commit, test fixture, or logs. Do not invent
  an external capability, credential, connector, or configuration; mark it
  unverified and stop when it would change the implementation.
- Match the task's explicit boundary even when a nearby improvement appears
  desirable.

## Implementation and verification

- Use the smallest change that satisfies the accepted issue scope and preserve
  existing compatible behavior unless the issue explicitly changes it.
- Do not introduce `any` in new TypeScript or weaken TypeScript strictness to
  hide an error. Do not widen the task merely to repair unrelated existing
  errors.
- Run checks proportionate to the changed surface: relevant tests, typecheck,
  lint, build, and a diff review as applicable. For documentation-only work,
  review Markdown links/paths, duplication, and the diff instead of running an
  unrelated full build.
- Compare the implementation and verification evidence with the issue's Done
  conditions before reporting completion. State checks as passed, failed, not
  run, or blocked.

## Focused context for AI work

Give an AI the issue, relevant code and tests, necessary decisions, and the
applicable security or architecture constraints. Do not use this rule file,
`CURRENT_STATE`, or a past conversation as a reason to load the entire
repository or all of Notion. See `docs/ai/CONTEXT_BUILDER.md` for role-specific
context boundaries.

## UI work

For a UI implementation, change, or review, read
`docs/ui-design-rules.md`. It is the UI source of truth. Do not use UI-rule
compliance as a reason to alter unrelated API, database, workflow,
orchestration, capability, or state-management behavior. Report an unresolved
rule conflict instead of inventing a design-system extension.
