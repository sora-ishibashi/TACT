# TACT Research UI

This directory owns the primary TACT Research workspace UI rendered from
`/` through `TactShell`.

- Edit `ResearchWorkspace.tsx` when implementing future Research-only UI work.
- Keep shared product navigation, the top-level header, and authentication in
  `components/tact` and `components/auth`.
- Keep all data access behind the existing `/api/tact/*` routes. This UI must
  not import TACT Core implementations or Supabase clients.

Current API boundary used by the workspace:

- projects: `/api/tact/projects`
- conversation history and messages: `/api/tact/tact-conversations`
- artifacts: `/api/tact/artifacts/[artifactId]`
- knowledge: `/api/tact/knowledge`
