// =========================
// TACT Referent — Pinned Clarification Candidate Selection (REF-P1d)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit §13/§14/§25/§26/§29で確定した、
// TOCTOU-safeな pinned candidate selection を実装する。この module は
// 完全に純粋(DBアクセス・Supabase・Approval・execution・Botのいずれも
// importしない、このphaseの明示的Dependency Rule)。
//
// 絶対条件(このphaseの明示的指示、frozen):
//   - candidate_snapshotは作成後に一切mutateされない
//     (このfile自身は書き込みを一切行わない、durable永続化は
//     core/tact-work/clarification.ts/store.tsの責務)。
//   - 選択関数(resolveReferentClarificationSelection())は、新しい
//     candidate配列を一切受け取らない——引数の型自体にfresh candidate
//     を渡す余地が無いことで、TOCTOU安全性を構造的に保証する。
//   - selection ≠ Approval。この module はApproval/Policy/Executionの
//     いずれも一切参照しない。
//   - Date.now()を関数内部で直接呼ばない(nowを注入する、決定論的test
//     のため)。
//
// 依存方向(絶対条件、Dependency Rule): このfileはcore/tact-referent/
// types.ts(同一module)以外への依存を持たない。core/tact-work
// (store/Approval/Clarification lifecycle含む)・Supabase・execution・
// Botのいずれも一切importしない。
//
// canonicalization/hashについての注記: core/tact-work/approvalIntegrity.ts
// のstableStringify()/hashApprovalSubject()と同じアルゴリズム
// (object keyをソートした決定論的JSON文字列 + SHA-256 hex digest)を
// そのまま踏襲する——「別のcanonicalizationスキームを発明しない」という
// 指示に従っているが、tact-referentはtact-work配下を一切importできない
// (このphaseのDependency Rule)ため、同一アルゴリズムをこの1箇所だけに
// 複製する(コピー元とロジックが乖離しないよう、コメントで明記する)。

import { createHash } from "node:crypto";
import type { CommunicationCandidate } from "./types";

// =========================
// CandidateSnapshotEntry
// =========================
//
// 絶対条件: body・snippet・生provider payload・Composio ID・Action
// proposal・Approval data・connection secret・OAuth情報のいずれも
// 含まない。TACT側で既に正規化済みのcanonical識別子のみ。

export interface CandidateSnapshotEntry {

  // 1始まりの安定した人間向け番号(このphaseの明示的指示: 配列位置への
  // 暗黙依存を避けるため、選択時は必ずこのindexを明示的に検索する)。
  index: number;

  sourceMessageRef: string;

  threadRef?: string;

  sender?: string;

  normalizedSubject?: string;

  observedAt?: string;

}

/**
 * CommunicationCandidate配列から、1始まりの安定したindexを持つ
 * CandidateSnapshotEntry配列を構築する。呼び出し元の配列を一切
 * mutateしない(新しい配列・新しいobjectのみを返す)。
 */
export function buildCandidateSnapshot(
  candidates: readonly CommunicationCandidate[]
): readonly CandidateSnapshotEntry[] {

  return candidates.map((candidate, position) => ({
    index: position + 1,
    sourceMessageRef: candidate.messageId,
    ...(candidate.threadId ? { threadRef: candidate.threadId } : {}),
    ...(candidate.sender ? { sender: candidate.sender } : {}),
    ...(candidate.normalizedSubject ? { normalizedSubject: candidate.normalizedSubject } : {}),
    ...(candidate.observedAt ? { observedAt: candidate.observedAt } : {}),
  }));

}

// =========================
// 決定論的canonicalization + SHA-256 hash
// =========================
//
// core/tact-work/approvalIntegrity.tsのstableStringify()と同一
// アルゴリズム(object keyを再帰的にソートした決定論的JSON文字列)。
// jsonb列はkey順序を保持する保証が無いため、DBへの保存・再取得を
// 経てもこの関数を再度通せば同じ文字列・同じhashが再現できる、という
// 性質がこの関数の存在意義(approvalIntegrity.tsと同じ設計理由)。
type SnapshotJsonValue = string | number | null | { [key: string]: SnapshotJsonValue };

function stableStringify(value: SnapshotJsonValue): string {

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  const sortedKeys = Object.keys(value).sort();
  const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);

  return `{${entries.join(",")}}`;

}

function canonicalizeSnapshot(snapshot: readonly CandidateSnapshotEntry[]): string {

  const values: SnapshotJsonValue[] = snapshot.map((entry) => ({
    index: entry.index,
    sourceMessageRef: entry.sourceMessageRef,
    threadRef: entry.threadRef ?? null,
    sender: entry.sender ?? null,
    normalizedSubject: entry.normalizedSubject ?? null,
    observedAt: entry.observedAt ?? null,
  }));

  return `[${values.map(stableStringify).join(",")}]`;

}

export function hashCandidateSnapshot(snapshot: readonly CandidateSnapshotEntry[]): string {

  return createHash("sha256").update(canonicalizeSnapshot(snapshot), "utf8").digest("hex");

}

// =========================
// Referent Clarification TTL (このphaseの明示的指示: WRITEのみを
// 実装する、READ/PREPAREの72hポリシーは現時点で呼び出し元が存在しない
// ため導入しない、過剰設計回避)
// =========================

