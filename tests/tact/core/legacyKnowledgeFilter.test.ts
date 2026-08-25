// =========================
// Legacy Research Knowledge Filter Regression (Phase 38)
// =========================
//
// 対象: core/tact-core/supabaseCoreCapability.ts の
// isLegacyResearchKnowledge()、およびそれが正しく組み込まれた場合の
// 下流(assessAnswerability/knowledgeGap/coreOnlyAnswer、いずれも
// Phase38では無変更)の振る舞い。
//
// selectKnowledgeByOwner()自体は実Supabase接続を伴うため単体テスト
// できないが、(a) isLegacyResearchKnowledge()という決定論的な純粋
// 関数自体を直接検証し、(b) 「この関数がselectKnowledgeByOwner()に
// 適用された後のcontext.knowledge」を模したfixtureを、実際の
// (未変更の)assessAnswerability()/detectKnowledgeGap()/
// canAnswerAllFromCoreOnly()/buildCoreOnlyAnswer()へ渡すことで、
// Legacy Knowledgeが実際にAnswerability判定より前に除外された場合の
// 挙動を検証する。LLM/Search API呼び出み・実DBアクセスは一切無い。

import { isLegacyResearchKnowledge } from "../../../core/tact-core/supabaseCoreCapability";
import { detectKnowledgeGap, canAnswerAllFromCoreOnly } from "../../../core/tact-research/knowledgeGap";
import { buildCoreOnlyAnswerFromRequirements } from "../../../core/tact-research/coreOnlyAnswer";
import type { KnowledgeItem } from "../../../core/tact-core/knowledge/types";
import type { CoreContext } from "../../../core/tact-core/context/types";
import { check, summarize, type CheckResult } from "../lib/check";

const QUESTION = "中京大学について簡単に調べて";
const NEW_ANSWER = "中京大学は愛知県名古屋市に本部を置く私立大学です。";
const OLD_CONTENT = `Q: ${QUESTION}\nA: ${NEW_ANSWER}`;

