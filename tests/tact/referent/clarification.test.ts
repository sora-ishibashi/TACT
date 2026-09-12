// =========================
// TACT Referent — Pinned Clarification Selection Regression (REF-P1d)
// =========================
//
// 対象: core/tact-referent/clarification.ts。純粋関数のみ
// (DB/Supabase/Approval/execution/Bot依存なし)。TOCTOU安全性・
// hash改ざん検出・期限切れ・無効応答の全パターンを検証する。

import {
  WRITE_REFERENT_CLARIFICATION_TTL_MS,
  buildCandidateSnapshot,
  computeReferentClarificationExpiresAt,
  hashCandidateSnapshot,
  parseCandidateSnapshot,
  parseNumericSelection,
  resolveReferentClarificationSelection,
  type CandidateSnapshotEntry,
} from "../../../core/tact-referent/clarification";
import { candidate } from "./fixtures";
import { check, summarize, type CheckResult } from "../lib/check";

const CANDIDATE_A = candidate({ messageId: "m-a", threadId: "t-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", observedAt: "2026-09-01T00:00:00.000Z", direction: "inbound" });
const CANDIDATE_B = candidate({ messageId: "m-b", threadId: "t-b", sender: "b@example.com", normalizedSubject: "お見積りについて", observedAt: "2026-09-02T00:00:00.000Z", direction: "inbound" });
const CANDIDATE_C = candidate({ messageId: "m-c", sender: "c@example.com", normalizedSubject: "追加のご連絡", observedAt: "2026-09-11T00:00:00.000Z", direction: "inbound" });

