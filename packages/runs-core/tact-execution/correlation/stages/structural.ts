// =========================
// TACT Canonical Execution — Structural Correlator (SOR-52)
// =========================
//
// Correlation Methods優先順位2。WorkとExecutionの構造的な関係
// (Slack channel/thread等の既存context)から候補を絞る。
//
// Slack向けの実装: core/tact-bot/conversationLink/
// supabaseConversationLinkStore.ts(既存、BOT-P2)のfindConversationLink()
// が「Slack channel/thread → TACT Conversation」を既に解決している
// (Bot inbound messageの継続判定に使われている既存資産)。この
// Conversationへcore/tact-work/store.tsのWork.primaryConversationId
// (ARCH-R2)が指す先を、新設のlistWorksForConversation()(同じstore.ts、
// SOR-52で追加、既存Work責務は変更しない読み取り専用query)で引く
// ことで、「同じexternal resource/contextが既存Workへ関連付けられて
// いる場合、それをcandidateにする」という指示をそのまま実装する。
//
// 新しいConversation⇄Work相関の仕組みを新設しない(既存資産の再利用、
// SOR-52指示「新しいWork概念は作らない」)。
//
// SOR-52 Closeout Hardening Part8(blocker、解消済み):
// findConversationLink()(core/tact-bot/conversationLink/、BOT-P2)は
// externalWorkspaceIdを一意性の一部として受け取るようになった
// (supabase/migrations/
// 20261024000000_add_workspace_scope_to_tact_bot_conversation_links.sql)。
// このstageもcontext.slack.teamIdをそのまま渡す——workspace不明のまま
// 相関することも、異なるworkspaceのchannel ID衝突で誤相関することも
// 構造的に無くなった。

// SOR-135 Phase 1 (Runs isolation): no static import of core/tact-bot or
// core/tact-work here. The Structural Correlator depends only on the
// product-neutral WorkProjectionRepository/ConversationLinkRepository
// contracts (core/execution-contract), resolved lazily through the
// registry (../../projection/registry) — never a direct import of Yolna's
// conversationLink/Work stores. getServiceRoleKey stays a direct import:
// it is shared DB-access infra (core/database/supabaseServiceRole), not
// Yolna application/business logic.
import { getServiceRoleKey as defaultGetServiceRoleKey } from "../../../database/supabaseServiceRole";
import { getWorkProjectionRepository, getConversationLinkRepository } from "../../projection/registry";
import type { WorkReference, WorkProjectionRepository, ConversationLinkRepository } from "@tact/execution-contract";
import type { CanonicalExecution } from "../../types";
import type { CorrelationContext, WorkCorrelationDecision } from "../types";
import { CORRELATOR_VERSION } from "../version";
import { STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE, STRUCTURAL_AMBIGUOUS_CONFIDENCE } from "../confidencePolicy";

export interface StructuralCorrelationDeps {

  findConversationLink: ConversationLinkRepository["findConversationLink"];

  listWorksForConversation: WorkProjectionRepository["listWorksForConversation"];

  // SOR-53(Notion Structural Correlator)。listWorksForConversation()と
  // 対になる、Notion resource ref向けの読み取り専用query
  // (WorkProjectionRepository、既存evidenceRefsをそのまま照会するだけ)。
  listWorksForNotionResource: WorkProjectionRepository["listWorksForNotionResource"];

  getServiceRoleKey: typeof defaultGetServiceRoleKey;

}

// 遅延解決(絶対条件、SOR-135): registryのgetterは実際に呼ばれるまで
// 評価されない(store.tsのdefaultResolveTargetWorkForCorrelationDepsと
// 同じ設計)。
export const defaultStructuralCorrelationDeps: StructuralCorrelationDeps = {
  findConversationLink: (input) => getConversationLinkRepository().findConversationLink(input),
  listWorksForConversation: (conversationId, userId, accessToken) =>
    getWorkProjectionRepository().listWorksForConversation(conversationId, userId, accessToken),
  listWorksForNotionResource: (resourceRef, userId, accessToken) =>
    getWorkProjectionRepository().listWorksForNotionResource(resourceRef, userId, accessToken),
  getServiceRoleKey: defaultGetServiceRoleKey,
};

