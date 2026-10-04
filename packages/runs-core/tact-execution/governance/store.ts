import { getServiceRoleClient } from "../../database/supabaseServiceRole";
import { validateGovernanceDecisionInput, validateGovernanceInvocationInput, validateGovernanceApprovalRequestInput, validateGovernanceApprovalResolver } from "./validation";
import type { GovernanceDecision, GovernanceDecisionInput, GovernanceExecutionLink, GovernanceExecutionLinkInput, GovernanceInvocation, GovernanceInvocationInput, GovernanceApprovalRequest, GovernanceApprovalRequestInput, GovernanceApprovalRequestStatus, GovernanceApprovalResolver } from "./types";
const DUPLICATE = "23505";
const INV_COLUMNS = "id, user_id, organization_id, workspace_id, work_id, connection_id, actor_kind, actor_id, agent_id, on_behalf_of_actor_kind, on_behalf_of_actor_id, action_category, operation, resource_type, resource_identifier, target_provider, attempted_at, created_at";
const DEC_COLUMNS = "id, user_id, invocation_id, evaluated_at, actor_kind_snapshot, actor_id_snapshot, agent_id_snapshot, on_behalf_of_actor_kind_snapshot, on_behalf_of_actor_id_snapshot, action_category_snapshot, operation_snapshot, resource_type_snapshot, resource_identifier_snapshot, target_provider_snapshot, verdict, reason_code, evaluator_version, decision_source, trust_level_snapshot, policy_identifier_snapshot, registry_rule_id_snapshot, registry_rule_revision_snapshot, runs_permission_snapshot, policy_set_fingerprint, approval_id, approval_status, approver_kind, approver_id, approved_at, created_at";
const LINK_COLUMNS = "id, user_id, invocation_id, effective_governance_decision_id, execution_id, linked_at";
const APR_COLUMNS = "id, user_id, governance_decision_id, status, requested_at, resolved_at, resolved_by_actor_kind, resolved_by_actor_id, created_at";
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const toGovernanceInvocation = (r: any): GovernanceInvocation => ({ id:r.id,userId:r.user_id,organizationId:r.organization_id,workspaceId:r.workspace_id,workId:r.work_id,connectionId:r.connection_id,actorKind:r.actor_kind,actorId:r.actor_id,agentId:r.agent_id,onBehalfOfActorKind:r.on_behalf_of_actor_kind,onBehalfOfActorId:r.on_behalf_of_actor_id,actionCategory:r.action_category,operation:r.operation,resourceType:r.resource_type,resourceIdentifier:r.resource_identifier,targetProvider:r.target_provider,attemptedAt:r.attempted_at,createdAt:r.created_at });
export const toGovernanceDecision = (r: any): GovernanceDecision => ({ id:r.id,userId:r.user_id,invocationId:r.invocation_id,evaluatedAt:r.evaluated_at,actorKindSnapshot:r.actor_kind_snapshot,actorIdSnapshot:r.actor_id_snapshot,agentIdSnapshot:r.agent_id_snapshot,onBehalfOfActorKindSnapshot:r.on_behalf_of_actor_kind_snapshot,onBehalfOfActorIdSnapshot:r.on_behalf_of_actor_id_snapshot,actionCategorySnapshot:r.action_category_snapshot,operationSnapshot:r.operation_snapshot,resourceTypeSnapshot:r.resource_type_snapshot,resourceIdentifierSnapshot:r.resource_identifier_snapshot,targetProviderSnapshot:r.target_provider_snapshot,verdict:r.verdict,reasonCode:r.reason_code,evaluatorVersion:r.evaluator_version,decisionSource:r.decision_source,trustLevelSnapshot:r.trust_level_snapshot,policyIdentifierSnapshot:r.policy_identifier_snapshot,registryRuleIdSnapshot:r.registry_rule_id_snapshot,registryRuleRevisionSnapshot:r.registry_rule_revision_snapshot,runsPermissionSnapshot:r.runs_permission_snapshot,policySetFingerprint:r.policy_set_fingerprint,approvalId:r.approval_id,approvalStatus:r.approval_status,approverKind:r.approver_kind,approverId:r.approver_id,approvedAt:r.approved_at,createdAt:r.created_at });
export const toGovernanceExecutionLink = (r: any): GovernanceExecutionLink => ({ id:r.id,userId:r.user_id,invocationId:r.invocation_id,effectiveGovernanceDecisionId:r.effective_governance_decision_id,executionId:r.execution_id,linkedAt:r.linked_at });
// Explicitly typed row shape (unlike the three mappers above, which predate
// this slice's approved change scope and are left as `any` per CLAUDE.md
// A章 — new code does not add new `any` usage). `status`/`resolved_by_actor_kind`
// are narrowed via `as` from the DB's `text` column to the known closed set
// the CHECK constraints (migration 20270101000016) already guarantee.
interface GovernanceApprovalRequestRow {
  id: string;
  user_id: string;
  governance_decision_id: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by_actor_kind: string | null;
  resolved_by_actor_id: string | null;
  created_at: string;
}
export const toGovernanceApprovalRequest = (r: GovernanceApprovalRequestRow): GovernanceApprovalRequest => ({
  id: r.id,
  userId: r.user_id,
  governanceDecisionId: r.governance_decision_id,
  status: r.status as GovernanceApprovalRequestStatus,
  requestedAt: r.requested_at,
  resolvedAt: r.resolved_at,
  resolvedByActorKind: r.resolved_by_actor_kind as "human" | null,
  resolvedByActorId: r.resolved_by_actor_id,
  createdAt: r.created_at,
});
export interface GovernanceStoreDeps { getClient: typeof getServiceRoleClient; }
const defaults: GovernanceStoreDeps = { getClient: getServiceRoleClient };
const invocationPayload = (i: GovernanceInvocationInput) => ({ id:i.id,user_id:i.userId,organization_id:i.organizationId,workspace_id:i.workspaceId,work_id:i.workId,connection_id:i.connectionId,actor_kind:i.actorKind,actor_id:i.actorId,agent_id:i.agentId,on_behalf_of_actor_kind:i.onBehalfOfActorKind,on_behalf_of_actor_id:i.onBehalfOfActorId,action_category:i.actionCategory,operation:i.operation,resource_type:i.resourceType,resource_identifier:i.resourceIdentifier,target_provider:i.targetProvider,attempted_at:i.attemptedAt });
// Postgres may render the same timestamptz instant with +00:00 rather than Z.
// Idempotency compares the caller-owned instant, not its database display form.
function normalizeInstantForComparison(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("invalid timestamp reached governance idempotency comparison");
  return new Date(timestamp).toISOString();
}
const invocationComparablePayload = (i: GovernanceInvocationInput) => ({
  ...invocationPayload(i),
  attempted_at: normalizeInstantForComparison(i.attemptedAt),
});
const decisionPayload = (d: GovernanceDecisionInput) => ({ id:d.id,user_id:d.userId,invocation_id:d.invocationId,evaluated_at:d.evaluatedAt,actor_kind_snapshot:d.actorKindSnapshot,actor_id_snapshot:d.actorIdSnapshot,agent_id_snapshot:d.agentIdSnapshot,on_behalf_of_actor_kind_snapshot:d.onBehalfOfActorKindSnapshot,on_behalf_of_actor_id_snapshot:d.onBehalfOfActorIdSnapshot,action_category_snapshot:d.actionCategorySnapshot,operation_snapshot:d.operationSnapshot,resource_type_snapshot:d.resourceTypeSnapshot,resource_identifier_snapshot:d.resourceIdentifierSnapshot,target_provider_snapshot:d.targetProviderSnapshot,verdict:d.verdict,reason_code:d.reasonCode,evaluator_version:d.evaluatorVersion,decision_source:d.decisionSource,trust_level_snapshot:d.trustLevelSnapshot,policy_identifier_snapshot:d.policyIdentifierSnapshot,registry_rule_id_snapshot:d.registryRuleIdSnapshot,registry_rule_revision_snapshot:d.registryRuleRevisionSnapshot,runs_permission_snapshot:d.runsPermissionSnapshot,policy_set_fingerprint:d.policySetFingerprint,approval_id:d.approvalId,approval_status:d.approvalStatus,approver_kind:d.approverKind,approver_id:d.approverId,approved_at:d.approvedAt });
const decisionComparablePayload = (d: GovernanceDecisionInput) => ({
  ...decisionPayload(d),
  evaluated_at: normalizeInstantForComparison(d.evaluatedAt),
  approved_at: normalizeInstantForComparison(d.approvedAt),
});
export async function createGovernanceInvocation(input: GovernanceInvocationInput, deps: GovernanceStoreDeps = defaults): Promise<any> { const v=validateGovernanceInvocationInput(input); if(!v.ok)return{status:"invalid",errors:v.errors}; const c=deps.getClient(); if(!c)return{status:"unavailable"}; const p=invocationPayload(input); const {data,error}=await c.from("tact_governance_invocations").insert(p).select(INV_COLUMNS).single(); if(!error&&data)return{status:"created",invocation:toGovernanceInvocation(data)}; if((error as any)?.code!==DUPLICATE)return{status:"error",message:error?.message??"insert failed"}; const e=await c.from("tact_governance_invocations").select(INV_COLUMNS).eq("id",input.id).eq("user_id",input.userId).maybeSingle(); if(!e.data)return{status:"error",message:"duplicate claim could not be read"}; const existing=toGovernanceInvocation(e.data); return same(invocationComparablePayload(existing),invocationComparablePayload(input))?{status:"already_exists",invocation:existing}:{status:"idempotency_conflict"}; }
export async function appendGovernanceDecision(input: GovernanceDecisionInput, deps: GovernanceStoreDeps = defaults): Promise<any> { const v=validateGovernanceDecisionInput(input); if(!v.ok)return{status:"invalid",errors:v.errors}; const c=deps.getClient(); if(!c)return{status:"unavailable"}; const p=decisionPayload(input); const {data,error}=await c.from("tact_governance_decisions").insert(p).select(DEC_COLUMNS).single(); if(!error&&data)return{status:"created",decision:toGovernanceDecision(data)}; if((error as any)?.code!==DUPLICATE)return{status:"error",message:error?.message??"insert failed"}; const e=await c.from("tact_governance_decisions").select(DEC_COLUMNS).eq("id",input.id).eq("user_id",input.userId).maybeSingle(); if(!e.data)return{status:"error",message:"duplicate claim could not be read"}; const existing=toGovernanceDecision(e.data); return same(decisionComparablePayload(existing),decisionComparablePayload(input))?{status:"already_exists",decision:existing}:{status:"idempotency_conflict"}; }
export async function linkInvocationExecution(input: GovernanceExecutionLinkInput, deps: GovernanceStoreDeps = defaults): Promise<any> { const c=deps.getClient(); if(!c)return{status:"unavailable"}; const {data,error}=await c.from("tact_governance_invocation_execution_links").insert({user_id:input.userId,invocation_id:input.invocationId,effective_governance_decision_id:input.effectiveGovernanceDecisionId??null,execution_id:input.executionId}).select(LINK_COLUMNS).single(); if(!error&&data)return{status:"created",link:toGovernanceExecutionLink(data)}; if((error as any)?.code===DUPLICATE){const e=await c.from("tact_governance_invocation_execution_links").select(LINK_COLUMNS).eq("execution_id",input.executionId).maybeSingle(); if(e.data){const link=toGovernanceExecutionLink(e.data); return link.invocationId===input.invocationId&&link.effectiveGovernanceDecisionId===(input.effectiveGovernanceDecisionId??null)?{status:"already_exists",link}:{status:"execution_already_linked"};}} return{status:"error",message:error?.message??"insert failed"}; }
export async function getGovernanceInvocation(id:string,userId:string,deps:GovernanceStoreDeps=defaults):Promise<GovernanceInvocation|undefined>{const c=deps.getClient();if(!c)return undefined;const {data}=await c.from("tact_governance_invocations").select(INV_COLUMNS).eq("id",id).eq("user_id",userId).maybeSingle();return data?toGovernanceInvocation(data):undefined;}
export async function listGovernanceDecisionsForInvocation(id:string,userId:string,deps:GovernanceStoreDeps=defaults):Promise<GovernanceDecision[]>{const c=deps.getClient();if(!c)return[];const {data}=await c.from("tact_governance_decisions").select(DEC_COLUMNS).eq("invocation_id",id).eq("user_id",userId).order("evaluated_at",{ascending:false});return(data??[]).map(toGovernanceDecision);}
export async function listInvocationExecutionLinks(id:string,userId:string,deps:GovernanceStoreDeps=defaults):Promise<GovernanceExecutionLink[]>{const c=deps.getClient();if(!c)return[];const {data}=await c.from("tact_governance_invocation_execution_links").select(LINK_COLUMNS).eq("invocation_id",id).eq("user_id",userId).order("linked_at",{ascending:false});return(data??[]).map(toGovernanceExecutionLink);}