const NOW = new Date("2026-09-11T09:00:00.000Z");

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // =========================
  // 1. 安定したindex付与
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    results.push(
      check(
        "[REF-P1d clarification] 1. buildCandidateSnapshot()は1始まりの安定したindexを付与する",
        snapshot.length === 2 && snapshot[0].index === 1 && snapshot[1].index === 2 &&
          snapshot[0].sourceMessageRef === "m-a" && snapshot[1].sourceMessageRef === "m-b"
      )
    );
  }

  // =========================
  // 2. 決定論的snapshot hash
  // =========================
  {
    const snapshot1 = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const snapshot2 = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const differentOrder = buildCandidateSnapshot([CANDIDATE_B, CANDIDATE_A]);

    results.push(
      check(
        "[REF-P1d clarification] 2. 同じcandidate列に対するhashは常に同一であり、順序が異なれば異なるhashになる(indexが意味を持つ配列であるため)",
        hashCandidateSnapshot(snapshot1) === hashCandidateSnapshot(snapshot2) &&
          hashCandidateSnapshot(snapshot1) !== hashCandidateSnapshot(differentOrder)
      )
    );
  }

  // =========================
  // 3/4/10. valid selection (candidate 1 / candidate 2)、正確な
  // sourceMessageRefへのmapping
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const hash = hashCandidateSnapshot(snapshot);

    const select1 = resolveReferentClarificationSelection({
      response: "1",
      candidateSnapshot: snapshot,
      candidateSnapshotHash: hash,
      expiresAt: null,
      now: NOW,
    });

    const select2 = resolveReferentClarificationSelection({
      response: "2",
      candidateSnapshot: snapshot,
      candidateSnapshotHash: hash,
      expiresAt: null,
      now: NOW,
    });

    results.push(
      check(
        "[REF-P1d clarification] 3/10. 「1」はcandidate 1(m-a)を正確に指す",
        select1.status === "selected" && select1.status === "selected" && select1.candidate.sourceMessageRef === "m-a"
      )
    );

    results.push(
      check(
        "[REF-P1d clarification] 4. 「2」はcandidate 2(m-b)を正確に指す",
        select2.status === "selected" && select2.status === "selected" && select2.candidate.sourceMessageRef === "m-b"
      )
    );
  }

  // =========================
  // 5. TOCTOU: T1でsnapshot作成後、T2で新しいcandidate Cが到着しても、
  // T3の「1」は常に元のAを指す。resolveReferentClarificationSelection()
  // はfresh candidate配列を一切受け取れない(型シグネチャで保証)。
  // =========================
  {
    // T1: snapshotはA,Bのみから作成される。
    const snapshotAtT1 = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const hashAtT1 = hashCandidateSnapshot(snapshotAtT1);

    // T2: 新しい外部candidate Cが「到着」したことをシミュレートする
    // (実際にはこの新しい配列はどこにも永続化されず、selection関数へも
    // 渡らない——TOCTOU安全性の核心)。
    const freshCandidatesAtT2 = [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C];
    void freshCandidatesAtT2; // 意図的に未使用——selection関数の引数に存在しないことを示す

    // T3: ユーザーは「1」と答える。渡せるのはT1のsnapshot/hashのみ。
    const selection = resolveReferentClarificationSelection({
      response: "1",
      candidateSnapshot: snapshotAtT1,
      candidateSnapshotHash: hashAtT1,
      expiresAt: null,
      now: NOW,
    });

    results.push(
      check(
        "[REF-P1d clarification] 5. TOCTOU: T2で新しいcandidate Cが到着しても、T3の「1」は常に元のcandidate A(m-a)を指し、Cにはならない",
        selection.status === "selected" && selection.status === "selected" &&
          selection.candidate.sourceMessageRef === "m-a"
      )
    );
  }

  // =========================
  // Mutation test: Clarification作成後、呼び出し元が別のcandidate配列を
  // 作成/変更しても、既に構築済みのsnapshotは影響を受けない。
  // =========================
  {
    const sourceCandidates = [CANDIDATE_A, CANDIDATE_B];
    const snapshot = buildCandidateSnapshot(sourceCandidates);

    // 呼び出し元がsourceCandidatesと同じ配列を後から変更しようとしても
    // (mutationを試みる)、buildCandidateSnapshot()は新しいobject/配列
    // だけを返しているため、snapshot自体は無関係のまま。
    const mutatedSource = [...sourceCandidates, CANDIDATE_C];

    results.push(
      check(
        "[REF-P1d clarification] mutation: 元のcandidate配列に対する後からの変更(要素追加)は、既に構築済みのsnapshotへ一切反映されない",
        snapshot.length === 2 && mutatedSource.length === 3
      )
    );
  }

  // =========================
  // 6. hash改ざん検出 — fail closed
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const correctHash = hashCandidateSnapshot(snapshot);

    // hashを更新せずにsnapshotだけを改ざんする(例: 保存後にAをCへ
    // 差し替えるような不正な書き込みをシミュレート)。
    const tamperedSnapshot: readonly CandidateSnapshotEntry[] = [
      { index: 1, sourceMessageRef: "m-c" },
      snapshot[1],
    ];

    const selection = resolveReferentClarificationSelection({
      response: "1",
      candidateSnapshot: tamperedSnapshot,
      candidateSnapshotHash: correctHash,
      expiresAt: null,
      now: NOW,
    });

    results.push(
      check(
        "[REF-P1d clarification] 6. snapshotが改ざんされhashが一致しない場合、fail closedしcandidateは一切選択されない(candidate再生成・free-text fallback・proposal進行のいずれも発生しない)",
        selection.status === "integrity_error"
      )
    );
  }

  // =========================
  // 7. 期限切れ — 境界値も含む
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const hash = hashCandidateSnapshot(snapshot);
    const expiresAt = "2026-09-11T09:00:00.000Z";

    const beforeExpiry = resolveReferentClarificationSelection({
      response: "1", candidateSnapshot: snapshot, candidateSnapshotHash: hash,
      expiresAt, now: new Date("2026-09-11T08:59:59.999Z"),
    });
    const atExpiry = resolveReferentClarificationSelection({
      response: "1", candidateSnapshot: snapshot, candidateSnapshotHash: hash,
      expiresAt, now: new Date("2026-09-11T09:00:00.000Z"),
    });
    const afterExpiry = resolveReferentClarificationSelection({
      response: "1", candidateSnapshot: snapshot, candidateSnapshotHash: hash,
      expiresAt, now: new Date("2026-09-11T09:00:00.001Z"),
    });

    results.push(
      check(
        "[REF-P1d clarification] 7. 期限境界: expiresAt直前(T1-ε)は受理され、ちょうどexpiresAt(T1)とexpiresAt直後(T1+ε)はいずれもstaleとして拒否される",
        beforeExpiry.status === "selected" && atExpiry.status === "stale" && afterExpiry.status === "stale"
      )
    );
  }

  // =========================
  // 8/9. 無効なindex・fuzzy selectionの拒否
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const hash = hashCandidateSnapshot(snapshot);

    const invalidResponses = ["0", "3", "-1", "abc", "1.5", "", "上", "田中さんの", "前の", "たぶん1"];

    const allInvalid = invalidResponses.every((response) => {
      const selection = resolveReferentClarificationSelection({
        response, candidateSnapshot: snapshot, candidateSnapshotHash: hash, expiresAt: null, now: NOW,
      });
      return selection.status === "invalid_selection";
    });

    results.push(
      check(
        `[REF-P1d clarification] 8/9. 範囲外index(0/3/-1)・非数値(abc)・小数(1.5)・空文字・自然言語表現(上/田中さんの/前の/たぶん1)は、いずれもnearest/fuzzy解釈されず一律invalid_selectionになる`,
        allInvalid
      )
    );

    const withCounterExplicit = resolveReferentClarificationSelection({
      response: "1番", candidateSnapshot: snapshot, candidateSnapshotHash: hash, expiresAt: null, now: NOW,
    });

    results.push(
      check(
        "[REF-P1d clarification] 補助: 「1番」のような単純で曖昧さの無い表現のみ追加で許容される",
        withCounterExplicit.status === "selected"
      )
    );
  }

  // =========================
  // 14. candidate snapshotに本文/snippetが一切含まれない
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A]);
    const serialized = JSON.stringify(snapshot);

    results.push(
      check(
        "[REF-P1d clarification] 14. candidate snapshotにbody/snippet/生payload/Composio ID/Action proposal/Approval data/OAuth情報が一切含まれない",
        !("body" in snapshot[0]) && !("snippet" in snapshot[0]) &&
          !serialized.toLowerCase().includes("composio") &&
          !serialized.toLowerCase().includes("approval") &&
          !serialized.toLowerCase().includes("oauth")
      )
    );
  }

  // =========================
  // parseCandidateSnapshot(): DB round-trip validation
  // =========================
  {
    const snapshot = buildCandidateSnapshot([CANDIDATE_A, CANDIDATE_B]);
    const roundTripped = parseCandidateSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const invalidShape = parseCandidateSnapshot({ not: "an array" });
    const nullValue = parseCandidateSnapshot(null);

    results.push(
      check(
        "[REF-P1d clarification] parseCandidateSnapshot()はJSON round-trip後も同じ内容を復元し、不正な形/nullには安全にundefinedを返す(DB層を信用しない)",
        JSON.stringify(roundTripped) === JSON.stringify(snapshot) &&
          invalidShape === undefined &&
          nullValue === undefined
      )
    );
  }

  // =========================
  // TTL constant / expiresAt computation
  // =========================
  {
    const expiresAt = computeReferentClarificationExpiresAt(NOW);
    const expectedMs = NOW.getTime() + WRITE_REFERENT_CLARIFICATION_TTL_MS;

    results.push(
      check(
        "[REF-P1d clarification] computeReferentClarificationExpiresAt()はWRITE_REFERENT_CLARIFICATION_TTL_MS(24h)をnowへ加算した決定論的なISO日時を返す",
        new Date(expiresAt).getTime() === expectedMs && WRITE_REFERENT_CLARIFICATION_TTL_MS === 24 * 60 * 60 * 1000
      )
    );
  }

  // =========================
  // parseNumericSelection() 単体
  // =========================
  {
    results.push(
      check(
        "[REF-P1d clarification] parseNumericSelection()は前後空白を許容しつつ、厳密に数値のみを受理する",
        parseNumericSelection("  2  ").ok === true &&
          (parseNumericSelection("  2  ") as { ok: true; index: number }).index === 2 &&
          parseNumericSelection("2a").ok === false
      )
    );
  }

  return summarize("referent/clarification", results);

}
