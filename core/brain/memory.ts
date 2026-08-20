import {
  BrainRule,
  ImprovementProposal
} from "./types";

import { supabase } from "../database/supabase";

// ==========================
// Brain Memory
// ==========================
//
// 「TACT最速実装モード」STEP2/3: これまでプロセス内配列だけで
// 保持していたBrain Memoryを、既存のSupabase接続を使って
// tact_memoryテーブルへ永続化し、あわせて「現在のtask・userに
// 関連する記憶だけを絞り込んで取得する」Retrievalを追加した。
//
// STEP147: 上記STEP2/3時点の設計は、Brain Memoryを
// module-scopeの共有可変配列(let brainMemory)として保持し、
// refreshRelevantBrainMemory()がそれを書き換え、
// formatBrainMemory()が同じ配列を読む、というものだった。
// これは単一Workflow・単一プロセスの前提では動いたが、複数の
// Workflowが同一サーバープロセス上で同時実行されると、
// 「Aのretrieval → (await) → Bのretrieval(配列を上書き) →
// (await) → Aのformat呼び出しがBの内容を読む」というRace
// Conditionが理論上発生し得た(STEP146で発見)。
//
// STEP147でこれを解消するため、module-scopeの共有配列を廃止し、
// 以下の設計へ変更した。
// - refreshRelevantBrainMemory()は共有状態を書き換えず、
//   今回のWorkflow用のBrain Memoryスナップショットを
//   戻り値(Promise<BrainRule[]>)として返すだけの関数にする。
// - 呼び出し元(core/workflow/index.ts)がその戻り値を
//   WorkflowContext.brainMemory(Workflow実行ごとに新規生成される、
//   他のWorkflowと共有されないオブジェクト)へ保持する。
// - formatBrainMemory()は共有状態を一切参照しない純粋関数にし、
//   呼び出し元(core/prompt/builder.ts)から明示的にMemory配列を
//   受け取る。
// これにより、「1 Workflow実行 = 1 Brain Memoryスナップショット」
// という所有境界が、共有可変状態を経由せずに成立する。


// ==========================
// 保存(DB永続化のみ)
// ==========================
//
// STEP147: プロセス内配列への蓄積(旧brainMemory.push())は廃止した。
// この関数の戻り値・呼び出し元への影響は無い(元々戻り値はvoid)。
// tact_memoryへの永続化ロジック自体は変更していない。

export async function saveBrainMemory(
  improvements: BrainRule[],
  // STEP131以降のuserId伝達経路。未認証の場合はnullのまま
  // (global memoryとして扱う。既存方針を維持、拒否しない)。
  userId?: string | null,
  conversationId?: string | null
) {

  if (improvements.length === 0) return;

  try {

    const { error } =
      await supabase
        .from("tact_memory")
        .insert(
          improvements.map((rule) => ({
            user_id: userId ?? null,
            conversation_id: conversationId ?? null,
            type: "instruction",
            target_agent: rule.targetAgent ?? null,
            content: { rule: rule.rule, reason: rule.reason },
            importance:
              rule.priority === "high"
                ? 8
                : rule.priority === "low"
                  ? 3
                  : 5,
            confidence: "medium",
          }))
        );

    if (error) throw error;

  } catch (error) {

    console.warn(
      "[Brain] Failed to persist memory to DB.",
      error instanceof Error ? error.message : error
    );

  }

}



// ==========================
// saveImprovementProposals (最速実装モード STEP5/6)
// ==========================
//
// 構造化されたImprovementProposal(core/brain/analyzer.tsが生成)を
// tact_memoryへ保存する。type: "improvement_proposal"として、
// content列にProposal全体をそのまま保持する(専用テーブルは
// 新設しない。DBを必要以上に複雑化しないため)。
// DB未接続・migration未適用でも例外は投げない。

export async function saveImprovementProposals(
  proposals: ImprovementProposal[],
  userId?: string | null,
  conversationId?: string | null
): Promise<void> {

  if (proposals.length === 0) return;

  try {

    const { error } =
      await supabase
        .from("tact_memory")
        .insert(
          proposals.map((proposal) => ({
            user_id: userId ?? null,
            conversation_id: conversationId ?? null,
            type: "improvement_proposal",
            target_agent: proposal.affectedAgent ?? null,
            content: proposal,
            importance:
              proposal.confidence === "high" ? 8 :
              proposal.confidence === "low" ? 3 : 5,
            confidence: proposal.confidence,
          }))
        );

    if (error) throw error;

  } catch (error) {

    console.warn(
      "[Brain] Failed to persist improvement proposals to DB.",
      error instanceof Error ? error.message : error
    );

  }

}