// =========================
// GovernanceApprovalRequest (SOR-138 Slice 2A)
// =========================
//
// Creation idempotency does NOT follow createGovernanceInvocation/
// appendGovernanceDecision's "insert, 23505, read back, compare canonical
// payload" shape — there is nothing to compare here (the only persisted
// content besides the DB-assigned id is governance_decision_id itself), so a
// duplicate claim is unconditionally `already_exists`, never
// `idempotency_conflict`. The UNIQUE(governance_decision_id) constraint
// (Slice 2A migration) is the sole concurrency boundary (Human Owner
// decision, "CREATION SEMANTICS") — no deterministic id, no advisory lock.
export type CreateGovernanceApprovalRequestOutcome =
  | { status: "created"; approvalRequest: GovernanceApprovalRequest }
  | { status: "already_exists"; approvalRequest: GovernanceApprovalRequest }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// NOT exported (SOR-138 Slice 2A, Human Owner correction 2): this is the
// raw, non-verifying insert primitive. It trusts its `input.governanceDecisionId`
// at face value — it never reads the decision row, so by itself it cannot
// tell an APPROVAL_REQUIRED decision from an ALLOW/DENY/UNKNOWN one, or from
// a decision belonging to a different tenant. Because `export * from
// "./store"` (../index.ts) re-exports everything this file marks `export`,
// leaving this reachable from outside would make the governance barrel
// itself the hole a future direct caller could use to create a
// GovernanceApprovalRequest for a verdict that was never APPROVAL_REQUIRED.
// ensureGovernanceApprovalRequestForDecision() below is the only exported
// path to this logic, and it closes that hole by verifying the persisted
// decision FIRST. Do not re-export this function from anywhere.
async function createGovernanceApprovalRequest(
  input: GovernanceApprovalRequestInput,
  deps: GovernanceStoreDeps = defaults
): Promise<CreateGovernanceApprovalRequestOutcome> {

  const v = validateGovernanceApprovalRequestInput(input);
  if (!v.ok) return { status: "invalid", errors: v.errors };

  const c = deps.getClient();
  if (!c) return { status: "unavailable" };

  const { data, error } = await c
    .from("tact_governance_approval_requests")
    .insert({ user_id: input.userId, governance_decision_id: input.governanceDecisionId })
    .select(APR_COLUMNS)
    .single();

  if (!error && data) return { status: "created", approvalRequest: toGovernanceApprovalRequest(data) };
  if ((error as { code?: string } | null)?.code !== DUPLICATE) return { status: "error", message: error?.message ?? "insert failed" };

  const e = await c
    .from("tact_governance_approval_requests")
    .select(APR_COLUMNS)
    .eq("governance_decision_id", input.governanceDecisionId)
    .eq("user_id", input.userId)
    .maybeSingle();

  if (!e.data) return { status: "error", message: "duplicate claim could not be read" };
  return { status: "already_exists", approvalRequest: toGovernanceApprovalRequest(e.data) };

}

