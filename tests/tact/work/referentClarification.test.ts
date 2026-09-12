// =========================
// TACT Work — Referent Clarification Lifecycle Regression (REF-P1d)
// =========================
//
// 対象: core/tact-work/clarification.tsのrequestReferentClarification()/
// resolveClarification()(referent-selection validation seam)。実
// Supabaseには一切接続しない(ClarificationExecutionDeps経由でStore
// 呼び出しを偽実装に差し替える、既存tests/tact/work/clarification.test.ts
// と同じDI手法)。

import {
  requestReferentClarification,
  resolveClarification,
  type RequestReferentClarificationDeps,
} from "../../../core/tact-work/clarification";
import type { Clarification, Work, WorkStatus } from "../../../core/tact-work/types";
import {
  buildCandidateSnapshot,
  computeReferentClarificationExpiresAt,
  hashCandidateSnapshot,
  resolveReferentClarificationSelection,
} from "../../../core/tact-referent/clarification";
import { candidate } from "../referent/fixtures";
import { check, summarize, type CheckResult } from "../lib/check";

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "work-1",
    userId: "user-1",
    createdByActorKind: "user",
    createdByActorId: "user-1",
    status: "waiting_for_input",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const CANDIDATE_A = candidate({ messageId: "m-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" });
const CANDIDATE_B = candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "お見積りについて", direction: "inbound" });

const FIXED_NOW = new Date("2026-09-11T09:00:00.000Z");

