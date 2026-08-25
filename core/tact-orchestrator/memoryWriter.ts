import { evaluateMemoryCandidate } from "./memoryPolicy";
import type { CoreCapability } from "../tact-core/types";
import type { MemoryType } from "../tact-core/memory/types";
import type { MemoryCandidate, MemoryCandidateType } from "./memoryCandidate";

// =========================
// writeMemoryCandidates (Phase 5)
// =========================
//
// 「Memory Policy(accepted) → Memory Writer → TACT Memory」の段階。
// Candidate生成(memoryCandidateBuilder.ts)・採否判断(memoryPolicy.ts)
// とは独立した責務(絶対条件8)。ここでは既存のCoreCapability.
// recordMemory()/recordKnowledge()(core/tact-core/types.ts、STEP175〜)
// を呼ぶだけであり、新しいSupabase INSERT処理やDB schemaは一切追加
// しない(app/api/tact/core/push/route.tsのSTEP212絶対条件5-1と
// 同じ方針をここでも踏襲する)。
//
// 絶対条件(最重要): Memory Write失敗によって本体Taskが失敗する設計は
// 禁止。この関数は例外を一切外へ投げない。呼び出し元
// (commander.ts)は、この関数が返す配列とは無関係に、既に確定した
// TaskExecutionSummary.statusをそのまま使う(実行順序上、Memory
// Write自体がTask完了判定の後で行われるため、構造的にも影響しない)。

export interface MemoryWriteOutcome {

  candidate: MemoryCandidate;

  status: "written" | "rejected" | "failed";

  reason?: string;

  itemId?: string;

}

// MemoryCandidateType(Orchestrator独自の分類)→ CoreMemory.type
// (core/tact-core/memory/types.ts、STEP175の既存enum)への変換。
// 既存enumに無い概念(project_memory/decision_memory)は、意味的に
// 最も近い既存値へ対応付ける(絶対条件: 既存schemaを増やさない)。
//   user_preference  → "preference"(既存enumにそのまま存在)
//   project_memory   → "context"(「重要な文脈」に相当。Project Scope
//                       自体は未実装のため、実際にはUser Scopeの下で
//                       「このユーザーが関わるプロジェクトの文脈」
//                       として記録される)
//   decision_memory  → "rule"(「今後何を優先するか」という既存ルール
//                       概念に相当)
//   other            → "other"
function toMemoryType(candidateType: MemoryCandidateType): MemoryType {

  switch (candidateType) {

    case "user_preference":
      return "preference";

    case "project_memory":
      return "context";

    case "decision_memory":
      return "rule";

    default:
      return "other";

  }

}

export async function writeMemoryCandidates(
  candidates: MemoryCandidate[],
  core: CoreCapability
): Promise<MemoryWriteOutcome[]> {

  const outcomes: MemoryWriteOutcome[] = [];

  for (const candidate of candidates) {

    let decision;

    try {

      decision = await evaluateMemoryCandidate(candidate, core);

    } catch (error) {

      // Policy自体(重複チェックのretrieve*呼び出し等)が例外を投げた
      // 場合も、Task全体を失敗させない(絶対条件)。
      outcomes.push({
        candidate,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });

      continue;

    }

    if (!decision.accepted) {

      outcomes.push({
        candidate,
        status: "rejected",
        reason: decision.reason,
      });

      continue;

    }

    try {

      if (candidate.memoryType === "knowledge_memory") {

        // 既存recordKnowledge()(core/tact-core/supabaseCoreCapability.ts、
        // app/api/tact/core/push/route.tsのpushKnowledge()と同じ呼び出し
        // 契約)をそのまま再利用する。
        //
        // Phase36: candidate.description(質問文等、Phase36で追加)が
        // あればtitle/descriptionの両方へ反映する。既存フィールド
        // (KnowledgeItem.description、DB schema変更不要)を使うだけで、
        // 呼び出し契約自体は変更していない。descriptionが無い候補
        // (research由来以外)は、既存どおりcontentの先頭からtitleを
        // 作る。
        //
        // Phase94(Repository Evidence: Phase91〜93投資調査): candidate.freshness
        // ("durable"|"volatile"、memoryCandidateBuilder.tsのbuildResearchCandidate()が
        // 既に算出済み)がこれまでrecordKnowledge()へ一切渡っておらず、
        // Web Research由来の"volatile"なKnowledgeも"durable"なKnowledgeと
        // 区別なく永続化されていた。その結果、あるConversationのResearch
        // 結果が"knowledge_memory"としてscope:"user"へ永続化された後、
        // 全く別のConversationのTurnがこの古いKnowledgeをCore-only
        // Answerability(LLM 0回・Search 0回)の根拠として誤って再利用し、
        // 生のUser Input(title由来)・古いtask ID(source由来)がそのまま
        // Evidenceとして混入する現象を実Reality Testで確認した(詳細は
        // supabaseCoreCapability.tsのisVolatileResearchKnowledge()参照)。
        // KnowledgeItem.metadata(STEP177、Capability固有の付加情報用に
        // 既に開かれている領域、DB schema変更不要)へfreshnessを記録する
        // ことで、既存のisLegacyResearchKnowledge()と同じ場所
        // (selectKnowledgeByOwner())で一貫して除外できるようにする。
        const item = await core.recordKnowledge({
          scope: "user",
          ownerId: candidate.ownerId!,
          source: candidate.source,
          tags: [],
          kind: "reference",
          title: (candidate.description ?? candidate.content).slice(0, 60),
          description: candidate.description,
          content: candidate.content,
          metadata: { freshness: candidate.freshness },
        });

        outcomes.push({ candidate, status: "written", itemId: item.id });

      } else {

        // 既存recordMemory()をそのまま再利用する。
        const item = await core.recordMemory({
          scope: "user",
          ownerId: candidate.ownerId!,
          type: toMemoryType(candidate.memoryType),
          content: candidate.content,
          importance: candidate.importance,
          confidence: candidate.confidence,
          source: candidate.source,
        });

        outcomes.push({ candidate, status: "written", itemId: item.id });

      }

    } catch (error) {

      outcomes.push({
        candidate,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });

    }

  }

  return outcomes;

}