// =========================
// Decision-verifying creation boundary (SOR-138 Slice 2A, Human Owner
// correction 2)
// =========================
//
// THE exported way to create a GovernanceApprovalRequest. Never trusts a
// caller-supplied verdict string — always re-reads the persisted, immutable
// GovernanceDecision and verifies it independently before creating
// anything. A caller (including contract.ts's own preflight(), which
// already knows the verdict from the in-memory decision it just
// persisted/read) gets no shortcut around this re-check; the safety
// invariant lives in the store boundary itself, not in whichever caller
// happens to be careful.
export type EnsureGovernanceApprovalRequestOutcome =
  | { status: "created"; approvalRequest: GovernanceApprovalRequest }
  | { status: "already_exists"; approvalRequest: GovernanceApprovalRequest }
  // Missing decision and a different tenant's decision deliberately
  // collapse to this SAME outcome (the lookup query itself is scoped by
  // `.eq("user_id", userId)`, so a foreign-tenant id simply never matches
  // a row) — this boundary must not disclose whether a decision exists
  // for someone else's tenant.
  | { status: "decision_not_found" }
  | { status: "verdict_not_approval_required" }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export async function ensureGovernanceApprovalRequestForDecision(
  governanceDecisionId: string,
  trustedUserId: string,
  deps: GovernanceStoreDeps = defaults
): Promise<EnsureGovernanceApprovalRequestOutcome> {

  if (!governanceDecisionId || !trustedUserId) {
    return { status: "invalid", errors: ["governanceDecisionId and trustedUserId are required"] };
  }

  const c = deps.getClient();
  if (!c) return { status: "unavailable" };

  const { data: decisionRow, error: readError } = await c
    .from("tact_governance_decisions")
    .select("id, user_id, verdict")
    .eq("id", governanceDecisionId)
    .eq("user_id", trustedUserId)
    .maybeSingle();

  if (readError) return { status: "error", message: readError.message };
  if (!decisionRow) return { status: "decision_not_found" };
  if ((decisionRow as { verdict: string }).verdict !== "APPROVAL_REQUIRED") return { status: "verdict_not_approval_required" };

  return createGovernanceApprovalRequest({ userId: trustedUserId, governanceDecisionId }, deps);

}

