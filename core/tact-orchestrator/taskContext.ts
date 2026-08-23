import type { CoreCapability, LoadContextParams } from "../tact-core/types";
import type { CoreContext } from "../tact-core/context/types";
import type { Task, TaskExecutionSummary } from "./task";
import type { MemoryReference, CoreReferenceScope } from "./types";

// =========================
// TaskContext (Phase 4)
// =========================
//
// 3層のContext分離(本Phaseの設計方針):
//   A. TACT Memory        = core/tact-core/*(Supabase実データ、既存)
//   B. Orchestrator Context = OrchestrationRequest + Task[] +
//                             TaskExecutionSummary[](Phase 1-3で既存)
//   C. Task Context(ここ)  = 1 Task分だけの、絞り込み済みContext
//
// TaskContextは「Taskが実行に必要とする最小限のもの」だけを持つ:
//   - coreContext: 既存のCoreContext型(core/tact-core/context/types.ts)
//     をそのまま再利用する。ただしloadContext()が返す「そのユーザーの
//     全Knowledge/Memory/Example」ではなく、このTaskのdescriptionに
//     関連するものだけへ絞り込んだ値を持つ(既存Research Capabilityの
//     入力契約(ResearchParams.context: CoreContext)を一切変更せずに
//     済むよう、型はそのまま・中身だけを絞る設計)。
//   - memoryReferences: 絞り込みに使った実データへの軽量な参照
//     (Phase 1-2のMemoryReference型をそのまま再利用)。
//   - dependencyResults: 依存Taskの「出力結果だけ」(id+output)。
//     依存Taskの全TaskExecutionSummary(memoryUsed/cost/usage等)は
//     持ち込まない(絶対条件: 「Task Aの全ContextをTask Bへ渡さない」)。
export interface TaskContext {

  task: Task;

  coreContext: CoreContext;

  memoryReferences: MemoryReference[];

  dependencyResults: { taskId: string; output?: string }[];

}

// Retrievalが返す1件あたりの上限。Phase 4は「賢い検索」を目標にせず、
// 「全件を渡さない」ことを優先するための単純な上限(絶対条件11:
// LLMを使わない決定論的なfiltering/ranking)。
const RETRIEVAL_LIMIT_PER_KIND = 5;

// =========================
// buildRetrievalQuery
// =========================
//
// 既存のscoreQueryRelevance()(core/tact-core/mockCoreCapability.ts・
// supabaseCoreCapability.ts、STEP177)は`query.split(/\s+/)`で
// トークン化する。英数字の空白区切りクエリは正しく分割できるが、
// 日本語には通常空白が無いため、「STEP210_USER_A_KNOWLEDGEについて
// 教えて」のような文全体が1トークンとして扱われ、Knowledgeのtitle
// (英数字部分のみ)と完全一致しない限り一切マッチしなくなる
// (実装時に実データで確認した実際の不具合)。
//
// 既存のscoreQueryRelevance/applyQueryAndLimit自体(core/tact-core/*)は
// 変更せず、ここではOrchestrator側で「渡すqueryの前処理」だけを行う:
// 英数字/アンダースコアの連続(ASCII/半角)と、漢字・ひらがな・
// カタカナの境界に空白を挿入する。これにより「STEP210_USER_A_KNOWLEDGE」
// のような固有名詞的なトークンが独立したtokenとして分割され、既存の
// scoreQueryRelevance()がsubstring一致で正しく拾えるようになる。
// 新しい形態素解析・Embeddingは追加しない(絶対条件11)、既存アルゴリズム
// が処理しやすい形へqueryを整形するだけの決定論的な前処理。
//
// Phase 8 Reality Testで発見・修正した不具合: 当初(Phase 4)は「ASCII
// 英数字/アンダースコア」と「それ以外すべて」の境界に空白を入れていた
// ため、句読点(「。」「.」等)も境界とみなされ、"5.7"のような数字+
// ピリオドが"5"/"."/"7"という3つの断片トークンへ分解されていた。
// scoreQueryRelevance()は「トークンが1文字でもtoken.length===0で
// なければ有効」とみなすため、"5"のような1文字トークンが、無関係な
// 既存Memory/Knowledge内のどこかにたまたま含まれる同じ文字
// (例: 別のテスト用Memoryの内容に含まれる"PHASE5"の"5")と一致し、
// 無関係なMemoryがTask Contextへ混入する実害を実データで確認した
// (「TypeScript 5.7の新機能について調べて」というqueryが、無関係な
// 過去のテストMemoryを"関連あり"として取得してしまった)。
// 句読点(Han/Hiragana/Katakana以外の非ASCII文字)を境界とみなさない
// ようにすることで、"5.7"のような数字表現やCJK文中の句読点が
// 分解されなくなり、この汚染を防ぐ。
//
// 追加で発見・修正した不具合(同じPhase 8 Reality Testの中で、
// "A社とB社のサービスをそれぞれ調べて比較して"という別の実入力から
// 判明): 上記の境界挿入自体は正しく動作するが、"A社"のような
// 英字1文字+CJKという構造では、境界挿入によって"A"という1文字だけの
// token(前後を空白で区切られた独立語)が生成される。1文字トークンは
// ほぼ無条件に何らかの無関係な既存Memory/Knowledge内に出現するため
// (英字"a"はどんな英数字混じりのテキストにも高確率で含まれる)、
// 「無関係なCoreデータがcore-only経路で"関連あり"と誤判定され、
// 見当違いの内容で確信をもって回答してしまう」という、単なる混入より
// 深刻な誤り(誤った回答内容)を実データで確認した。英字1文字/数字
// 1文字のtokenは信号としてほぼ無意味なため、境界挿入後にこれらを
// 除去する。CJK1文字(例:「社」)は英字1文字ほど無意味ではない
// (単独で意味を持つ語もあるため)、除去対象は英数字1文字に限定する。
// Phase 9(Memory-aware Chat Context Integration)実装時、Reality Test
// の追加ケースで発見・修正した3件目の不具合: "PHASE9_TEST_ALPHAと
// PHASE9_TEST_BETAという..."のように、ASCII識別子の間に短い日本語の
// 助詞・接続語(「と」「という」等)が挟まる文では、境界挿入によって
// その助詞だけが独立トークン化される。「と」「という」等は英語の
// stopword("a"/"the"/"and"相当)と同じく、ほぼ全ての日本語文に
// 出現する低情報量の語であり、単一文字ASCII tokenと全く同じ理由
// (ほぼ無条件に無関係な既存データへ一致する)で除去が必要。
// 新しい形態素解析・ストップワード辞書基盤は導入しない(絶対条件、
// STEP177/STEP4)。ここでは「格助詞・基本的な接続語」という、狭く
// 明確に定義できる範囲だけを列挙する固定リストとする(英語の
// stopword filterと同じ確立された手法、Embeddingや統計的手法は
// 使わない)。
const CJK_CHAR = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";

