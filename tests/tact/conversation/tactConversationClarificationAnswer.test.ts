// =========================
// tact-conversation Clarification Answer Re-execution Regression (Phase 68)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsの純粋関数
// (buildClarificationResendInput()・findPrecedingUserInput())、
// core/tact-conversation/store.tsのisClarificationQuestionMessage()、
// および runOrchestration()実行結果からのplanConversationTurn()導出
// (Phase67と同じmock capability pattern、実DBアクセスなし)。
//
// Phase66/67と同じ環境制約(Service Role Key不在・実テストUserセッション
// 取得不可)により、pending clarification detection→answer flow分岐→
// ExecutionRecord/Assistant Message永続化→pending clear/維持という
// store.ts経由の実書き込みシーケンス全体は、npm testでは検証しない。
// これはPhase68完了報告に記載の通り、Postgres RLS Reality Test
// (`supabase db query --linked`によるauth.uid()ロールシミュレーション)
// で別途検証し、一時SQLは実行後に削除する。

import "dotenv/config";
import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { runOrchestration } from "../../../core/tact-orchestrator";
import type { ResearchResult, ResearchParams, ResearchMetadata } from "../../../core/tact-research/types";
import {
  buildClarificationResendInput,
  findPrecedingUserInput,
  planConversationTurn,
} from "../../../core/tact-conversation/orchestration";
import { isClarificationQuestionMessage } from "../../../core/tact-conversation/store";
import type { ConversationMessage } from "../../../core/tact-conversation/types";
import { check, summarize, type CheckResult } from "../lib/check";

function makeMetadata(): ResearchMetadata {
  return {
    executionMode: "web-research", llmAttempts: 1, llmSuccesses: 1, llmFailures: 0,
    searchQueryCount: 1, searchRequestCount: 1, searchAttempts: [],
    retrievedKnowledgeCount: 0, retrievedMemoryCount: 0, retrievedExampleCount: 0,
    usedKnowledgeCount: 0, usedMemoryCount: 0, usedExampleCount: 0,
    usedKnowledgeIds: [], usedMemoryIds: [], usedExampleIds: [],
    durationMs: 100, mocked: false, requirementCount: 1, coveredRequirementCount: 0,
    partialRequirementCount: 0, missingRequirementCount: 1, gapQueries: [], safetyDowngradeCount: 0,
  };
}

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "m1",
    conversationId: "conv-1",
    role: "user",
    content: "hello",
    messageType: null,
    executionRecordId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- buildClarificationResendInput(): pure ----

  results.push(
    check(
      "[Test1] originalInputあり -> Legacy(Phase46/55)と同じ結合形式",
      buildClarificationResendInput("調べて", "何について調べればいいですか?", "トヨタの競合について") ===
        "調べて\n(補足: 「何について調べればいいですか?」への回答: トヨタの競合について)"
    )
  );

  results.push(
    check(
      "[Test2] originalInput=null(復元できなかった場合) -> question+answerのみで安全側にフォールバック",
      buildClarificationResendInput(null, "何について調べればいいですか?", "トヨタの競合について") ===
        "(補足: 「何について調べればいいですか?」への回答: トヨタの競合について)"
    )
  );

  // ---- findPrecedingUserInput(): pure ----

  {
    const messages: ConversationMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "調べて" }),
      makeMessage({ id: "q1", role: "assistant", content: "何について調べればいいですか?", messageType: "clarification_question" }),
    ];

    results.push(
      check(
        "[Test3] Clarification Questionの直前のuser messageを正しく見つける",
        findPrecedingUserInput(messages, "q1") === "調べて"
      )
    );
  }

  {
    // assistant messageを挟んでいても、直近のuser messageまで遡る
    const messages: ConversationMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "調べて" }),
      makeMessage({ id: "a1", role: "assistant", content: "前回の回答" }),
      makeMessage({ id: "q1", role: "assistant", content: "何について調べればいいですか?", messageType: "clarification_question" }),
    ];

    results.push(
      check(
        "[Test4] 間にassistant messageがあっても直近のuser messageまで遡って見つける",
        findPrecedingUserInput(messages, "q1") === "調べて"
      )
    );
  }

  results.push(
    check(
      "[Test5] 対象messageIdが履歴内に見つからない -> null(安全側)",
      findPrecedingUserInput([makeMessage({ id: "u1" })], "nonexistent-id") === null
    )
  );

  results.push(
    check(
      "[Test6] 対象messageが先頭(直前にmessageが無い) -> null(安全側)",
      findPrecedingUserInput([makeMessage({ id: "q1", messageType: "clarification_question" })], "q1") === null
    )
  );

  results.push(
    check(
      "[Test7] 直前にuser messageが1件も無い(assistant messageのみ) -> null(安全側)",
      findPrecedingUserInput(
        [
          makeMessage({ id: "a1", role: "assistant", content: "何か" }),
          makeMessage({ id: "q1", role: "assistant", content: "質問", messageType: "clarification_question" }),
        ],
        "q1"
      ) === null
    )
  );

  // ---- isClarificationQuestionMessage(): pure ----

  results.push(
    check(
      "[Test8] messageType='clarification_question' -> true",
      isClarificationQuestionMessage(makeMessage({ messageType: "clarification_question" })) === true
    )
  );

  results.push(
    check(
      "[Test9] messageType=null(通常メッセージ) -> false(安全側、Section4のデータ不整合防御)",
      isClarificationQuestionMessage(makeMessage({ messageType: null })) === false
    )
  );

  // ---- Re-execution: mock Orchestrator経由でplanConversationTurn()の導出を確認 ----
  // (Phase67と同じPattern。store.ts書き込みは含まない)

  {
    registerCapability<ResearchParams, ResearchResult>("research", async (params) => ({
      success: true,
      answer: `再実行結果: ${params.query}`,
      evidence: [{ id: "e1", claim: "c1", confidence: "high" }],
      metadata: makeMetadata(),
    }));

    const resendInput = buildClarificationResendInput("調べて", "何について調べればいいですか?", "トヨタの競合について");
    const result = await runOrchestration({ input: resendInput });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[Test10] 結合済みInputでOrchestratorを再実行 -> 通常完了planが導出される(D/E相当)",
        plan.kind === "normal" && plan.status === "completed" && plan.answer.includes("トヨタの競合について"),
        `plan=${JSON.stringify(plan)}`
      )
    );
  }

  {
    // 再実行してもなお曖昧なままの場合(Section6-6相当): 裸の動詞のみを
    // answerとして送ってしまった極端なケースをシミュレートする。
    let capabilityCalled = false;
    registerCapability<ResearchParams, ResearchResult>("research", async () => {
      capabilityCalled = true;
      return { success: true, answer: "should not be called", evidence: [], metadata: makeMetadata() };
    });

    const result = await runOrchestration({ input: "調べて" });
    const plan = planConversationTurn(result);

    results.push(
      check(
        "[Test11] 再実行してもなお曖昧 -> plan.kind='clarification'(新しいQuestionとして扱われる想定)",
        plan.kind === "clarification" && !capabilityCalled
      )
    );
  }

  return summarize("tact-conversation clarification answer re-execution (Phase 68)", results);

}
