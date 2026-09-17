// =========================
// TACT Work — Atomic Event/Wait/Task Claim Regression (EVENT-P1c)
// =========================
//
// 対象: core/tact-work/store.tsのparseEventWaitClaimOutcome()/
// parseCreateEventWaitOutcome()(pure function)、および対応する
// migration(supabase/migrations/20261016000000_add_event_wait_
// correlation_constraints.sql・20261016010000_create_event_wait_
// claim_functions.sql)。
//
// 絶対条件(既存規約、eventModel.test.ts/coreSectionAuth.test.tsと
// 同じ理由): このrepositoryは実Supabase接続を伴うtestを持たない。
// matchAndClaimExternalEvent()/createEventWaitAndReconcile()自身は
// (このfileの他の全関数と異なり)WorkOwnershipDeps相当のDI seamを
// 持たず、常に実createRequestScopedClient()経由でRPCへ到達するため
// (Section18「SECURITY INVOKER、ownership checkはauth.uid()に委ねる」
// 設計の帰結——アプリ層に事前ownership checkが無い)、これらの関数
// 自体を直接呼び出すtestは書かない(実DBへの到達を防げないため)。
// jsonb parsing部分だけをpure functionとして切り出しdirectテストし、
// SQL function自体のatomicity/CAS/exclusion logicはmigration source
// のtext検査で構造的に確認する(接続して確かめる代わりに「そう
// 書かれていること」を確認する、既存precedent)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEventWaitClaimOutcome,
  parseCreateEventWaitOutcome,
} from "../../../core/tact-work/store";
import { check, summarize, type CheckResult } from "../lib/check";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

