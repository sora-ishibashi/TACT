import type { CoreCapability } from "../tact-core/types";
import type { MemoryCandidate } from "./memoryCandidate";

// =========================
// evaluateMemoryCandidate (Phase 5)
// =========================
//
// 「Memory Candidate → 保存すべきものだけ選択」の段階。Candidate生成
// (memoryCandidateBuilder.ts)・DB書き込み(memoryWriter.ts)とは独立した
// 責務(絶対条件8)。Policyは「保存するかどうか」だけを判断し、実際の
// recordMemory()/recordKnowledge()呼び出しは一切行わない。
//
// Phase 5の判断基準(すべて決定論的、LLMを使わない、絶対条件7):
//   1. Scope guard: 実際に永続化できるのは現状User Scopeのみ
//      (STEP208、core/tact-core/supabaseCoreCapability.tsの
//      assertUserScopeOwner()が今もそれ以外を明示的にErrorにする)。
//      Project/Organization Scopeの候補を、勝手にUser Scopeへ
//      格下げして保存することはしない(絶対条件12: 「あるproject
//      だけの情報をOrganizationへ昇格させたりしない」の裏返しとして、
//      「project/organizationの候補をuserへ降格させない」も同じ理由で
//      禁止する)。scope!=="user"の候補は常にreject。
//   2. importance/confidenceの最低ライン。
//   3. 重複チェック(絶対条件11): 既存Core(Knowledge/Memory)に同一
//      contentが既に無いかを、既存のretrieveKnowledge/retrieveMemory
//      (Phase 4のbuildRetrievalQuery相当の簡易relevance検索)で確認する。
//      高度なsemantic dedupは行わない(exact/近似一致のみ)。

export interface MemoryPolicyDecision {

  candidate: MemoryCandidate;

  accepted: boolean;

  reason: string;

}

const MIN_IMPORTANCE_TO_PERSIST = 5;

// Phase 5で生成しない予約型(memoryCandidate.ts参照)。Builder側は
// 生成しない設計だが、Policy側でも安全弁として明示的にrejectする。
const UNSUPPORTED_MEMORY_TYPES = new Set([
  "organization_memory",
  "execution_memory",
]);

// 正規化した完全一致だけを重複とみなす(絶対条件11: 高度なsemantic
// dedupは今回不要、まずexact matchで十分)。
function normalizeForDuplicateCheck(text: string): string {

  return text.trim().toLowerCase().replace(/\s+/g, " ");

}

async function isDuplicate(
  candidate: MemoryCandidate,
  core: CoreCapability
): Promise<boolean> {

  if (!candidate.ownerId) {
    return false;
  }

  const normalizedCandidate = normalizeForDuplicateCheck(candidate.content);

  if (candidate.memoryType === "knowledge_memory") {

    const items = await core.retrieveKnowledge({
      userId: candidate.ownerId,
      query: candidate.content,
      limit: 5,
    });

    return items.some(
      (item) => normalizeForDuplicateCheck(item.content) === normalizedCandidate
    );

  }

  const items = await core.retrieveMemory({
    userId: candidate.ownerId,
    query: candidate.content,
    limit: 5,
  });

  return items.some(
    (item) => normalizeForDuplicateCheck(item.content) === normalizedCandidate
  );

}

export async function evaluateMemoryCandidate(
  candidate: MemoryCandidate,
  core: CoreCapability
): Promise<MemoryPolicyDecision> {

  if (candidate.scope !== "user") {

    return {
      candidate,
      accepted: false,
      reason: `scope "${candidate.scope}" is not persisted yet (User Scope only, STEP208).`,
    };

  }

  if (!candidate.ownerId) {

    return {
      candidate,
      accepted: false,
      reason: "ownerId is required to persist a user-scoped memory.",
    };

  }

  if (UNSUPPORTED_MEMORY_TYPES.has(candidate.memoryType)) {

    return {
      candidate,
      accepted: false,
      reason: `memoryType "${candidate.memoryType}" is not implemented for persistence in Phase 5.`,
    };

  }

  if (
    candidate.importance < MIN_IMPORTANCE_TO_PERSIST ||
    candidate.confidence === "low"
  ) {

    return {
      candidate,
      accepted: false,
      reason: "importance/confidence below the persistence threshold.",
    };

  }

  if (await isDuplicate(candidate, core)) {

    return {
      candidate,
      accepted: false,
      reason: "duplicate of existing Core memory/knowledge (normalized exact content match).",
    };

  }

  return {

    candidate,

    accepted: true,

    reason: "passed policy checks.",

  };

}