function makeFakeBackend(works: Record<string, string>, allowedResponderIds: string[] | null = null) {

  const clarifications = new Map<string, Clarification>();
  const workStatuses = new Map<string, WorkStatus>(Object.keys(works).map((id) => [id, "waiting_for_input" as WorkStatus]));
  let nextId = 1;

  const getWork = async (workId: string, userId: string): Promise<Work | undefined> => {
    if (works[workId] !== userId) return undefined;
    return makeWork({ id: workId, userId, status: workStatuses.get(workId) ?? "waiting_for_input" });
  };

  const deps: RequestReferentClarificationDeps = {

    getWork,

    createClarification: async (workId, userId, _accessToken, params) => {
      const work = await getWork(workId, userId);
      if (!work) return undefined;
      const id = `clarification-${nextId++}`;
      const clarification: Clarification = {
        id,
        workId,
        taskId: params.taskId ?? null,
        requestedByActorKind: params.requestedByActorKind,
        requestedByActorId: params.requestedByActorId,
        allowedResponderIds: params.allowedResponderIds ?? allowedResponderIds,
        status: "pending",
        reasonCode: params.reasonCode,
        question: params.question,
        response: null,
        respondedByActorKind: null,
        respondedByActorId: null,
        requestedAt: "2026-09-06T00:00:00.000Z",
        respondedAt: null,
        expiresAt: params.expiresAt ?? null,
        createdAt: "2026-09-06T00:00:00.000Z",
        candidateSnapshot: params.candidateSnapshot ?? null,
        candidateSnapshotHash: params.candidateSnapshotHash ?? null,
      };
      clarifications.set(id, clarification);
      return clarification;
    },

    getClarification: async (workId, userId, _accessToken, clarificationId) => {
      const work = await getWork(workId, userId);
      if (!work) return undefined;
      const clarification = clarifications.get(clarificationId);
      return clarification && clarification.workId === workId ? clarification : undefined;
    },

    // 絶対条件(REF-P1d): candidate_snapshot/candidate_snapshot_hashは
    // 作成後にmutateされない——この偽実装はstatus/response関連の
    // fieldのみを更新し、snapshot/hashには一切触れない(本番
    // store.ts.updateClarificationStatus()と同じ不変性)。
    updateClarificationStatus: async (workId, userId, _accessToken, clarificationId, status, params) => {
      const work = await getWork(workId, userId);
      if (!work) return;
      const clarification = clarifications.get(clarificationId);
      if (clarification && clarification.workId === workId) {
        clarifications.set(clarificationId, {
          ...clarification,
          status,
          respondedAt: "2026-09-06T00:01:00.000Z",
          response: params?.response ?? null,
          respondedByActorKind: params?.respondedByActorKind ?? null,
          respondedByActorId: params?.respondedByActorId ?? null,
        });
      }
    },

    listClarificationsForWork: async (workId, userId) => {
      const work = await getWork(workId, userId);
      if (!work) return [];
      return [...clarifications.values()].filter((c) => c.workId === workId);
    },

    updateWorkStatus: async (workId, _userId, _accessToken, status) => {
      workStatuses.set(workId, status);
    },

    emitAuditEvent: async () => {},

    resolveReferentClarificationSelection,

    now: () => FIXED_NOW,

    buildCandidateSnapshot,

    hashCandidateSnapshot,

    computeReferentClarificationExpiresAt,

  };

  return { deps, clarifications, getWorkStatus: (workId: string) => workStatuses.get(workId) };

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // 1. requestReferentClarification()はcandidate snapshot/hashを構築し、
  // WRITE TTL(24h)を既定expiresAtとして適用する。
  {
    const { deps } = makeFakeBackend({ "work-1": "user-1" });

    const clarification = await requestReferentClarification(
      {
        workId: "work-1",
        requestedByActor: { kind: "ai", id: "gmail-referent" },
        question: "1. 更新のご連絡 / 2. お見積りについて",
        candidates: [CANDIDATE_A, CANDIDATE_B],
      },
      "user-1",
      "token-1",
      deps
    );

    results.push(
      check(
        "[REF-P1d work/referentClarification] 1. requestReferentClarification()はcandidate_snapshot(2件、安定index)とhashを持つClarificationを作成し、既定で24h後のexpiresAtを設定する",
        !!clarification &&
          clarification.candidateSnapshot?.length === 2 &&
          !!clarification.candidateSnapshotHash &&
          clarification.expiresAt === new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString()
      )
    );
  }

  // 2. valid selectionはanswered + referentSelectionを返す
  {
    const { deps } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestReferentClarification(
      { workId: "work-1", requestedByActor: { kind: "ai", id: "gmail-referent" }, question: "q", candidates: [CANDIDATE_A, CANDIDATE_B] },
      "user-1", "token-1", deps
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "2", deps
    );

    results.push(
      check(
        "[REF-P1d work/referentClarification] 2. 有効な選択(\"2\")はansweredへ遷移し、referentSelectionにcandidate 2(m-b)を含む",
        outcome.status === "answered" && outcome.status === "answered" &&
          outcome.referentSelection?.sourceMessageRef === "m-b"
      )
    );
  }

  // 3. 無効な選択(範囲外)はansweredにならず、Clarificationはpendingの
  // ままになる
  {
    const { deps, clarifications } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestReferentClarification(
      { workId: "work-1", requestedByActor: { kind: "ai", id: "gmail-referent" }, question: "q", candidates: [CANDIDATE_A, CANDIDATE_B] },
      "user-1", "token-1", deps
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "3", deps
    );

    results.push(
      check(
        "[REF-P1d work/referentClarification] 3. 範囲外の選択(\"3\")はinvalid_referent_selectionを返し、Clarificationはansweredにならずpendingのまま残る",
        outcome.status === "invalid_referent_selection" &&
          clarifications.get(clarification!.id)?.status === "pending"
      )
    );
  }

  // 4. 期限切れの選択はstaleとして拒否され、pendingのまま残る
  {
    const { deps, clarifications } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestReferentClarification(
      {
        workId: "work-1",
        requestedByActor: { kind: "ai", id: "gmail-referent" },
        question: "q",
        candidates: [CANDIDATE_A, CANDIDATE_B],
        expiresAt: "2026-09-10T00:00:00.000Z", // FIXED_NOW(9/11)より過去
      },
      "user-1", "token-1", deps
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "1", deps
    );

    results.push(
      check(
        "[REF-P1d work/referentClarification] 4. 期限切れのClarificationへの選択はinvalid_referent_selection(stale)を返し、pendingのまま残る(黙って新しいcandidateへ再解決しない)",
        outcome.status === "invalid_referent_selection" &&
          outcome.status === "invalid_referent_selection" && outcome.selection.status === "stale" &&
          clarifications.get(clarification!.id)?.status === "pending"
      )
    );
  }

  // 5. selectionはApprovalを一切作成/参照しない(構造的確認: このtest
  // file・core/tact-work/clarification.tsのimportにApproval関連moduleが
  // 存在しないことは型検査自体が保証する。ここではoutcomeの形自体に
  // Approval関連fieldが無いことを確認する)。
  {
    const { deps } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestReferentClarification(
      { workId: "work-1", requestedByActor: { kind: "ai", id: "gmail-referent" }, question: "q", candidates: [CANDIDATE_A] },
      "user-1", "token-1", deps
    );
    const outcome = await resolveClarification(
      "work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "1", deps
    );
    const serialized = JSON.stringify(outcome);

    results.push(
      check(
        "[REF-P1d work/referentClarification] 5. selection結果にApproval/policy/execution相当のfieldや語彙が一切含まれない(selection ≠ Approval)",
        outcome.status === "answered" && !serialized.toLowerCase().includes("approv") && !serialized.toLowerCase().includes("policy")
      )
    );
  }

  // 6. 既存の汎用(自由記述)Clarificationは後方互換のまま動作する
  {
    const { deps, clarifications } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await deps.createClarification(
      "work-1", "user-1", "token-1",
      {
        requestedByActorKind: "ai",
        requestedByActorId: "slack-send",
        reasonCode: "missing_required_input",
        question: "どのチャンネルへ送信しますか?",
        // candidateSnapshot/candidateSnapshotHashを一切渡さない
        // ——既存の自由記述Clarification相当。
      }
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "#general", deps
    );

    results.push(
      check(
        "[REF-P1d work/referentClarification] 6. candidate_snapshotを持たない既存の自由記述Clarificationは、任意のtext回答でこれまで通りansweredへ遷移する(referent-selection validation seamを一切通過しない、後方互換性)",
        outcome.status === "answered" && outcome.status === "answered" && outcome.clarification.response === "#general" &&
          clarifications.get(clarification!.id)?.candidateSnapshot === null
      )
    );
  }

  // 7. allowed_responder_ids: 許可されていないresponderは選択できない
  {
    const { deps } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestReferentClarification(
      {
        workId: "work-1",
        requestedByActor: { kind: "ai", id: "gmail-referent" },
        question: "q",
        candidates: [CANDIDATE_A, CANDIDATE_B],
        allowedResponderIds: ["user-1"],
      },
      "user-1", "token-1", deps
    );

    const outcome = await resolveClarification(
      "work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-2" }, "1", deps
    );

    results.push(
      check(
        "[REF-P1d work/referentClarification] 7. allowed_responder_idsに含まれないresponderは、pinされたselectionを解決できない(responder_not_allowed、既存ownership機構をそのまま再利用)",
        outcome.status === "responder_not_allowed"
      )
    );
  }

  // 8. 反復解決: 一度answeredになったClarificationへ別の回答を送っても
  // 別のcandidateへ再解決されない(idempotency)。
  {
    const { deps } = makeFakeBackend({ "work-1": "user-1" });
    const clarification = await requestReferentClarification(
      { workId: "work-1", requestedByActor: { kind: "ai", id: "gmail-referent" }, question: "q", candidates: [CANDIDATE_A, CANDIDATE_B] },
      "user-1", "token-1", deps
    );

    const first = await resolveClarification("work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "1", deps);
    const second = await resolveClarification("work-1", "user-1", "token-1", clarification!.id, { kind: "user", id: "user-1" }, "2", deps);

    results.push(
      check(
        "[REF-P1d work/referentClarification] 8. 一度answeredになったClarificationへ別の回答(\"2\")を送っても、already_resolvedを返すだけで別candidateへ黙って再解決されない",
        first.status === "answered" && second.status === "already_resolved"
      )
    );
  }

  // =========================
  // Migration schema validation (additive/nullable/backward compatible)
  // =========================
  {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repoRoot = join(__dirname, "..", "..", "..");
    const migrationSource = readFileSync(
      join(repoRoot, "supabase/migrations/20260922000000_add_referent_clarification_snapshot.sql"),
      "utf-8"
    ).toLowerCase();

    results.push(
      check(
        "[REF-P1d work/referentClarification] migration: candidate_snapshot/candidate_snapshot_hashを追加するのみで、いずれもadd column if not exists + nullable(既存行への影響なし)であり、drop/既存列へのnot null追加・既存RLS policyの変更が一切無い",
        migrationSource.includes("add column if not exists candidate_snapshot") &&
          migrationSource.includes("add column if not exists candidate_snapshot_hash") &&
          !migrationSource.includes("drop column") &&
          !migrationSource.includes("drop policy") &&
          !migrationSource.includes("create policy") &&
          !/candidate_snapshot(_hash)?\s+[a-z]+\s+not null/u.test(migrationSource)
      )
    );
  }

  return summarize("work/referentClarification", results);

}
