// =========================
// runDesign (STEP178)
// =========================
//
// TACT Designの公開API。「Agentを束ねるOrchestrator」ではなく
// 「designという能力」として外部から呼び出せることを示す
// (core/tact-research/runResearch.tsのSTEP176絶対条件5と同じ思想)。
// 呼び出し元は request と CoreContext だけを渡し、内部構成
// (将来的な実LLM/実生成ロジック)を一切意識しない。
//
// 依存方向(STEP178絶対条件): このファイルはcore/tact-coreの型
// (CoreContext/CoreCapability)にのみ依存する。core/tact-coreの
// どのファイルもこのファイルを逆にimportしていない
// (Coreは能力の名前だけを知り、実装を知らない)。
//
// Legacy Workflow Engineとの関係: core/workflow/*・core/agents/*・
// core/planner/*・core/brain/*・core/llm/*・core/evidence/*・
// core/conversation/*・core/auth/*は一切importしていない
// (実行もしていない)。STEP178時点の実処理はmockDesignEngine.tsに
// 委譲する(実LLM/実Agent呼び出し禁止のため)。

import { CoreCapability } from "../tact-core";
import { DesignParams, DesignResult, DesignMetadata } from "./types";
import { generateMockDesignOutput } from "./mockDesignEngine";

// core.recordExecution()へ渡すscopeを、CoreContextの内容から推定する。
// core/tact-research/runResearch.tsのinferExecutionScope()と同じ
// ロジック(重複コードだが、両Capabilityが将来別々に進化する
// 可能性を考え、あえて共有関数へ抽象化しない。STEP178の
// 「新しい抽象化を増やしすぎない」方針に沿う)。
function inferExecutionScope(
  context: DesignParams["context"]
): "user" | "organization" | "project" | "conversation" {

  if (context.conversationId) return "conversation";

  if (context.project) return "project";

  if (context.organization) return "organization";

  return "user";

}

export async function runDesign(
  params: DesignParams,
  core: CoreCapability
): Promise<DesignResult> {

  const startedAt = Date.now();

  const { request, context } = params;

  try {

    // Coreが事前にloadContext()で取得済みのknowledge/memories/examples
    // をそのまま利用する(Designは Coreへ再度retrieve*()を呼ばない)。
    const { output, usedKnowledgeIds, usedMemoryIds, usedExampleIds } =
      generateMockDesignOutput(
        request,
        context.knowledge,
        context.memories,
        context.examples
      );

    const metadata: DesignMetadata = {

      usedKnowledgeCount: context.knowledge.length,

      usedMemoryCount: context.memories.length,

      usedExampleCount: context.examples.length,

      usedKnowledgeIds,

      usedMemoryIds,

      usedExampleIds,

      durationMs: Date.now() - startedAt,

      mocked: true,

    };

    // 結果をCoreへ記録する(core/tact-research/runResearch.tsと
    // 同じパターン)。
    await core.recordExecution({

      scope: inferExecutionScope(context),

      capability: "tact-design",

      summary: `Design: ${request}`,

      outcome: "success",

    });

    return {

      success: true,

      output,

      metadata,

    };

  } catch (error) {

    const metadata: DesignMetadata = {

      usedKnowledgeCount: context.knowledge?.length ?? 0,

      usedMemoryCount: context.memories?.length ?? 0,

      usedExampleCount: context.examples?.length ?? 0,

      // failure時はgenerateMockDesignOutput()が完走した保証がない
      // ため、空配列を既定値とする(core/tact-research/runResearch.ts
      // と同じ方針)。
      usedKnowledgeIds: [],

      usedMemoryIds: [],

      usedExampleIds: [],

      durationMs: Date.now() - startedAt,

      mocked: true,

    };

    await core.recordExecution({

      scope: inferExecutionScope(context),

      capability: "tact-design",

      summary: `Design failed: ${request}`,

      outcome: "failure",

    });

    return {

      success: false,

      output: "",

      metadata,

      errorMessage:
        error instanceof Error
          ? error.message
          : String(error),

    };

  }

}
