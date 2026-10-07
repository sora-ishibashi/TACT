// =========================
// Runs Core — Principal Registry store (SOR-260 Phase 1)
// =========================
//
// Resolves/creates EXTERNAL principals only (Human Owner decision 5).
// Governance callers (Preflight/Complete routes) never choose
// principal_kind or local_auth_user_id — this function always inserts
// principal_kind='external_subject', local_auth_user_id=null, and can
// never produce or return a 'local_runs_user' row. Local principal
// creation is exclusively the migration/backfill's own responsibility
// (products/yolna-runs/supabase/migrations/
// 20270101000019_create_tact_runs_principals.sql) — this module never
// writes a local_runs_user row.
//
// 'runs-local-auth' is RESERVED for Runs-local Supabase Auth logins
// (Human Owner decision 4). This file rejects it before ever reaching
// the database, as a second, independent layer on top of the migration's
// own CHECK constraint — an external caller must never resolve into a
// local Runs-auth principal, even if the DB layer were somehow bypassed.

import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import type { Principal, PrincipalKind } from "./types";

export const RESERVED_LOCAL_AUTH_NAMESPACE = "runs-local-auth";

const DUPLICATE_UNIQUE_VIOLATION = "23505";

const PRINCIPAL_COLUMNS = "id, namespace, external_subject_id, local_auth_user_id, principal_kind, created_at";

interface PrincipalRow {
  id: string;
  namespace: string;
  external_subject_id: string;
  local_auth_user_id: string | null;
  principal_kind: string;
  created_at: string;
}

function toPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    namespace: row.namespace,
    externalSubjectId: row.external_subject_id,
    localAuthUserId: row.local_auth_user_id,
    principalKind: row.principal_kind as PrincipalKind,
    createdAt: row.created_at,
  };
}

export interface PrincipalStoreDeps {
  getClient: typeof getServiceRoleClient;
}

const defaultPrincipalStoreDeps: PrincipalStoreDeps = {
  getClient: getServiceRoleClient,
};

export type ResolveOrCreateExternalPrincipalOutcome =
  | { status: "resolved"; principal: Principal }
  | { status: "created"; principal: Principal }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" };

function isNonBlankBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength && value.trim().length > 0;
}

function validateExternalPrincipalInput(namespace: string, externalSubjectId: string): string[] {

  const errors: string[] = [];

  if (!isNonBlankBoundedString(namespace, 255)) {
    errors.push("namespace must be a non-blank string between 1 and 255 characters");
  } else if (namespace === RESERVED_LOCAL_AUTH_NAMESPACE) {
    errors.push(
      `namespace "${RESERVED_LOCAL_AUTH_NAMESPACE}" is reserved for Runs-local auth principals and cannot be asserted by an external caller`
    );
  }

  if (!isNonBlankBoundedString(externalSubjectId, 255)) {
    errors.push("externalSubjectId must be a non-blank string between 1 and 255 characters");
  }

  return errors;

}

// Resolution proves only that an authenticated source asserted a subject
// identifier within its own namespace (SOR-260 design audit §12) — never
// that the subject independently exists in the source product. Callers
// (the Preflight/Complete routes) must have already authenticated the
// request (verified the HMAC signature) before calling this function; it
// performs no authentication of its own.
export async function resolveOrCreateExternalPrincipal(
  namespace: string,
  externalSubjectId: string,
  deps: PrincipalStoreDeps = defaultPrincipalStoreDeps
): Promise<ResolveOrCreateExternalPrincipalOutcome> {

  const errors = validateExternalPrincipalInput(namespace, externalSubjectId);
  if (errors.length > 0) return { status: "invalid", errors };

  const client = deps.getClient();
  if (!client) return { status: "unavailable" };

  const { data, error } = await client
    .from("tact_runs_principals")
    .insert({
      namespace,
      external_subject_id: externalSubjectId,
      local_auth_user_id: null,
      principal_kind: "external_subject",
    })
    .select(PRINCIPAL_COLUMNS)
    .single();

  if (!error && data) {
    return { status: "created", principal: toPrincipal(data as PrincipalRow) };
  }

  // unique(namespace, external_subject_id) race: another concurrent
  // request already won. Read back by the same natural key rather than
  // guessing or retrying the insert (same idempotent-insert idiom as
  // ../governance/store.ts's createGovernanceApprovalRequest()).
  if ((error as { code?: string } | null)?.code === DUPLICATE_UNIQUE_VIOLATION) {

    const existing = await client
      .from("tact_runs_principals")
      .select(PRINCIPAL_COLUMNS)
      .eq("namespace", namespace)
      .eq("external_subject_id", externalSubjectId)
      .maybeSingle();

    if (existing.data) {
      return { status: "resolved", principal: toPrincipal(existing.data as PrincipalRow) };
    }

    return { status: "unavailable" };

  }

  // Any other DB failure — including the reserved-namespace CHECK
  // constraint firing as a defensive second layer, or any other
  // constraint/connection failure — fails closed without ever surfacing
  // error.message through this typed boundary (SOR-260 Human Owner
  // decision 12: never leak raw Postgres error detail through an
  // application boundary).
  return { status: "unavailable" };

}
