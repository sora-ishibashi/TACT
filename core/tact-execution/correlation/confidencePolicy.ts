// =========================
// TACT Canonical Execution — Correlation Confidence Policy (SOR-76)
// =========================
//
// SOR-76 (CORRELATION-SCORE-P1) audited the existing 4-stage correlator
// (explicit/structural/temporal_participant/ai_assisted, SOR-52/53) against
// Linear's "AUTO_ASSIGNED / SUGGESTED / UNASSIGNED" model and found it
// already implements that exact precision-first policy — just under the
// domain's own existing vocabulary (WorkCorrelationStatus: matched/
// ambiguous/unresolved, product-facing via canonicalResult.ts as CORRELATED/
// AMBIGUOUS/UNASSIGNED). This file does not introduce a fourth status or a
// parallel enum (SOR-53 already decided against that: "新しい重複enumを
// domain内部に増やさない") — it only collects the confidence values each
// stage already used as scattered inline literals into one small, named,
// documented table, so "confidence/score semantics must be documented" and
// "prefer a small rule/weight table" (SOR-76 instructions) have one place to
// live. No stage's decision logic or output changed; only where the numbers
// are defined.
//
// SOR-76 vocabulary <-> existing domain vocabulary (identical states, no
// redesign):
//   AUTO_ASSIGNED -> WorkCorrelationStatus "matched"    -> CanonicalCorrelationResult "CORRELATED"
//   SUGGESTED     -> WorkCorrelationStatus "ambiguous"  -> CanonicalCorrelationResult "AMBIGUOUS"
//   UNASSIGNED    -> WorkCorrelationStatus "unresolved" -> CanonicalCorrelationResult "UNASSIGNED"
// "ambiguous" already carries the candidate Work ids a human needs to see to
// resolve a SUGGESTED decision manually (via reclassify_execution_work(),
// SOR-52) — this is the existing mechanism SUGGESTED means, not a new one.

// ---- Tier 1: Explicit (core/tact-execution/correlation/stages/explicit.ts) ----
// The source's own trusted claim of workId (already validated for tenant/
// state by resolveTargetWorkForCorrelation() before this stage ever runs,
// SOR-74). Certainty is definitional, not scored — 1 is not "high
// confidence," it is "this is not a guess."
export const EXPLICIT_CONFIDENCE = 1;

// ---- Tier 2: Structural (stages/structural.ts) ----
// Exact structural evidence: the Execution's own resource metadata
// (Slack thread/channel via tact_bot_conversation_links, Notion resourceRef
// via Work.evidenceRefs / WorkEntity, SOR-75) resolves to exactly one Work.
// This is real observed evidence, not inference — hence higher than the
// ai_assisted tier below, but intentionally below EXPLICIT_CONFIDENCE
// because it depends on an intermediate resource-identity lookup rather
// than a direct claim.
export const STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE = 0.9;

// Structural evidence resolves to 2+ Works sharing the same external
// context (e.g. the same Slack thread linked to multiple Works). Never
// auto-assigned (Never Guess Rule) — surfaced as SUGGESTED with every
// candidate visible.
export const STRUCTURAL_AMBIGUOUS_CONFIDENCE = 0.5;

// ---- Tier 3: AI-assisted / temporal-participant (stages/aiAssisted.ts) ----
// This stage has no real semantic evidence (no LLM/embeddings — SOR-76
// explicitly forbids adding one here). 2+ recently-active Works for the same
// user: SUGGESTED, never auto-assigned. Exactly 1 candidate: still never
// auto-assigned on recency alone (SOR-52 Closeout Hardening Part5) — that
// single candidate is deliberately dropped to UNASSIGNED, not surfaced as
// SUGGESTED, because recency alone is not evidence of *which* Work an
// Execution belongs to (Linear's own SOR-76 guidance: "temporal proximity
// alone should probably remain UNASSIGNED").
export const AI_ASSISTED_AMBIGUOUS_CONFIDENCE = 0.5;

// =========================
// Signals explicitly NOT implemented (audited and rejected, not omitted by
// oversight) — SOR-76 instruction: "do not implement signals that
// repository reality cannot support safely yet."
// =========================
//
// "same principal / agent" (Linear's SOR-76 signal list): CanonicalExecution.
// actorId is the external provider's own actor id (a Slack user id, a Notion
// principalId — core/tact-execution/types.ts). Work.createdByActorId, for
// the overwhelmingly common kind="user" case, is always the TACT-internal
// auth.users.id (core/tact-work/types.ts ActorReference comment). These are
// two different identifier namespaces with no resolved mapping available at
// this correlation boundary — every existing adapter/identity-resolver
// (BOT-P2.5, trustedConversationTurn.ts) treats "trust the internal id only
// after resolving the external one" as an absolute boundary, and no adapter
// currently populates CanonicalExecution.onBehalfOfActorId (the one field
// that could plausibly carry a resolved internal identity) at all. Comparing
// execution.actorId to work.createdByActorId directly would therefore not be
// a weak-but-real signal — it would be a near-always-false, occasionally
// coincidentally-true comparison across unrelated ID spaces: a fabricated
// signal, not evidence. SOR-52 already tested and rejected "principal alone"
// as an auto-match signal (notionM0.test.ts Required test 8/9); this file
// documents the deeper reason a "principal + temporal" SUGGESTED-tier
// combination (as Linear's ticket text suggested) is not implemented either.
// A safe version of this signal needs a real external-actor -> internal-user
// resolution step at the correlation boundary first, which is out of scope
// for this deterministic-baseline issue.
//
// "canonical entity overlap": WorkEvidenceReference.canonicalEntityId
// (SOR-75) is a reserved field with zero producers or consumers anywhere in
// the repository. There is no entity-resolution/dedup logic to reuse and
// building one is explicitly out of scope here (SOR-76: "do not implement
// automatic Work discovery"). Nothing exists yet to score against.