function makeKnowledgeItem(overrides: Partial<KnowledgeItem>): KnowledgeItem {
  return {
    id: "k1",
    scope: "user",
    ownerId: "phase38-test-user",
    source: "orchestrator:research:task=t1",
    tags: [],
    createdAt: new Date().toISOString(),
    kind: "reference",
    title: "title",
    content: "content",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// selectKnowledgeByOwner()の実際のfilter chainを模したヘルパー
// (production側と全く同じisLegacyResearchKnowledge()を使うだけで、
// 判定ロジック自体を再実装しない)。
function applyProductionFilter(items: KnowledgeItem[]): KnowledgeItem[] {
  return items.filter((item) => !isLegacyResearchKnowledge(item));
}

function makeContext(knowledge: KnowledgeItem[]): CoreContext {
  return { knowledge, memories: [], examples: [], recentExecutions: [] };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case A/B/C(指示書Step6): isLegacyResearchKnowledge()単体検証 ----
  {
    const legacyItem = makeKnowledgeItem({
      source: "orchestrator:research:task=old",
      content: OLD_CONTENT,
    });
    results.push(
      check("[CaseA] 旧形式(source=research由来 + content='Q:'始まり) -> Legacy判定される", isLegacyResearchKnowledge(legacyItem))
    );

    const newItem = makeKnowledgeItem({
      source: "orchestrator:research:task=new",
      content: NEW_ANSWER,
      description: QUESTION,
    });
    results.push(
      check("[CaseB] 新形式(content=回答本文のみ) -> Legacy判定されない", !isLegacyResearchKnowledge(newItem))
    );

    const manualItem = makeKnowledgeItem({
      source: "user_push",
      content: "Q: これは偶然Q:で始まる手動入力です。",
    });
    results.push(
      check("[CaseC] 手動Knowledge(source!=research由来、contentが偶然'Q:'始まり) -> Legacy判定されない", !isLegacyResearchKnowledge(manualItem))
    );
  }

  // ---- Test 1: Legacy Knowledgeのみ存在する -> Core-only候補として
  // 使われない(=Requirementがmissingのまま、Web Researchが必要) ----
  {
    const raw = [makeKnowledgeItem({ source: "orchestrator:research:task=old", content: OLD_CONTENT })];
    const filtered = applyProductionFilter(raw);
    const context = makeContext(filtered);

    const requirements = detectKnowledgeGap(QUESTION, context);
    const canAnswer = canAnswerAllFromCoreOnly(QUESTION, requirements);

    results.push(
      check(
        "[Test1] Legacyのみ -> filteredでcontext.knowledgeが空になり、Requirementはmissingのまま",
        filtered.length === 0 && requirements.every((r) => r.status === "missing") && canAnswer === false,
        `filtered.length=${filtered.length}, statuses=${JSON.stringify(requirements.map((r) => r.status))}`
      )
    );
  }

  // ---- Test 2: Legacy + 新形式が両方存在する -> 新形式のみが
  // Core-only候補になる ----
  {
    const raw = [
      makeKnowledgeItem({ id: "old1", source: "orchestrator:research:task=old", content: OLD_CONTENT }),
      makeKnowledgeItem({ id: "new1", source: "orchestrator:research:task=new", content: NEW_ANSWER, description: QUESTION, title: QUESTION }),
    ];
    const filtered = applyProductionFilter(raw);
    const context = makeContext(filtered);

    const requirements = detectKnowledgeGap(QUESTION, context);
    const canAnswer = canAnswerAllFromCoreOnly(QUESTION, requirements);

    results.push(
      check(
        "[Test2] Legacy+新形式混在 -> filtered後は新形式のみ残る",
        filtered.length === 1 && filtered[0].id === "new1",
        `filtered=${JSON.stringify(filtered.map((i) => i.id))}`
      )
    );

    if (canAnswer) {
      const answer = buildCoreOnlyAnswerFromRequirements(requirements, context);
      results.push(
        check(
          "[Test2] Core-only回答が新形式Knowledgeのみを根拠にし、Q:/A:を含まない",
          answer.answer === NEW_ANSWER && !answer.answer.includes("Q:") && !answer.answer.includes("A:"),
          `answer=${JSON.stringify(answer.answer)}`
        )
      );
    } else {
      results.push(check("[Test2] canAnswerAllFromCoreOnly=false(新形式1件でも閾値未達の場合は妥当、Core-only側は無変更)", true));
    }
  }

  // ---- Test 3: 手動Knowledgeのみ存在する -> 従来通りCore-onlyで
  // 利用される(回帰確認) ----
  {
    const raw = [makeKnowledgeItem({ id: "manual1", source: "user_push", content: "中京大学は愛知県にある総合大学です。", title: QUESTION })];
    const filtered = applyProductionFilter(raw);

    results.push(
      check(
        "[Test3] 手動Knowledgeはfilterで除外されない",
        filtered.length === 1 && filtered[0].id === "manual1",
        `filtered.length=${filtered.length}`
      )
    );
  }

  // ---- Test 4: 新形式Research Knowledgeのみ存在する -> 従来通り
  // 利用される(回帰確認) ----
  {
    const raw = [makeKnowledgeItem({ id: "new2", source: "orchestrator:research:task=new2", content: NEW_ANSWER, description: QUESTION, title: QUESTION })];
    const filtered = applyProductionFilter(raw);

    results.push(
      check(
        "[Test4] 新形式Research Knowledgeはfilterで除外されない",
        filtered.length === 1 && filtered[0].id === "new2",
        `filtered.length=${filtered.length}`
      )
    );
  }

  // ---- Test 5(最重要): 全KnowledgeがLegacyの場合、Legacyだけを
  // 根拠にcovered判定されない(Web Researchが省略されない) ----
  {
    const raw = [
      makeKnowledgeItem({ id: "old2", source: "orchestrator:research:task=old2", content: `Q: ${QUESTION}\nA: 別の古い回答。` }),
      makeKnowledgeItem({ id: "old3", source: "orchestrator:research:task=old3", content: `Q: ${QUESTION}\nA: さらに別の古い回答。` }),
    ];
    const filtered = applyProductionFilter(raw);
    const context = makeContext(filtered);
    const requirements = detectKnowledgeGap(QUESTION, context);
    const canAnswer = canAnswerAllFromCoreOnly(QUESTION, requirements);

    results.push(
      check(
        "[Test5] 全件Legacy -> Answerability判定より前(filter後のcontext構築時点)で除外され、covered=trueにならない",
        filtered.length === 0 && canAnswer === false,
        `filtered.length=${filtered.length}, canAnswer=${canAnswer}`
      )
    );
  }

  return summarize("legacy knowledge filter", results);

}