// ==========================
// getImprovementProposals (最速実装モード STEP6)
// ==========================
//
// 「TACT Code」層(Claude Code Instruction生成)・診断用APIが読む
// ための取得関数。直近N件を新しい順に返す。DB未接続時は空配列
// (例外は投げない、既存Workflowを壊さない)。

export interface StoredImprovementProposal extends ImprovementProposal {
  id: string;
  targetAgent: string | null;
  createdAtIso: string;
}

// STEP146-C: userIdによる絞り込みを追加する。
// - userId省略時(呼び出し元がSTEP146未対応のまま): 従来どおり
//   絞り込みを行わない(後方互換)。
// - userIdが確定している場合(認証済み): そのuserId所有のProposalのみ。
// - userId === null(server側で検証したが未認証と確定): user_id IS NULL
//   (認証導入前に作られた既存データ)のみ。
// STEP145のlistConversations()と同じ設計(strict equality、
// null-ownedとのOR結合はしない)を踏襲する。
export async function getImprovementProposals(
  limit: number = 20,
  userId?: string | null
): Promise<StoredImprovementProposal[]> {

  try {

    let query = supabase
      .from("tact_memory")
      .select("id, user_id, target_agent, content, created_at")
      .eq("type", "improvement_proposal")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (userId !== undefined) {
      query = userId
        ? query.eq("user_id", userId)
        : query.is("user_id", null);
    }

    const { data, error } = await query;

    if (error) throw error;

    return (data ?? []).map((row) => ({
      ...(row.content as ImprovementProposal),
      id: row.id,
      targetAgent: row.target_agent,
      createdAtIso: row.created_at,
    }));

  } catch (error) {

    console.warn(
      "[Brain] Failed to load improvement proposals from DB.",
      error instanceof Error ? error.message : error
    );

    return [];

  }

}



// ==========================
// getImprovementProposalById (STEP142-A: TACT Codeが特定の
// Proposalを1件だけ取得するために必要)
// ==========================
//
// getImprovementProposals()と同じ読み取りロジックだが、
// idで1件に絞り込む。TACT Code(core/codeAgent/)がCodeTask作成時に
// 参照する。
//
// STEP146-C: 所有者チェック用にuserIdを受け取れるようにする。
// 重要: userId引数を省略した場合(=CodeTask作成フロー等、既存の
// 呼び出し元。STEP146-K「CodeTaskのマルチユーザー化は今回行わない」
// により変更しない)は、従来どおり無条件にProposalを返す
// (既存挙動を一切変えない)。
// userIdを明示的に渡した場合(認証済みリクエストを扱うAPI Route等)
// のみ、所有者(user_id)と一致しなければundefinedを返す
// (STEP145のGET /api/tact/conversationと同じ「存在の有無を漏らさない」
// 方針)。user_idが未設定(認証導入前の既存データ)の場合は、
// STEP145の後方互換方針を踏襲し、誰でも取得できる。

export async function getImprovementProposalById(
  id: string,
  userId?: string | null
): Promise<StoredImprovementProposal | undefined> {

  try {

    const { data, error } =
      await supabase
        .from("tact_memory")
        .select("id, user_id, target_agent, content, created_at")
        .eq("type", "improvement_proposal")
        .eq("id", id)
        .maybeSingle();

    if (error) throw error;

    if (!data) return undefined;

    if (
      userId !== undefined &&
      data.user_id &&
      data.user_id !== userId
    ) {
      return undefined;
    }

    return {
      ...(data.content as ImprovementProposal),
      id: data.id,
      targetAgent: data.target_agent,
      createdAtIso: data.created_at,
    };

  } catch (error) {

    console.warn(
      "[Brain] Failed to load improvement proposal by id from DB.",
      error instanceof Error ? error.message : error
    );

    return undefined;

  }

}