export const WRITE_REFERENT_CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function computeReferentClarificationExpiresAt(
  now: Date,
  ttlMs: number = WRITE_REFERENT_CLARIFICATION_TTL_MS
): string {

  return new Date(now.getTime() + ttlMs).toISOString();

}

// =========================
// User response parsing (保守的、numeric selectionのみ)
// =========================
//
// 絶対条件: 自然言語解釈を一切行わない。「1」「2」(前後空白許容)・
// 「1番」のみを受理する。「上」「たぶん1」「前の」等はすべて拒否する
// (Build Less、このphaseの明示的指示)。
const NUMERIC_SELECTION_PATTERN = /^([0-9]+)番?$/u;

export type ParsedSelection =
  | { ok: true; index: number }
  | { ok: false };

export function parseNumericSelection(response: string): ParsedSelection {

  const trimmed = response.trim();
  const match = NUMERIC_SELECTION_PATTERN.exec(trimmed);

  if (!match) {
    return { ok: false };
  }

  const index = Number(match[1]);

  if (!Number.isInteger(index) || index <= 0) {
    return { ok: false };
  }

  return { ok: true, index };

}

// =========================
// Referent Clarification Selection Resolution
// =========================
//
// 絶対条件(TOCTOU、最重要): この関数はfresh candidateを一切受け取れ
// ない——引数はcandidateSnapshot(既に永続化・hash確定済みのstored
// snapshot)のみであり、シグネチャ自体がfresh Gmail検索結果の混入を
// 構造的に防ぐ。
//
// 絶対条件: selection ≠ Approval。この関数はApproval/Policy/Executionの
// いずれも一切参照せず、「どのcandidateを指しているか」だけを解決する。

export type ReferentClarificationSelectionResult =
  | { status: "selected"; candidate: CandidateSnapshotEntry }
  | { status: "invalid_selection"; reason: string }
  | { status: "stale"; reason: string }
  | { status: "integrity_error"; reason: string };

export interface ResolveReferentClarificationSelectionInput {

  response: string;

  // 常にDBから読み出したstored snapshot/hashのみを渡す——呼び出し元が
  // 新しく生成したcandidate配列を渡すことは、この関数の契約上想定
  // されていない(呼び出し元の責務、TOCTOU防御の型レベルでの表明)。
  candidateSnapshot: readonly CandidateSnapshotEntry[];

  candidateSnapshotHash: string;

  expiresAt: string | null;

  now: Date;

}

export function resolveReferentClarificationSelection(
  input: ResolveReferentClarificationSelectionInput
): ReferentClarificationSelectionResult {

  // 1. 期限切れは常に最優先(このphaseの明示的指示: T1-ε=accepted,
  // T1=stale, T1+ε=staleという境界——now >= expiresAtでstale)。
  if (input.expiresAt && input.now.getTime() >= new Date(input.expiresAt).getTime()) {
    return { status: "stale", reason: "clarification_expired" };
  }

  // 2. snapshot整合性検証(絶対条件: hash不一致はfail closed。
  // candidateを再生成しない・free-text fallbackしない・proposalへ
  // 進めない)。
  const recomputedHash = hashCandidateSnapshot(input.candidateSnapshot);

  if (recomputedHash !== input.candidateSnapshotHash) {
    return { status: "integrity_error", reason: "candidate_snapshot_hash_mismatch" };
  }

  // 3. 保守的なnumeric selection parsing。
  const parsed = parseNumericSelection(input.response);

  if (!parsed.ok) {
    return { status: "invalid_selection", reason: "non_numeric_response" };
  }

  // 4. 明示的に永続化されたindexで検索する(絶対条件: 配列位置への
  // 暗黙依存を避ける、snapshot[Number(answer)-1]を直接使わない)。
  const candidate = input.candidateSnapshot.find((entry) => entry.index === parsed.index);

  if (!candidate) {
    return { status: "invalid_selection", reason: "index_out_of_range" };
  }

  return { status: "selected", candidate };

}

// =========================
// jsonb round-trip用のruntime validation
// =========================
//
// DBのjsonb列はunknownとして返る(store.tsのownership原則: DB層を
// 信用せず、この境界でruntime検証する——approvalIntegrity.tsの
// parseStoredApprovalSubject()と同じ設計判断)。

export function parseCandidateSnapshot(value: unknown): readonly CandidateSnapshotEntry[] | undefined {

  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: CandidateSnapshotEntry[] = [];

  for (const item of value) {

    if (!item || typeof item !== "object") {
      return undefined;
    }

    const record = item as Record<string, unknown>;

    if (typeof record.index !== "number" || typeof record.sourceMessageRef !== "string") {
      return undefined;
    }

    entries.push({
      index: record.index,
      sourceMessageRef: record.sourceMessageRef,
      ...(typeof record.threadRef === "string" ? { threadRef: record.threadRef } : {}),
      ...(typeof record.sender === "string" ? { sender: record.sender } : {}),
      ...(typeof record.normalizedSubject === "string" ? { normalizedSubject: record.normalizedSubject } : {}),
      ...(typeof record.observedAt === "string" ? { observedAt: record.observedAt } : {}),
    });

  }

  return entries;

}
