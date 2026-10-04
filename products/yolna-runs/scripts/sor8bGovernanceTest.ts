// Local, no-cloud SOR-8B contract proof: evaluator evidence and migration shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGovernanceDecisionFromRegistry, policySetFingerprint } from "@tact/runs-core/tact-execution/governance/evaluate";
import type { GovernanceInvocation } from "@tact/runs-core/tact-execution/governance/types";
import type { PermissionRegistryRule } from "@tact/runs-core/tact-execution/permission";

const invocation: GovernanceInvocation = { id:"00000000-0000-0000-0000-000000000001",userId:"00000000-0000-0000-0000-000000000002",organizationId:null,workspaceId:null,workId:null,connectionId:null,actorKind:"ai_agent",actorId:"agent-1",agentId:"agent-1",onBehalfOfActorKind:null,onBehalfOfActorId:null,actionCategory:"update",operation:"notion_update_page",resourceType:"notion_page",resourceIdentifier:"page-1",targetProvider:"notion",attemptedAt:"2027-01-01T00:00:00.000Z",createdAt:"2027-01-01T00:00:00.000Z" };
const rule = (id:string, revision:number, priority=0): PermissionRegistryRule => ({ id,userId:invocation.userId,identifier:`rule-${id}`,revision,subjectKind:"ai_agent",actorId:null,agentId:null,provider:null,targetProvider:"notion",resourceType:"notion_page",actionCategory:"update",decision:"approval_required",reasonCode:"approval_required",requiresKnownActorId:false,requiresKnownAgentId:false,connectionId:null,priority,validFrom:null,validUntil:null,enabled:true,createdAt:"2027-01-01T00:00:00.000Z",updatedAt:"2027-01-01T00:00:00.000Z" });
const at = new Date("2027-01-01T00:00:00.000Z");
const matched = buildGovernanceDecisionFromRegistry(invocation,"00000000-0000-0000-0000-000000000003",[rule("a",1)],at);
assert.equal(matched.verdict,"APPROVAL_REQUIRED"); assert.equal((matched.runsPermissionSnapshot as {kind:string}).kind,"matched_rule");
const ambiguous = buildGovernanceDecisionFromRegistry(invocation,"00000000-0000-0000-0000-000000000004",[rule("a",1),rule("b",2)],at);
assert.equal(ambiguous.verdict,"UNKNOWN"); assert.equal((ambiguous.runsPermissionSnapshot as {kind:string}).kind,"ambiguous"); assert.equal(((ambiguous.runsPermissionSnapshot as {candidates:unknown[]}).candidates).length,2);
assert.notEqual(policySetFingerprint([rule("a",1)],at),policySetFingerprint([rule("a",2)],at));
const migration=readFileSync(join(__dirname,"../supabase/migrations/20270101000013_create_tact_governance_invocations_decisions.sql"),"utf8");
for(const required of ["tact_governance_invocations","tact_governance_decisions","tact_governance_invocation_execution_links","unique (execution_id)","runs_permission_snapshot","policy_set_fingerprint","effective_governance_decision_id","tact_governance_invocations_select_own"]) assert.ok(migration.includes(required),required);
console.log("SOR8B_FOCUSED_TESTS=8/8");