// ==========================
// recordCodeTaskOutcome (STEP142-G: 自己改善ループの最後の環)
// ==========================
//
// TACT Code(core/codeAgent/)がCoding Agentの実行・Testまでを終えた
// 結果を、Brainへ書き戻す。「コードを変更した」だけで成功扱いにせず、
// Test結果(typecheckPassed)を含めて保存することで、将来Brainが
// 「このProposalに基づく実装は実際にうまくいったか」を評価できる
// ようにするための最小限のフック。
//
// 型はtact_memory.typeが元々許可している既存の値
// ('success_pattern' / 'failure')をそのまま使う。新しい型・新しい
// テーブルは追加しない。ここでも「実行できていないものを成功として
// 記録する」ことは行わない(呼び出し元がoutcomeを正しく渡す前提)。

export async function recordCodeTaskOutcome(
  outcome: {
    proposalId: string;
    codeTaskId: string;
    success: boolean;
    summary: string;
    changedFiles: string[];
    typecheckPassed: boolean;
    // STEP143-B: blocked/scope_violation/dangerous_change/degraded等、
    // success:false の内訳をBrainが区別して学習できるようにする
    // ための追加フィールド(すべて省略可能。既存呼び出し元との
    // 後方互換を維持する)。
    outcomeType?:
      | "completed"
      | "blocked"
      | "failed"
      | "requires_human_review"
      | "rolled_back";
    failureReason?: string;
    evaluation?: unknown;
    rollback?: unknown;
    // STEP144-I: 将来の学習(どのCoding Agent・どのBranchで実行したか)
    // のために構造化して保存する。
    codingAgent?: string;
    gitBranch?: string;
  },
  userId?: string | null,
  conversationId?: string | null
): Promise<void> {

  try {

    const { error } =
      await supabase
        .from("tact_memory")
        .insert({
          user_id: userId ?? null,
          conversation_id: conversationId ?? null,
          type: outcome.success ? "success_pattern" : "failure",
          target_agent: null,
          content: outcome,
          importance: outcome.success ? 6 : 4,
          confidence: "medium",
          source: `code_task:${outcome.codeTaskId}`,
        });

    if (error) throw error;

  } catch (error) {

    console.warn(
      "[Brain] Failed to persist CodeTask outcome to DB.",
      error instanceof Error ? error.message : error
    );

  }

}



// ==========================
// refreshRelevantBrainMemory (STEP3: Memory Retrieval)
// ==========================
//
// Workflow開始時に1回呼び出し、「現在のtask」「現在のuser」に
// 関連する記憶だけをDBから取得する。全件をPromptへ流し込むことは
// しない(importance/recency/confidence/reuseCount + taskとの
// keyword一致で絞り込む)。
//
// 高度なEmbedding検索は今回実装しない(TACT DesignのassetDiscovery.ts
// と同じ、「まず素朴なkeyword matchingで成立させる」という方針)。
//
// 安全性: 他ユーザーの記憶を漏らさないよう、必ず
// `user_id = userId OR user_id IS NULL` の範囲に限定する
// (user_id IS NULLは「誰にでも適用可能な全体向けの記憶」のみ)。
//
// STEP147: 戻り値をPromise<BrainRule[]>に変更した(旧: Promise<void>、
// module-scopeの共有配列を書き換えるだけだった)。呼び出し元
// (core/workflow/index.ts)がこの戻り値をWorkflowContext.brainMemory
// (Workflow実行ごとに新規生成され、他のWorkflowと共有されない場所)へ
// 保持することで、複数Workflowの同時実行時にもMemoryが混ざらない
// ようにする。この関数自体はもはやどこの共有状態も書き換えない。

const MAX_RELEVANT_MEMORIES = 12;