export async function getGovernanceApprovalRequest(
  id: string,
  userId: string,
  deps: GovernanceStoreDeps = defaults
): Promise<GovernanceApprovalRequest | undefined> {
  const c = deps.getClient();
  if (!c) return undefined;
  const { data } = await c.from("tact_governance_approval_requests").select(APR_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  return data ? toGovernanceApprovalRequest(data) : undefined;
}

export async function getGovernanceApprovalRequestForDecision(
  governanceDecisionId: string,
  userId: string,
  deps: GovernanceStoreDeps = defaults
): Promise<GovernanceApprovalRequest | undefined> {
  const c = deps.getClient();
  if (!c) return undefined;
  const { data } = await c.from("tact_governance_approval_requests").select(APR_COLUMNS).eq("governance_decision_id", governanceDecisionId).eq("user_id", userId).maybeSingle();
  return data ? toGovernanceApprovalRequest(data) : undefined;
}

// Single-statement CAS (same idiom as ../permission/attentionStore.ts's
// transitionExecutionAttention(): the conditional UPDATE's own WHERE clause
// — id + user_id (tenant ownership) + status = 'pending' — is the CAS
// predicate. Two concurrent resolutions of the same row serialize on
// Postgres' row lock; at most one UPDATE can ever match `status = 'pending'`,
// so a terminal state can never flip once reached (Human Owner decision,
// "RESOLUTION FUNCTIONS": no approved->rejected, no rejected->approved, no
// terminal->pending).
export type ResolveGovernanceApprovalRequestOutcome =
  | { status: "resolved"; approvalRequest: GovernanceApprovalRequest }
  // Covers both: (a) the losing side of a genuine approve/reject race
  // observing the winner's actual terminal status, and (b) an idempotent
  // repeat of the SAME action already applied. The caller distinguishes
  // them, if it needs to, by comparing approvalRequest.status to the
  // action it attempted — this store never needs a third outcome for that.
  | { status: "already_resolved"; approvalRequest: GovernanceApprovalRequest }
  | { status: "not_found" }
  | { status: "invalid"; errors: string[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

async function transitionGovernanceApprovalRequest(
  approvalRequestId: string,
  userId: string,
  targetStatus: "approved" | "rejected",
  resolver: GovernanceApprovalResolver,
  deps: GovernanceStoreDeps
): Promise<ResolveGovernanceApprovalRequestOutcome> {

  // Human-only resolver (Human Owner correction 1): a terminal resolution
  // by anything other than a human, or with an empty/whitespace-only
  // actorId, is rejected before any write is attempted — even though the
  // DB columns are nullable (nullable only to represent a still-pending
  // row's own absence of a resolver, never to allow a terminal row
  // resolved by ai_agent/service/connector/system).
  const validated = validateGovernanceApprovalResolver(resolver);
  if (!validated.ok) return { status: "invalid", errors: validated.errors };

  const c = deps.getClient();
  if (!c) return { status: "unavailable" };

  const nowIso = new Date().toISOString();

  const { data: updatedRow, error: updateError } = await c
    .from("tact_governance_approval_requests")
    .update({
      status: targetStatus,
      resolved_at: nowIso,
      resolved_by_actor_kind: validated.resolver.actorKind,
      resolved_by_actor_id: validated.resolver.actorId,
    })
    .eq("id", approvalRequestId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select(APR_COLUMNS)
    .maybeSingle();

  if (updateError) return { status: "error", message: updateError.message };
  if (updatedRow) return { status: "resolved", approvalRequest: toGovernanceApprovalRequest(updatedRow) };

  // Affected 0 rows: either not_found (wrong tenant/id) or already resolved
  // (by this same call retried, or by the other side of a race) — re-read
  // the tenant-scoped row to tell them apart, never guess (same idiom as
  // transitionExecutionAttention()).
  const { data: currentRow, error: readError } = await c
    .from("tact_governance_approval_requests")
    .select(APR_COLUMNS)
    .eq("id", approvalRequestId)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) return { status: "error", message: readError.message };
  if (!currentRow) return { status: "not_found" };
  return { status: "already_resolved", approvalRequest: toGovernanceApprovalRequest(currentRow) };

}

export async function approveGovernanceApprovalRequest(
  approvalRequestId: string,
  userId: string,
  resolver: GovernanceApprovalResolver,
  deps: GovernanceStoreDeps = defaults
): Promise<ResolveGovernanceApprovalRequestOutcome> {
  return transitionGovernanceApprovalRequest(approvalRequestId, userId, "approved", resolver, deps);
}

export async function rejectGovernanceApprovalRequest(
  approvalRequestId: string,
  userId: string,
  resolver: GovernanceApprovalResolver,
  deps: GovernanceStoreDeps = defaults
): Promise<ResolveGovernanceApprovalRequestOutcome> {
  return transitionGovernanceApprovalRequest(approvalRequestId, userId, "rejected", resolver, deps);
}
