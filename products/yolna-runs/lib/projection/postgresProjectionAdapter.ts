// =========================
// Yolna Runs Standalone — Postgres-backed Projection Adapter (SOR-135 Phase 3)
// =========================
//
// Standalone Runs' OWN implementation of WorkProjectionRepository /
// ConversationLinkRepository (read side, @tact/execution-contract,
// consumed via @tact/runs-core's projection registry) and
// WorkProjectionWriter / ConversationLinkProjectionWriter (write side —
// the Yolna -> Runs projection contract). Reads/writes ONLY this
// deployment's own tact_runs_work_projection /
// tact_runs_conversation_link_projection tables
// (products/yolna-runs/supabase/migrations/20270101000002_create_tact_runs_projection.sql)
// via this app's own Supabase service-role client.
//
// This is NOT core/tact-execution-yolna-adapter (which lives in the root
// Yolna application and queries Yolna's own tact-work store) — this file
// has no dependency on Yolna's source tree, database, or credentials at
// all, and must never be imported from anywhere in the root Yolna
// application. It is the thing SOR-135 Phase 1/2 deferred: "Yolna
// compatibility adapterは含めない。DB projection実装はPhase 3で行う"
// (Phase 2 completion report) — this is that Phase 3 implementation.
//
// Self-registers on import (same pattern as core/tact-execution-yolna-adapter):
// importing this module for its exports is what makes
// getWorkViaRegistry()/listWorkTitlesByIdsViaRegistry() in
// @tact/runs-core/tact-execution/projection/registry actually resolve
// data here, instead of throwing "no repository registered".

import { getServiceRoleClient } from "@tact/runs-core/database/supabaseServiceRole";
import {
  setWorkProjectionRepository,
  setConversationLinkRepository,
} from "@tact/runs-core/tact-execution/projection/registry";
import type {
  WorkReference,
  WorkProjectionRepository,
  ConversationLinkReference,
  ConversationLinkRepository,
  ConversationLinkLookupInput,
  ListRecentWorksForUserOptions,
  WorkProjectionWriter,
  WorkProjectionUpsertInput,
  ConversationLinkProjectionWriter,
  ConversationLinkProjectionUpsertInput,
} from "@tact/execution-contract";

interface WorkProjectionRow {
  external_work_id: string;
  title: string | null;
  status: string;
  conversation_reference: string | null;
}

function toWorkReference(row: WorkProjectionRow): WorkReference {
  return {
    id: row.external_work_id,
    title: row.title,
    status: row.status,
    conversationId: row.conversation_reference,
  };
}

const WORK_PROJECTION_COLUMNS = "external_work_id, title, status, conversation_reference";

// Fail closed, not fail silent (SOR-135 Phase 3): every read method below
// returns/throws based on what the service-role client actually reports.
// If SUPABASE_SERVICE_ROLE_KEY/NEXT_PUBLIC_SUPABASE_URL are not configured
// for this deployment, getServiceRoleClient() returns null and every
// method here throws — exactly the same "no repository usable" signal the
// registry itself raises when nothing is registered at all, never a
// fabricated empty result.
function requireClient() {
  const client = getServiceRoleClient();
  if (!client) {
    throw new Error(
      "[yolna-runs/lib/projection] Supabase service role is not configured " +
      "(NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — cannot read or write the Runs projection store."
    );
  }
  return client;
}

export const postgresWorkProjectionRepository: WorkProjectionRepository = {

  async getWork(workId: string, userId: string): Promise<WorkReference | undefined> {

    const client = requireClient();

    const { data } = await client
      .from("tact_runs_work_projection")
      .select(WORK_PROJECTION_COLUMNS)
      .eq("external_work_id", workId)
      .eq("user_id", userId)
      .maybeSingle();

    return data ? toWorkReference(data as WorkProjectionRow) : undefined;

  },

  async listWorksForConversation(conversationId: string, userId: string): Promise<WorkReference[]> {

    const client = requireClient();

    const { data } = await client
      .from("tact_runs_work_projection")
      .select(WORK_PROJECTION_COLUMNS)
      .eq("conversation_reference", conversationId)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    return (data ?? []).map((row) => toWorkReference(row as WorkProjectionRow));

  },

  // Standalone Runs has no Notion resource -> Work evidence projection yet
  // (no writer populates one) — correctly returns "no candidates", not a
  // guess, consistent with the Never Guess Rule every other stage in this
  // pipeline already follows.
  async listWorksForNotionResource(): Promise<WorkReference[]> {
    return [];
  },

  async listRecentWorksForUser(
    userId: string,
    _accessToken: string,
    options?: ListRecentWorksForUserOptions
  ): Promise<WorkReference[]> {

    const client = requireClient();

    const { data } = await client
      .from("tact_runs_work_projection")
      .select(WORK_PROJECTION_COLUMNS)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(options?.limit ?? 5);

    return (data ?? []).map((row) => toWorkReference(row as WorkProjectionRow));

  },

  async listWorkTitlesByIds(
    workIds: readonly string[],
    userId: string
  ): Promise<Map<string, string | null>> {

    const titles = new Map<string, string | null>();

    if (workIds.length === 0) {
      return titles;
    }

    const client = requireClient();

    const { data } = await client
      .from("tact_runs_work_projection")
      .select("external_work_id, title")
      .in("external_work_id", [...new Set(workIds)])
      .eq("user_id", userId);

    for (const row of (data ?? []) as Array<{ external_work_id: string; title: string | null }>) {
      titles.set(row.external_work_id, row.title);
    }

    return titles;

  },

};