function scoreMemoryRow(
  row: {
    content: unknown;
    importance: number;
    confidence: string;
    reuse_count: number;
    created_at: string;
  },
  taskKeywords: string[]
): number {

  const contentText =
    typeof row.content === "string"
      ? row.content
      : JSON.stringify(row.content ?? "");

  const keywordMatches = taskKeywords.filter(
    (kw) => kw.length >= 2 && contentText.includes(kw)
  ).length;

  const confidenceWeight =
    row.confidence === "high" ? 1.5 :
    row.confidence === "low" ? 0.6 : 1;

  const ageMs =
    Date.now() - new Date(row.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // 30日で概ね半減する程度の緩やかな減衰(高度な指数モデルは不要)。
  const recencyWeight = Math.max(0.2, 1 - ageDays / 60);

  const reuseWeight = 1 + Math.min(row.reuse_count, 10) * 0.05;

  return (
    (row.importance * 2 + keywordMatches * 3) *
    confidenceWeight *
    recencyWeight *
    reuseWeight
  );

}

function tokenizeTask(task: string): string[] {

  return task
    .split(/[\s、。,.・「」『』/／()（）\n]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 20);

}

export async function refreshRelevantBrainMemory(
  task: string,
  userId?: string | null
): Promise<BrainRule[]> {

  try {

    let query = supabase
      .from("tact_memory")
      .select(
        "id, target_agent, content, importance, confidence, reuse_count, created_at"
      )
      // STEP149: tact_memoryは type='instruction' 以外にも
      // improvement_proposal/success_pattern/failure/task(CodeTask本体)
      // 等、全く異なる形状のcontentを保持する共有テーブルである。
      // 以前はtypeで絞り込んでおらず、それらの構造化オブジェクトが
      // formatBrainMemory()の {rule, reason} 前提のフォーマットへ
      // JSON.stringifyされたまま「改善ルール」として紛れ込み、
      // Prompt内のBrain Memoryセクションへ生のJSON(過去のCodeTask
      // Sandboxテストの内容等を含む)が注入される問題が実機で確認された
      // (STEP148で発見)。saveBrainMemory()が書き込む唯一のtypeである
      // 'instruction' のみを対象にする。
      .eq("type", "instruction")
      .order("created_at", { ascending: false })
      .limit(200);

    query = userId
      ? query.or(`user_id.eq.${userId},user_id.is.null`)
      : query.is("user_id", null);

    const { data, error } = await query;

    if (error) throw error;

    if (!data || data.length === 0) {
      // DBにまだ何も無い(migration未適用含む)、またはこのuserId
      // (・全体向け)に該当する記憶がまだ無い場合。STEP147以前は
      // ここで「既存のプロセス内配列を維持する」フォールバックが
      // あったが、Brain MemoryはもうWorkflowごとのスナップショット
      // であり維持すべき前回状態が存在しないため、素直に空配列を返す
      // (=今回のWorkflowではBrain Memoryなしで進む。安全側)。
      return [];
    }

    const taskKeywords = tokenizeTask(task);

    const scored = data
      .map((row) => ({
        row,
        score: scoreMemoryRow(row, taskKeywords),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RELEVANT_MEMORIES);

    return scored.map(({ row }) => {

      const content = row.content as
        | { rule?: string; reason?: string }
        | string
        | null;

      const rule =
        typeof content === "string"
          ? content
          : content?.rule ?? JSON.stringify(content ?? "");

      const reason =
        typeof content === "string"
          ? ""
          : content?.reason ?? "";

      const result: BrainRule = {
        rule,
        reason,
        createdAt: new Date(row.created_at).getTime(),
      };

      if (row.target_agent) {
        result.targetAgent = row.target_agent;
      }

      return result;

    });

  } catch (error) {

    console.warn(
      "[Brain] Failed to load relevant memory from DB.",
      error instanceof Error ? error.message : error
    );

    // STEP147: 以前は「既存のプロセス内配列を維持する」だったが、
    // 維持すべき前回状態はもう存在しない。今回のWorkflowでは
    // Brain Memoryなしで進む(Workflow自体は失敗させない)。
    return [];

  }

}



// ==========================
// Prompt用
// ==========================
//
// STEP4(Optimizer→Workflow接続): agentIdを渡した場合、
// targetAgentが指定されている記憶のうち、そのAgent向けでない
// ものは除外する(targetAgent未指定の記憶は引き続き全Agent共通)。
// agentId省略時は既存どおり全件を返す(呼び出し元がbuildPrompt()
// 以外にもある場合の後方互換)。
//
// STEP147: module-scopeの共有配列を読む代わりに、呼び出し元
// (core/prompt/builder.ts)からMemory配列を直接受け取る純粋関数に
// 変更した。これにより、この関数自体はどのWorkflow/Requestの
// Memoryを表示しているかを一切「記憶」しない(呼び出しごとに渡された
// 引数だけで結果が決まる)。

export function formatBrainMemory(
  memory: BrainRule[],
  agentId?: string
) {

  const relevant =
    agentId
      ? memory.filter(
          (item) => !item.targetAgent || item.targetAgent === agentId
        )
      : memory;

  if (
    relevant.length === 0
  ) {

    return "None";

  }


  return relevant
    .map(
      (item) =>
        `
改善ルール:
${item.rule}

理由:
${item.reason}
`
    )
    .join("\n");

}