function buildDecisionFromCandidateWorks(
  execution: CanonicalExecution,
  works: WorkReference[],
  matchedReasonCode: string
): WorkCorrelationDecision | null {

  if (works.length === 0) {
    return null;
  }

  const correlatedAt = new Date().toISOString();

  if (works.length === 1) {

    return {
      executionId: execution.id,
      status: "matched",
      workId: works[0].id,
      method: "structural",
      confidence: STRUCTURAL_SINGLE_CANDIDATE_CONFIDENCE,
      reasonCode: matchedReasonCode,
      correlatorVersion: CORRELATOR_VERSION,
      candidateWorkIds: [works[0].id],
      correlatedAt,
    };

  }

  // 絶対条件(Never Guess Rule): candidateが複数ある場合、差が無い限り
  // 自動確定しない——ambiguousとして安全に残す。
  return {
    executionId: execution.id,
    status: "ambiguous",
    workId: null,
    method: "structural",
    confidence: STRUCTURAL_AMBIGUOUS_CONFIDENCE,
    reasonCode: "multiple_works_share_structural_context",
    correlatorVersion: CORRELATOR_VERSION,
    candidateWorkIds: works.map((w) => w.id),
    correlatedAt,
  };

}

async function runSlackStructuralCorrelation(
  execution: CanonicalExecution,
  slack: NonNullable<CorrelationContext["slack"]>,
  userId: string,
  accessToken: string,
  deps: StructuralCorrelationDeps
): Promise<WorkCorrelationDecision | null> {

  if (slack.threadTs) {

    const threadLink = await deps.findConversationLink({
      channel: "slack",
      externalWorkspaceId: slack.teamId,
      externalConversationId: slack.channel,
      externalThreadId: slack.threadTs,
    });

    if (threadLink) {

      const works = await deps.listWorksForConversation(threadLink.conversationId, userId, accessToken);
      const decision = buildDecisionFromCandidateWorks(execution, works, "slack_thread_match");

      if (decision) {
        return decision;
      }

    }

  }

  // thread単位のconversation linkが無い(またはWorkが無い)場合、
  // channel単位のconversation link(thread指定なし)でも試す
  // ——thread単位より弱いが、依然として構造的な証拠である。
  const channelLink = await deps.findConversationLink({
    channel: "slack",
    externalWorkspaceId: slack.teamId,
    externalConversationId: slack.channel,
  });

  if (!channelLink) {
    return null;
  }

  const works = await deps.listWorksForConversation(channelLink.conversationId, userId, accessToken);

  return buildDecisionFromCandidateWorks(execution, works, "slack_channel_match");

}

// SOR-53: Slackのchannel/thread → Conversation → Workと同じ精神で、
// Notion resource ref → Work(既存WorkEvidenceReference、
// evidenceRefsのsourceType="notion")を照会する。新しいConversation⇄Work
// 相関の仕組みは作らない(structural.ts冒頭コメントの既存方針をそのまま
// 踏襲)。
async function runNotionStructuralCorrelation(
  execution: CanonicalExecution,
  notion: NonNullable<CorrelationContext["notion"]>,
  userId: string,
  accessToken: string,
  deps: StructuralCorrelationDeps
): Promise<WorkCorrelationDecision | null> {

  const works = await deps.listWorksForNotionResource(notion.resourceRef, userId, accessToken);

  return buildDecisionFromCandidateWorks(execution, works, "notion_resource_match");

}

// nullを返す規律(=このstageでは決められない、次のstageへ委ねる)は
// stages/explicit.ts・stages/temporalParticipant.tsと共通。
export async function runStructuralCorrelation(
  execution: CanonicalExecution,
  context: CorrelationContext,
  deps: StructuralCorrelationDeps = defaultStructuralCorrelationDeps
): Promise<WorkCorrelationDecision | null> {

  if (!context.slack && !context.notion) {
    // SlackとNotionがM-0の実装対象(Slack Initial Vertical Slice +
    // SOR-53 Notion接続)。他providerは将来この関数へ新しいbranchを
    // 足す形で拡張する(Adapter Boundaryと同じ方針)。
    return null;
  }

  const accessToken = deps.getServiceRoleKey();

  if (!accessToken) {
    // fail safe: Structural Correlatorが機能しなくても、呼び出し元は
    // 次のstageへ進み、最終的にunresolvedへ倒れるだけであり、誤った
    // Workへの紐付けは発生しない。
    return null;
  }

  if (context.slack) {
    const decision = await runSlackStructuralCorrelation(execution, context.slack, context.userId, accessToken, deps);
    if (decision) {
      return decision;
    }
  }

  if (context.notion) {
    const decision = await runNotionStructuralCorrelation(execution, context.notion, context.userId, accessToken, deps);
    if (decision) {
      return decision;
    }
  }

  return null;

}
