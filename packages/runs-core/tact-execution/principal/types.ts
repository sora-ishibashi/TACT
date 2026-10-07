// =========================
// Runs Core — Principal Registry types (SOR-260 Phase 1)
// =========================
//
// A Principal is Runs' own identity row: either a genuine Runs-local
// Supabase Auth login (local_runs_user) or a subject an authenticated
// external source asserted within its own namespace (external_subject).
// Resolving/creating one proves only that an authenticated source
// asserted this subject identifier within its own namespace — it does
// NOT independently prove the subject exists in the source product
// (SOR-260 design audit §12, Human Owner decision 10 — preserve this
// exact claim boundary wherever Principal is surfaced in docs/tests).

export type PrincipalKind = "local_runs_user" | "external_subject";

export interface Principal {

  id: string;

  // Stable logical source-system identity (e.g. a registered governance
  // callerId) for principal_kind='external_subject', or the fixed
  // reserved value 'runs-local-auth' for principal_kind='local_runs_user'.
  namespace: string;

  // Opaque subject identifier within namespace. For a local_runs_user
  // principal this always equals id (see the migration's own CHECK
  // constraint — packages/runs-core never derives or relies on that
  // equality itself).
  externalSubjectId: string;

  // Set only for principal_kind='local_runs_user'. May become null after
  // the underlying auth.users row is deleted (detach) — the principal
  // row and all history keyed off its id persist regardless.
  localAuthUserId: string | null;

  principalKind: PrincipalKind;

  createdAt: string;

}