export const postgresConversationLinkRepository: ConversationLinkRepository = {

  async findConversationLink(input: ConversationLinkLookupInput): Promise<ConversationLinkReference | null> {

    const client = requireClient();

    let query = client
      .from("tact_runs_conversation_link_projection")
      .select("conversation_reference")
      .eq("channel", input.channel)
      .eq("external_conversation_id", input.externalConversationId);

    query = input.externalWorkspaceId
      ? query.eq("external_workspace_id", input.externalWorkspaceId)
      : query.is("external_workspace_id", null);

    query = input.externalThreadId
      ? query.eq("external_thread_id", input.externalThreadId)
      : query.is("external_thread_id", null);

    const { data } = await query.maybeSingle();

    return data ? { conversationId: (data as { conversation_reference: string }).conversation_reference } : null;

  },

};

export const postgresWorkProjectionWriter: WorkProjectionWriter = {

  async upsertWork(input: WorkProjectionUpsertInput): Promise<void> {

    const client = requireClient();

    const { error } = await client
      .from("tact_runs_work_projection")
      .upsert(
        {
          external_work_id: input.externalWorkId,
          user_id: input.userId,
          title: input.title,
          status: input.status,
          conversation_reference: input.conversationReference,
        },
        { onConflict: "external_work_id" }
      );

    if (error) {
      throw new Error(`[yolna-runs/lib/projection] upsertWork failed: ${error.message}`);
    }

  },

};

export const postgresConversationLinkProjectionWriter: ConversationLinkProjectionWriter = {

  // Not a plain .upsert({onConflict: "..."}) call: the table's uniqueness
  // (channel, coalesce(external_workspace_id, ''), external_conversation_id,
  // coalesce(external_thread_id, '')) is an EXPRESSION index — Postgres
  // requires the ON CONFLICT target to list those same expressions, which
  // Supabase-js's onConflict option (a plain column-name list) cannot
  // express. Select-then-update-or-insert instead; this writer is a
  // low-frequency path (one row per Slack channel/thread), not a hot loop,
  // so the extra round trip is an acceptable, correct trade-off over a
  // fragile raw-SQL passthrough.
  async upsertConversationLink(input: ConversationLinkProjectionUpsertInput): Promise<void> {

    const client = requireClient();

    let existingQuery = client
      .from("tact_runs_conversation_link_projection")
      .select("id")
      .eq("channel", input.channel)
      .eq("external_conversation_id", input.externalConversationId);

    existingQuery = input.externalWorkspaceId
      ? existingQuery.eq("external_workspace_id", input.externalWorkspaceId)
      : existingQuery.is("external_workspace_id", null);

    existingQuery = input.externalThreadId
      ? existingQuery.eq("external_thread_id", input.externalThreadId)
      : existingQuery.is("external_thread_id", null);

    const { data: existing } = await existingQuery.maybeSingle();

    if (existing) {

      const { error } = await client
        .from("tact_runs_conversation_link_projection")
        .update({ conversation_reference: input.conversationReference, user_id: input.userId })
        .eq("id", (existing as { id: string }).id);

      if (error) {
        throw new Error(`[yolna-runs/lib/projection] upsertConversationLink (update) failed: ${error.message}`);
      }

      return;

    }

    const { error } = await client
      .from("tact_runs_conversation_link_projection")
      .insert({
        user_id: input.userId,
        channel: input.channel,
        external_workspace_id: input.externalWorkspaceId ?? null,
        external_conversation_id: input.externalConversationId,
        external_thread_id: input.externalThreadId ?? null,
        conversation_reference: input.conversationReference,
      });

    if (error) {
      throw new Error(`[yolna-runs/lib/projection] upsertConversationLink (insert) failed: ${error.message}`);
    }

  },

};

let registered = false;

export function registerPostgresProjectionAdapter(): void {

  if (registered) {
    return;
  }

  setWorkProjectionRepository(postgresWorkProjectionRepository);
  setConversationLinkRepository(postgresConversationLinkRepository);
  registered = true;

}

// Self-registers as a side effect of being imported at all — same pattern
// as core/tact-execution-yolna-adapter in the root app.
registerPostgresProjectionAdapter();
