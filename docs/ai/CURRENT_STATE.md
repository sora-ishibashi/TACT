# Current State Navigation

This file is a navigation aid, not a progress diary and not a source of truth
that supersedes GitHub, Linear, or Notion. Do not add commit hashes, branch
names, issue progress, temporary bugs, or weekly priorities here.

## Start an issue with current evidence

1. Check the current checkout with `git status`, branch, and diff. Keep another
   worktree's uncommitted work isolated.
2. Check GitHub `main` and the issue's relevant pull requests or commits for
   implemented behavior.
3. Read the matching Linear issue for scope, priority, dependencies, status,
   and Done conditions.
4. Read only the Notion decision or architecture note needed to understand the
   issue's rationale.
5. Read the relevant code and tests, then compare the planned work with the
   working tree before changing anything.

## Source ownership

| Need | Canonical source |
| --- | --- |
| What is implemented | GitHub and the repository |
| What should happen next | Linear |
| Why a direction was chosen | Notion |
| Durable AI working rules | `AGENTS.md` |
| Claude Code-only supplement | `CLAUDE.md` |

If a source is unavailable or conflicts with another, report the fact as
unverified or conflicting; do not fill the gap from an old snapshot.

## Maintenance rule

Keep this file short. Add only durable instructions for locating and verifying
current state. A future read-only context command may collect branch, worktree,
GitHub, and Linear metadata, but automation, hooks, and CI belong to their own
approved issue rather than this document.