const SINGLE_CHAR_ASCII_TOKEN = /^[a-zA-Z0-9]$/;

const JAPANESE_STOPWORD_TOKENS = new Set([
  "と", "の", "を", "に", "は", "が", "も", "で", "や", "へ",
  "という", "とは", "として", "による", "における",
]);

function buildRetrievalQuery(description: string): string {

  const boundarySpaced = description
    .replace(new RegExp(`([a-zA-Z0-9_]+)([${CJK_CHAR}])`, "gu"), "$1 $2")
    .replace(new RegExp(`([${CJK_CHAR}])([a-zA-Z0-9_]+)`, "gu"), "$1 $2");

  return boundarySpaced
    .split(/\s+/)
    .filter(
      (token) =>
        token &&
        !SINGLE_CHAR_ASCII_TOKEN.test(token) &&
        !JAPANESE_STOPWORD_TOKENS.has(token)
    )
    .join(" ");

}

function emptyCoreContext(): CoreContext {

  return {
    memories: [],
    knowledge: [],
    examples: [],
    recentExecutions: [],
  };

}

// =========================
// buildTaskContext
// =========================
//
// 既存CoreCapability.retrieveKnowledge/retrieveMemory/retrieveExamples
// (core/tact-core/types.ts)をそのまま再利用する(新しいMemory検索
// 基盤を作らない、絶対条件)。queryにはtask.descriptionをそのまま渡す
// (STEP177/STEP208の既存「簡易keyword relevance」検索がそのまま動く、
// LLMによるQuery生成は行わない)。
//
// Phase 9での変更点: Phase 4〜8時点では、assignedCapabilityが無い
// Task(chat)はCore retrieval自体をスキップしていた(Chat Handlerが
// contextを受け取れなかったため、「渡せないものを取得しない」という
// 判断)。Phase 9でChat Handler(core/tact-intent/chatHandler.ts)が
// CoreContextを受け取れるようになったため、この制約を撤廃する。
// chat/research/その他Capabilityのいずれであっても、Task単位で
// 同じretrieval機構を使う(絶対条件2・3: Chat専用の別Context機構を
// 作らない、Task単位のCore retrievalを利用する)。
//
// ownerId未確定(未認証)の場合のみ引き続きスキップする(既存の
// supabaseCoreCapability.tsの「userId未指定→空のCoreContext」
// フォールバックと同じ安全側の判断をOrchestrator側でも踏襲する)。
export async function buildTaskContext(
  task: Task,
  core: CoreCapability,
  ownerParams: LoadContextParams,
  dependencySummaries: TaskExecutionSummary[]
): Promise<TaskContext> {

  // 絶対条件(依存関係): 依存Taskの「必要な結果」だけを渡す。
  // dependencySummaries自体、呼び出し元(executor.ts)が既にこのTaskの
  // dependencies分だけへ絞り込んだ配列を渡してくる(他Taskの結果は
  // ここに現れない)。ここではさらにoutputだけを取り出し、
  // memoryUsed/usage/cost等の実行時メタデータは意図的に落とす。
  const dependencyResults = dependencySummaries
    .filter((summary) => summary.status === "completed")
    .map((summary) => ({ taskId: summary.taskId, output: summary.output }));

  if (!ownerParams.userId) {

    return {
      task,
      coreContext: emptyCoreContext(),
      memoryReferences: [],
      dependencyResults,
    };

  }

  const retrievalParams = {
    ...ownerParams,
    query: buildRetrievalQuery(task.description),
    limit: RETRIEVAL_LIMIT_PER_KIND,
  };

  const [knowledge, memories, examples] = await Promise.all([
    core.retrieveKnowledge(retrievalParams),
    core.retrieveMemory(retrievalParams),
    core.retrieveExamples(retrievalParams),
  ]);

  const memoryReferences: MemoryReference[] = [
    ...knowledge.map((item) => ({
      kind: "knowledge" as const,
      id: item.id,
      scope: item.scope as CoreReferenceScope,
    })),
    ...memories.map((item) => ({
      kind: "memory" as const,
      id: item.id,
      scope: item.scope as CoreReferenceScope,
    })),
    ...examples.map((item) => ({
      kind: "example" as const,
      id: item.id,
      scope: item.scope as CoreReferenceScope,
    })),
  ];

  return {

    task,

    coreContext: {
      memories,
      knowledge,
      examples,
      recentExecutions: [],
    },

    memoryReferences,

    dependencyResults,

  };

}