// SQL comment行(「--」始まり)を除外した、実SQL文だけのtext。migration
// 自身のコメントが"SECURITY DEFINERを使わない"ことを説明する目的で
// "SECURITY DEFINER"という語をそのまま含む(絶対条件の説明のため)ため、
// 単純なsubstring検索だと誤ってFAILになる——実際に宣言として書かれて
// いるかどうかだけを見るため、コメントを取り除いてから検索する。
function stripSqlComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // A. parseEventWaitClaimOutcome() / parseCreateEventWaitOutcome()
  // =========================

  results.push(
    check(
      "[parse] wait_claimedの正常な形をそのまま透過する",
      (() => {
        const outcome = parseEventWaitClaimOutcome({
          status: "wait_claimed",
          eventId: "e1",
          waitId: "w1",
          taskId: "t1",
          workId: "wk1",
        });
        return outcome.status === "wait_claimed" && outcome.eventId === "e1" && outcome.waitId === "w1";
      })()
    )
  );

  results.push(
    check(
      "[parse] event_ambiguousのcandidateCountを保持する",
      (() => {
        const outcome = parseEventWaitClaimOutcome({ status: "event_ambiguous", candidateCount: 3 });
        return outcome.status === "event_ambiguous" && outcome.candidateCount === 3;
      })()
    )
  );

  results.push(
    check(
      "[parse] statusフィールドが無いresponseは例外を投げる(malformed、DB層を信用しない)",
      (() => {
        try {
          parseEventWaitClaimOutcome({ foo: "bar" });
          return false;
        } catch {
          return true;
        }
      })()
    )
  );

  results.push(
    check(
      "[parse] nullは例外を投げる",
      (() => {
        try {
          parseEventWaitClaimOutcome(null);
          return false;
        } catch {
          return true;
        }
      })()
    )
  );

  results.push(
    check(
      "[parse] parseCreateEventWaitOutcome(): wait_createdとreconciliationをそのまま透過する",
      (() => {
        const outcome = parseCreateEventWaitOutcome({
          status: "wait_created",
          waitId: "w1",
          taskId: "t1",
          workId: "wk1",
          reconciliation: { status: "event_unmatched" },
        });
        return (
          outcome.status === "wait_created" &&
          outcome.waitId === "w1" &&
          outcome.reconciliation.status === "event_unmatched"
        );
      })()
    )
  );

  results.push(
    check(
      "[parse] parseCreateEventWaitOutcome(): statusが無いresponseは例外を投げる",
      (() => {
        try {
          parseCreateEventWaitOutcome({});
          return false;
        } catch {
          return true;
        }
      })()
    )
  );

  // =========================
  // B. Migration source: partial unique indexes (Section4)
  // =========================

  const constraintsMigration = readRepoFile(
    "supabase/migrations/20261016000000_add_event_wait_correlation_constraints.sql"
  );

  results.push(
    check(
      "[B] (user_id, expected_source, expected_event_type, subject_ref) WHERE status='pending' のpartial unique indexが存在する",
      /create unique index[\s\S]*?idx_tact_event_waits_pending_identity[\s\S]*?on public\.tact_event_waits \(user_id, expected_source, expected_event_type, subject_ref\)[\s\S]*?where status = 'pending'/.test(
        constraintsMigration
      )
    )
  );

  results.push(
    check(
      "[B] (task_id) WHERE status IN ('pending','claimed') のpartial unique indexが存在する",
      /create unique index[\s\S]*?idx_tact_event_waits_active_per_task[\s\S]*?on public\.tact_event_waits \(task_id\)[\s\S]*?where status in \('pending', 'claimed'\)/.test(
        constraintsMigration
      )
    )
  );

  results.push(
    check(
      "[Section18] tact_external_events/tact_event_waitsにUPDATE RLS policy(auth.uid() = user_id)が追加されている",
      /create policy "tact_external_events_update_own"[\s\S]*?for update[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(
        constraintsMigration
      ) &&
        /create policy "tact_event_waits_update_own"[\s\S]*?for update[\s\S]*?using \(auth\.uid\(\) = user_id\)/.test(
          constraintsMigration
        )
    )
  );

  // =========================
  // C. Migration source: transactional RPC functions (Section5/17/18/25)
  // =========================

  const functionsMigration = readRepoFile(
    "supabase/migrations/20261016010000_create_event_wait_claim_functions.sql"
  );

  results.push(
    check(
      "[C] 3つのcanonical function(tact_claim_matched_event_wait/tact_match_and_claim_external_event/tact_create_event_wait)がいずれも定義されている",
      functionsMigration.includes("create or replace function public.tact_claim_matched_event_wait(") &&
        functionsMigration.includes("create or replace function public.tact_match_and_claim_external_event(") &&
        functionsMigration.includes("create or replace function public.tact_create_event_wait(")
    )
  );

  results.push(
    check(
      "[Section18] いずれのfunctionもSECURITY DEFINERを宣言していない(least privilege、SECURITY INVOKERのまま)",
      !/security definer/i.test(stripSqlComments(functionsMigration))
    )
  );

  results.push(
    check(
      "[Section5 Step1] ExternalEvent/EventWait/TaskのSELECTに行ロック(FOR UPDATE)を使っている(TOCTOU対策)",
      /from public\.tact_external_events[\s\S]*?for update/.test(functionsMigration) &&
        /from public\.tact_event_waits[\s\S]*?for update/.test(functionsMigration) &&
        /from public\.tact_tasks t[\s\S]*?for update of t/.test(functionsMigration)
    )
  );

  results.push(
    check(
      "[Section5 Step4-6] EventWait/Task/ExternalEventそれぞれのCAS UPDATE(status='X' WHERE句 + returning)が存在する",
      /update public\.tact_event_waits\s*\n\s*set status = 'claimed'[\s\S]*?where id = v_wait\.id and status = 'pending'\s*\n\s*returning id into v_claimed_wait_id/.test(
        functionsMigration
      ) &&
        /update public\.tact_tasks\s*\n\s*set status = 'pending'[\s\S]*?where id = v_task\.id and status = 'waiting_for_event'\s*\n\s*returning id into v_updated_task_id/.test(
          functionsMigration
        ) &&
        /update public\.tact_external_events\s*\n\s*set status = 'matched'[\s\S]*?where id = v_event\.id and status = 'received'\s*\n\s*returning id into v_updated_event_id/.test(
          functionsMigration
        )
    )
  );

  results.push(
    check(
      "[Section6] expiry判定が receivedAt >= expiresAt (境界含む) で行われている(processing timeではなくreceived_atを使う)",
      /v_wait\.expires_at is not null and v_event\.received_at >= v_wait\.expires_at/.test(functionsMigration)
    )
  );

  results.push(
    check(
      "[Section4] candidate件数を数えてから0/1/2+で分岐している(oldest/firstを選ばない、ambiguousをfail closed)",
      /v_candidate_count = 0/.test(functionsMigration) &&
        /v_candidate_count > 1/.test(functionsMigration) &&
        /'event_ambiguous'/.test(functionsMigration)
    )
  );

  results.push(
    check(
      "[Section7/8] event_unmatchedの分岐でExternalEvent.statusを変更していない(event-before-wait durability、'received'のまま)",
      /if v_candidate_count = 0 then\s*\n\s*return jsonb_build_object\('status', 'event_unmatched'\)/.test(
        functionsMigration
      )
    )
  );

  results.push(
    check(
      "[Section14] terminal Work/Taskの場合、staleなpending EventWaitをcancelする分岐が存在する(Runは作らない)",
      /update public\.tact_event_waits\s*\n\s*set status = 'cancelled'/.test(functionsMigration)
    )
  );

  results.push(
    check(
      "[Section25絶対条件] このmigrationはcreateRun/provider実行(composio等)のいずれも一切参照しない(atomic claimはTask waiting_for_event→pendingまでで終わる)",
      !/create_run|createrun/i.test(functionsMigration) && !/composio/i.test(functionsMigration)
    )
  );

  results.push(
    check(
      "[Section21] Task.work_id <> wait.work_id の明示的な整合性チェックが存在する(task_work_mismatch)",
      /v_task\.work_id <> v_wait\.work_id/.test(functionsMigration) && functionsMigration.includes("task_work_mismatch")
    )
  );

  results.push(
    check(
      "[Section8] tact_create_event_waitは、ちょうど1件のcandidateにのみ自動的にclaimを試み、0件/複数件では試みない(oldest/firstを選ばない)",
      /if v_candidate_count = 1 then\s*\n\s*v_claim_result := public\.tact_claim_matched_event_wait/.test(
        functionsMigration
      )
    )
  );

  return summarize("work/eventWaitClaim", results);

}
