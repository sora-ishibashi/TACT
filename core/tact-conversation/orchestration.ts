import { runOrchestration } from "../tact-orchestrator";
import type { OrchestrationResult, TaskExecutionSummary } from "../tact-orchestrator";
import { getSimpleChatResponse } from "../tact-intent/ruleRouter";

import type {
  Conversation,
  ConversationMessage,
  ExecutionRecord,
  ExecutionCapability,
  ExecutionStatus,
  PendingClarification,
} from "./types";

import {
  appendConversationMessage,
  appendConversationMessageWithAttachments,
  recordClarificationQuestion,
  recordClarificationAnswer,
  recordExecution,
  getPendingClarification,
  clearPendingClarification,
  getConversationMessages,
  linkConversationArtifact,
  // BOT-P2: runConversationTurn()(Conversationのresolve-or-create + 実行)
  // が使う。既存のapp/api/tact/tact-conversations/route.tsのPOST handler
  // と同じ2関数だが、これまでroute.ts側にしかimportされていなかった
  // (Conversation自体の存在確認・新規作成は呼び出し元の責務という既存の
  // layering)。BOT-P2でWeb(route.ts)とBot(core/tact-bot/)の両方から
  // 同じConversation解決ロジックを再利用できるようにするため、この
  // ファイルへ集約する(route.ts自体は変更しない、既存Web挙動に影響なし)。
  getConversation,
  createConversation,
} from "./store";

import {
  classifyArtifactMutation,
  classifyTablePurpose,
  parseComparisonColumns,
  parseRequestedRowCount,
  hasTableIntent,
  hasChartIntent,
  appendRowEntitiesFromText,
  deriveArtifactTitle,
  buildResearchMutationBlocks,
  buildSimpleMutationBlock,
  buildExampleMutationBlocks,
  buildMutationConfirmation,
  buildResearchTableSchema,
} from "./artifactMutation";
import type { ArtifactMutationKind, MutationConfirmationDetail } from "./artifactMutation";

import {
  isArtifactReferenceQuestion,
  buildArtifactReferenceAnswer,
} from "./artifactReference";

import {
  getArtifact,
  createArtifact,
  updateArtifactBlocks,
  buildTableFromBlocks,
  buildComparisonTableFromBlocks,
  appendRowsToTable,
  buildChartFromTable,
  createEvidenceBlock,
  nextOrder,
} from "../tact-artifact";
import type { ArtifactBlock, TableBlock } from "../tact-artifact";
import type { ResearchEvidenceItem } from "../tact-research/types";
import type { AttachmentEvidence } from "../tact-attachment/types";
// LW-P3: attachmentEvidenceと並行するLocal Workspace Evidence。
import type { LocalWorkspaceEvidence } from "../tact-context-source/localWorkspace/types";
import type { ResearchPresentation } from "../tact-analysis/presentation/types";
import { mergeResearchPresentationBlocks } from "../tact-analysis/presentation/artifactIntegration";
import type { ResearchFrameworkArtifact } from "../tact-analysis/framework/types";
import { mergeResearchFrameworkBlocks } from "../tact-analysis/framework/artifactIntegration";
import type { AnalysisArtifactPlan } from "../tact-analysis/composition";
import { mergeAnalysisArtifactPlanBlocks } from "../tact-analysis/composition";

// =========================
// TACT Conversation — Orchestrator Integration (Phase 67, Phase68でClarification
// Answer Re-execution追加)
// =========================
//
// Phase64〜66で完成したConversation Architectureに、既存
// core/tact-orchestrator/*(Phase1〜28)を接続する唯一のファイル。
//
// 依存方向: core/tact-conversation/*の他ファイル(types.ts/store.ts)は
// core/tact-orchestrator/*を一切importしないが、このファイルだけは
// Phase67 Section2の設計図(Conversation Layer → Orchestrator
// Integration → core/tact-orchestrator/*)通り、意図的にimportする。
// これによりstore.ts(純粋なDB永続化)とOrchestrator呼び出し
// (Execution)の責務を分離したまま、Conversation LayerがExecution
// Stateを直接保持しない(Section2絶対条件)という制約を維持する。
//
// 絶対条件(Invariant 1〜4、Phase67 Section3): Conversation≠Execution
// (Execution詳細をConversationMessageへ埋め込まない)。Task IDを
// Conversation Layerへ露出しない(planConversationTurn()の戻り値は
// executionId・status・answer・questionのみで、TaskExecutionSummary
// そのものやtaskIdを一切含まない)。ClarificationはExecutionではない
// (ExecutionRecordを作らない)。executionIdは通常Execution時のみ
// Persistenceする。
//
// Phase68で追加したClarification Answer Re-execution Flowも、この
// ファイル内で完結させる(API Route側にClarification固有の判定・DB
// queryを一切持たせない、Phase68 Section3の絶対条件)。

// =========================
// mapOrchestrationTasksToExecutionStatus (純粋関数)
// =========================
//
// Phase67 Section10: DB側の許可値(completed/failed/partial)以外を
// 作らない。OrchestrationResult.tasks(TaskExecutionSummary[])の実際の
// status値("pending"|"running"|"completed"|"failed"|"cancelled"、
// core/tact-orchestrator/task.ts)から決定論的に導出する。
//
// 正常完了(全Task completed) → completed
// 全滅(1件もcompletedでない) → failed
// 一部成功・一部失敗/cancelled → partial
// tasks=[](現行decomposeTask()の設計上、Clarification以外では
// 発生しない想定、Repository Evidence)は安全側でfailedとする。

export function mapOrchestrationTasksToExecutionStatus(
  tasks: TaskExecutionSummary[]
): ExecutionStatus {

  if (tasks.length === 0) {
    return "failed";
  }

  const completedCount = tasks.filter((task) => task.status === "completed").length;

  if (completedCount === tasks.length) {
    return "completed";
  }

  if (completedCount === 0) {
    return "failed";
  }

  return "partial";

}

// =========================
// deriveExecutionCapability (純粋関数、Phase69)
// =========================
//
// Repository Evidence(Phase69 Step3、以下の実装を直接確認して確定):
//   - core/tact-bootstrap.ts: registerCapability("research", runResearch)
//     ——"research"のみがCapability Registryに実装として登録されている
//     (Commander/executor.tsからHTTPを経由しない直接function call)。
//   - core/tact-orchestrator/decomposer.ts: classifyIntent()の判定が
//     "research"の場合のみTask.assignedCapability="research"を設定する。
//     それ以外(chat/core_push等)は常にassignedCapability=undefinedの
//     まま(executor.tsのChat Handlerフォールバックへ進む、Capability
//     Registryには一切到達しない)。
//   - core/tact-orchestrator/executor.ts: task.assignedCapability==="research"
//     の場合のみinvokeCapability("research", ...)を呼び、
//     TaskExecutionSummary.capability="research"を設定する
//     (research以外の経路ではcapabilityはtask.assignedCapability
//     ——つまりundefined——のまま)。
//
// これにより、OrchestrationResult.tasksが全件capability==="research"で
// あることは「このTurnの実行がResearch Capability経由だったこと」の
// 決定論的な証拠になる(Task IDそのものは一切参照しない、Invariant2
// 継続維持)。1件でもresearch以外(chatフォールバック等、capability=
// undefined)が混ざる場合、またはtasks=[]の場合は、Phase67から続く
// 既存の"orchestrator"ラベルを維持する(新しい"mixed"等の値を
// 推測で追加しない、Section19の絶対条件)。

export function deriveExecutionCapability(
  tasks: TaskExecutionSummary[]
): ExecutionCapability {

  if (tasks.length > 0 && tasks.every((task) => task.capability === "research")) {
    return "research";
  }

  return "orchestrator";

}

// =========================
// planConversationTurn (純粋関数)
// =========================
//
// OrchestrationResultから「Conversation Layerが何を永続化すべきか」を
// 決定論的に導出する。DB access・Orchestrator呼び出しのいずれも
// 行わない(テスト容易性のため、Phase66のparseTurnRequestBody()と同じ
// 設計方針)。通常Turn・Clarification Answer再実行Turnのいずれからも
// 共通で使う(再実行も「通常実行と同じExecutionRecord lifecycle」を
// 使う、Phase68 Section6の要求)。

export type ConversationOrchestrationPlan =
  | {
      kind: "clarification";
      question: string;
    }
  | {
      kind: "normal";
      executionId: string;
      status: ExecutionStatus;
      answer: string;
      capability: ExecutionCapability;
      // Phase76: 全TaskExecutionSummary.evidence/keyFindingsを結合した
      // もの(research以外のTaskはundefinedのため自然に除外される)。
      // Artifact Mutation(applyArtifactMutation())がEvidence/Finding
      // Blockを構築するために使う。新しいLLM/Retrieval呼び出しは
      // 発生しない(既にexecutor.tsが素通ししている値を集約するだけ)。
      evidence: ResearchEvidenceItem[];
      keyFindings: string[];
      presentations?: ResearchPresentation[];
      presentationWarnings?: import("../tact-analysis/types").ValidationIssue[];
      presentationRequested?: boolean;
      frameworkArtifacts?: ResearchFrameworkArtifact[];
      frameworkArtifactRequested?: boolean;
      analysisArtifactPlans?: AnalysisArtifactPlan[];
      cortexArtifactPlanRequested?: boolean;
    };

export function planConversationTurn(
  result: OrchestrationResult
): ConversationOrchestrationPlan {

  // Phase15の既存設計上、clarificationが設定されている場合は
  // tasks=[]・executionIdはOrchestrator内部でのみ生成される
  // (commander.ts、Clarification短絡分岐)。Invariant4により、この
  // executionIdはConversation Layer側では一切Persistenceしない。
  if (result.clarification) {

    return {
      kind: "clarification",
      question: result.clarification.question,
    };

  }

  return {
    kind: "normal",
    executionId: result.executionId,
    status: mapOrchestrationTasksToExecutionStatus(result.tasks),
    answer: result.answer,
    capability: deriveExecutionCapability(result.tasks),
    evidence: result.tasks.flatMap((task) => task.evidence ?? []),
    keyFindings: result.tasks.flatMap((task) => task.keyFindings ?? []),
    presentations: result.tasks.flatMap((task) => task.presentations ?? []),
    presentationWarnings: result.tasks.flatMap((task) => task.presentationWarnings ?? []),
    presentationRequested: result.tasks.some((task) => task.presentationRequested === true),
    frameworkArtifacts: result.tasks.flatMap((task) => task.frameworkArtifacts ?? []),
    frameworkArtifactRequested: result.tasks.some((task) => task.frameworkArtifactRequested === true),
    analysisArtifactPlans: result.tasks.flatMap((task) => task.analysisArtifactPlan ? [task.analysisArtifactPlan] : []),
    cortexArtifactPlanRequested: result.tasks.some((task) => task.cortexArtifactPlanRequested === true),
  };

}

// =========================
// buildClarificationResendInput (純粋関数)
// =========================
//
// Phase68 Section5: 新しいprompt abstraction・LLM/provider固有の
// formattingを作らず、既存の設計パターンをreuseする。Legacy
// core/conversation/clarification.tsのbuildClarificationResendInput()
// (Phase46で確立、Phase55で継続採用)と全く同じテキスト結合形式を
// 採用する——ただしtact-conversationはLegacy(core/conversation/*)を
// importしない既存方針(Phase61〜65)のため、コードは再実装する
// (Pattern reuseのみ、Code reuseではない)。
//
// originalInputがnull(会話履歴から復元できなかった、Section4の
// 「安全側へ倒れる」防御的ケース)の場合は、question+answerのみを
// 結合する(Orchestrator呼び出し自体は継続する、失敗させない)。

export function buildClarificationResendInput(
  originalInput: string | null,
  question: string,
  answer: string
): string {

  if (originalInput === null) {
    return `(補足: 「${question}」への回答: ${answer})`;
  }

  return `${originalInput}\n(補足: 「${question}」への回答: ${answer})`;

}

// =========================
// findPrecedingUserInput (純粋関数)
// =========================
//
// Orchestrator(core/tact-orchestrator/commander.ts)はconversationIdを
// 受け取らず、1回の呼び出しごとに完結する(Phase67 Repository Evidence:
// 既存の唯一の呼び出し元app/api/tact/orchestrate/route.tsもconversationId
// を渡していない)。そのためClarification再実行時、Orchestrator自身は
// 「元々何を聞かれていたか」を一切覚えていない。再実行Inputに元の
// User入力を含めることは、Orchestratorをstatefulにする変更ではなく、
// Conversation Layer側が会話履歴から一度だけ復元し、1本のinput文字列
// として渡すだけの既存契約内の対応(Phase68 Section5「最小限の既存構造を
// reuseする」)。
//
// 見つからない場合(データ不整合・Clarification Messageの直前に
// User Messageが存在しない等)はnullを返す(安全側、Section4)。

export function findPrecedingUserInput(
  messages: ConversationMessage[],
  beforeMessageId: string
): string | null {

  const index = messages.findIndex((message) => message.id === beforeMessageId);

  if (index <= 0) {
    return null;
  }

  for (let i = index - 1; i >= 0; i--) {

    if (messages[i].role === "user") {
      return messages[i].content;
    }

  }

  return null;

}

// =========================
// ConversationTurnResult
// =========================
//
// messageは常に「今回のTurnでUserへ返す1件」を指す(clarification質問、
// またはassistant回答)。Legacy(app/api/tact/conversation/route.ts)の
// `message: lastMessage`と同じ意味論(最後に追加されたメッセージ)。
// executionRecordはClarification時はundefinedのまま(Invariant3)。

export interface ConversationTurnResult {

  conversation: Conversation;

  userMessage: ConversationMessage;

  message: ConversationMessage;

  executionRecord?: ExecutionRecord;

}

// =========================
// runConversationOrchestration
// =========================
//
// Phase68 Section3: turn開始時にconversation.pendingClarificationMessageId
// を確認し、pendingが無ければPhase67の通常Turn処理(runNormalTurn())、
// pendingがあればClarification Answer Re-execution Flow
// (runClarificationAnswerTurn())へ分岐する。この判定はConversation
// Layer側の責務であり、API Route(app/api/tact/tact-conversations/route.ts)
// 側には一切のClarification固有ロジックを持たせない
// (Phase66から契約不変、Phase68 Section11)。

export async function runConversationOrchestration(
  conversation: Conversation,
  accessToken: string,
  userInput: string,
  attachmentIds: string[] = [],
  attachmentEvidence: AttachmentEvidence[] = [],
  // LW-P3: client-side Workspace Context Resolverが既にbound済みの
  // Local Workspace Evidence(app/api/tact/tact-conversations/route.ts
  // でのserver validation通過後の値)。
  workspaceEvidence: LocalWorkspaceEvidence[] = []
): Promise<ConversationTurnResult> {

  const pending = await getPendingClarification(conversation, accessToken);

  if (pending) {
    return runClarificationAnswerTurn(conversation, accessToken, userInput, pending);
  }

  return runNormalTurn(conversation, accessToken, userInput, attachmentIds, attachmentEvidence, workspaceEvidence);

}

// =========================
// runConversationTurn (BOT-P2)
// =========================
//
// app/api/tact/tact-conversations/route.tsのPOST handlerが持つ
// 「conversationIdがあれば所有権確認込みで取得・無ければ新規作成
// →runConversationOrchestration()→最新状態を再取得」という一連の
// 流れを、HTTP(NextRequest/NextResponse)から独立した共通関数として
// 抽出したもの。route.ts自体はこの関数を呼ぶよう変更していない
// (既存Web挙動に一切影響を与えない、絶対条件)。core/tact-bot/の
// Conversation Connector(BOT-P2)が、Web(route.ts)と全く同じ
// Conversation/Orchestrator実行経路を再利用するために、ここから
// 呼び出す。
//
// 「Botに独自のConversation管理を作らない」という方針を、
// この関数自体がroute.tsのロジックを複製せず1箇所に集約することで
// 支える。projectId/attachmentIds等、route.ts固有の付随的な入力は
// 意図的に含めない(BOT-P2時点でBotはこれらを使わないため。将来
// 必要になれば、この関数へoptional paramとして追加する)。
//
// 呼び出し元がuserId/accessTokenとしてどんな値を渡すかは、この関数の
// 関知するところではない(既存のstore.ts関数と同じ、token-agnostic
// design)。Web routeは実Supabase Auth JWTを渡す。Bot Conversation
// Connector(core/tact-bot/connector/conversationConnector.ts)は、
// identity resolver(core/tact-bot/identity/)で解決済みのtactUserIdと、
// Bot専用のservice role keyを渡す——「identity解決済みの場合のみ・
// 狭いconnector内だけでservice roleを使う」というBOT-P2のsecurity
// 設計は、この関数の外側(呼び出し元)の責務であり、この関数自体は
// 何がaccessTokenとして渡されたかを判断しない(token-agnostic)。

export interface RunConversationTurnParams {

  userId: string;

  accessToken: string;

  content: string;

  // 省略時は新規Conversationを作成する。
  conversationId?: string;

  attachmentEvidence?: AttachmentEvidence[];

  workspaceEvidence?: LocalWorkspaceEvidence[];

}

export type RunConversationTurnResult =
  | ({ ok: true } & ConversationTurnResult)
  | { ok: false; error: "conversation_not_found" };

const CONVERSATION_TITLE_MAX_LENGTH = 60;

function deriveConversationTitle(content: string): string {

  const trimmed = content.trim();

  return trimmed.length > CONVERSATION_TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, CONVERSATION_TITLE_MAX_LENGTH)}...`
    : trimmed;

}

export async function runConversationTurn(
  params: RunConversationTurnParams
): Promise<RunConversationTurnResult> {

  const {
    userId,
    accessToken,
    content,
    conversationId,
    attachmentEvidence = [],
    workspaceEvidence = [],
  } = params;

  // route.tsのWrite Ordering(Phase63 Section8)と同じ: conversationIdが
  // 指定された場合、所有権確認(user_idでの絞り込み)を必ず経由する。
  // 他userのconversationIdを渡された場合は「存在しない」と同じ扱いで
  // 拒否する(IDOR対策、既存route.tsの既存方針をそのまま踏襲)。
  let conversation = conversationId
    ? await getConversation(conversationId, userId, accessToken)
    : undefined;

  if (conversationId && !conversation) {
    return { ok: false, error: "conversation_not_found" };
  }

  if (!conversation) {
    conversation = await createConversation(userId, accessToken, deriveConversationTitle(content));
  }

  const turn = await runConversationOrchestration(
    conversation,
    accessToken,
    content,
    [],
    attachmentEvidence,
    workspaceEvidence
  );

  // route.tsと同じ理由: runConversationOrchestration()の各ステップは
  // Conversation.updated_at等を更新するが、turn自体は最新状態を
  // 返さないため、明示的に再取得する。
  const refreshedConversation =
    (await getConversation(conversation.id, userId, accessToken)) ?? turn.conversation;

  return { ok: true, ...turn, conversation: refreshedConversation };

}

// =========================
// runNormalTurn (Phase67から変更なし)
// =========================
//
// Phase67 Section6の責務契約通り:
//   1. User Messageを保存
//   2. Orchestratorを実行
//   3. 結果を判定(planConversationTurn())
//   4. 通常完了ならExecutionRecordを保存
//   5. Assistant Messageを保存
//   6. ClarificationならClarification Messageのみ保存
//   7. Conversation.updated_atを更新
//      (store.ts各関数が内部でbumpConversationUpdatedAt()を呼ぶため、
//      個別のstep7呼び出しを追加しない——Phase65から一貫した既存設計)
//
// Write Ordering(Phase63 Section8〜9、Phase67 Section12)を厳守する:
// 通常: User Message → ExecutionRecord → Assistant Message
// Clarification: User Message → Clarification Message →
//                pending_clarification_message_id UPDATE
//                (recordClarificationQuestion()内部で担保済み、Phase65)
//
// conversationIdはOrchestrationRequestへ渡さない(既存の唯一の呼び出し
// 元であるapp/api/tact/orchestrate/route.ts、Phase33と同じ既存方針。
// Phase63で判明した通りcore/tact-core/supabaseCoreCapability.tsは
// scope="conversation"を一切実装しておらずErrorを投げるため、新たに
// conversationIdを繋ぐこと自体が未検証のリスクを持ち込む)。
//
// Orchestrator自体が例外を投げた場合(想定外エラー)、User Messageは
// 既に保存済みのまま(Legacy app/api/tact/conversation/route.tsの
// 既存の受容された挙動と同じ——エラー発生前までの状態を保持する)、
// 例外をそのまま呼び出し元(API Route)へ伝播する。executionId自体が
// 存在しないため、ExecutionRecordは作成しない(新しいTransaction
// abstractionは導入しない、Phase67絶対条件19/Phase68絶対条件18)。

// =========================
// Phase78 Tier1(Evidence-Grounded Artifact): Table/Chart用の
// 追加Research
// =========================
//
// Repository Evidence(Phase78投資調査): Phase76〜77のTable/Chart
// Mutationは既存Artifact内のExample/Evidence Blockのみを参照し、
// 新しいResearch/Searchを一切実行していなかった(Phase78 Section2の
// 問題指摘そのもの)。ここでは「表/グラフを作るためにResearchする」
// という発想へ変更するが、新しいResearch Pipelineを二重実装せず、
// 既存のcore/tact-orchestrator/runOrchestration()(core/tact-research/
// runResearch()への唯一の実行経路、Phase1〜28で確立済み)をそのまま
// 再利用する(絶対条件Section4「最小限の変更で接続する」)。
//
// Orchestrator非改変の設計(重要): OrchestrationRequest.intentフィールド
// (型定義にコメントがあるが、実際にはcore/tact-orchestrator/
// decomposer.tsが一切読んでいない未配線のフィールドであることを
// Repository Evidenceで確認済み)には依存しない。代わりに、
// core/tact-intent/ruleRouter.tsのRESEARCH_PATTERN
// (/(調べ|調査し|リサーチし)(て|てほしい|てもらえる|てください)/)に
// 確実に一致するクエリ文字列を組み立てて渡すことで、Orchestrator側を
// 一切変更せずにResearch Capability経由の実行を確実に起動する。

// Table/Chart Mutationにとって「既に十分なデータがあるか」の決定論的
// 判定。既存Evidence Table更新(appendRowsToTable、Phase76〜77)は
// この対象外(既存の追記ロジックをそのまま使う、Phase78のスコープを
// 新規構築時に限定してコストを抑える、Section13)。
//
// Phase79拡張(Section8): Comparison Table(tablePurpose:"comparison")
// は、既存Tableの有無ではなく「構造化Row Entity(fields付き
// ExampleBlock)の件数」で判定する——既存Comparison Tableを更新する
// 場合でも、要求件数(requestedRowCount)に届いていなければ追加
// Researchを試みる(Section8の絶対条件、Evidence-Table経路とは意図的
// に異なる)。
export function needsSupplementalResearchForArtifact(
  kind: ArtifactMutationKind,
  existingBlocks: ArtifactBlock[],
  options: { tablePurpose?: "comparison" | "evidence"; requestedRowCount?: number } = {}
): boolean {

  if (kind === "table") {

    if (options.tablePurpose === "comparison") {
      return !hasEnoughRowEntities(existingBlocks, options.requestedRowCount);
    }

    const hasExistingTable = existingBlocks.some(
      (b) => b.type === "table" && b.tablePurpose !== "comparison"
    );

    if (hasExistingTable) {
      // 既存Tableへの追記はappendRowsToTable()が既存Blockの範囲内で
      // 処理する(Phase76〜77の既存挙動を維持、追加コストを発生させない)。
      return false;
    }

    return !existingBlocks.some((b) => b.type === "example" || b.type === "evidence");

  }

  if (kind === "chart") {

    // Chartは既存Table Blockからのみ導出される(Phase76の既存設計)。
    // Tableが1件も無ければ、まずEvidenceを補うためのResearchを試みる
    // (Section3のフロー通り)。Tableが既にあるが数値列が無く
    // buildChartFromTable()が失敗するケースは、追加Researchをしても
    // (Tier1では数値抽出を行わないため)解消しないので対象外とする
    // (Section13「コスト削減のためにEvidenceのないデータを使用しては
    // いけない」の裏返し——助からない追加課金は避ける)。
    return !existingBlocks.some((b) => b.type === "table");

  }

  return false;

}

// Section2の「必要なデータ項目を特定」に対応する、決定論的な補足
// クエリ構築。deriveArtifactTitle()で命令文を除いたトピックへ、
// RESEARCH_PATTERNへ確実に一致する語尾(「について調査してください」)
// を付与する。新しいLLM呼び出しは発生しない(文字列組み立てのみ)。
//
// Phase88(Repository Evidence: Phase87投資調査): Turn3のような
// 「ここまで調べた内容を比較表にしてください」という依頼では、
// userInput自身から抽出したtopic(deriveArtifactTitle(userInput))が
// 「ここまで調べた内容」のような文脈依存の指示語になり、核心トピック
// (「愛知県」「スポーツイベント」等)を失う。existingTopic(呼び出し元
// が既存Artifact.titleから渡す——最初のTurnで既に確立・保存済みの値を
// そのまま使うだけで、新しいContext機構は追加しない)が分かっていて、
// かつuserInput由来のtopicに含まれていない場合はそれを優先する。
export function buildSupplementalResearchQuery(
  userInput: string,
  existingTopic?: string
): string {

  const derivedTopic = deriveArtifactTitle(userInput);

  const topic =
    existingTopic && !derivedTopic.includes(existingTopic)
      ? `${existingTopic} ${derivedTopic}`
      : derivedTopic;

  return `${topic}について調査してください`;

}

// 実際にOrchestrator(既存のResearch Capability経由)を呼び、取得した
// Evidenceだけを返す。Conversation Message・ExecutionRecordはここでは
// 一切永続化しない(このResearchは「Turnの主結果」ではなく、Table/
// Chart構築のための内部的な補助データ取得であるため、Invariant2
// 「Task IDをConversation Layerへ露出しない」と同じ精神で、
// Conversation履歴を汚染しない)。Clarificationが返った場合(曖昧と
// 判定された場合)は空配列を返す——このクエリは決定論的に構築して
// いるため通常は発生しないが、安全側で例外を投げずに処理する。
// Phase78 Section16「Research失敗時にArtifactを壊さない」(Test N):
// 通常Turnの主実行(runNormalTurn())とは異なり、この補助Researchは
// 失敗しても例外を外へ伝播させない——あくまで「Table/Chartを組み立てる
// ための補助データ取得の試み」であり、失敗した場合は「今回はEvidence
// を追加取得できなかった」として扱う(呼び出し元はそのまま既存
// blocksでの判定(データ不足なら拒否)へフォールバックする、安全側)。
// Phase79拡張: answerも返す(Section8「不足しているEntity情報を
// 取得するResearch Query」の結果を、Row Entity化(構造化)する
// mergeSupplementalRowEntities()が必要とするため)。evidenceのみを
// 使うEvidence-Table経路(mergeSupplementalEvidence())は従来通り
// evidenceフィールドだけを読む。
export interface SupplementalResearchOutcome {
  answer: string;
  evidence: ResearchEvidenceItem[];
}

export async function runSupplementalResearchForArtifact(
  userId: string | undefined,
  userInput: string,
  // Phase88: 呼び出し元(applyArtifactMutation())が既存Artifact.title
  // を渡せるようにする(省略時は既存Phase78〜86と完全に同じ挙動)。
  existingTopic?: string,
  // Phase90: Table Schema(列構成・要求件数)。呼び出し元が
  // buildResearchTableSchema(userInput)の結果をそのまま渡す。
  // buildSupplementalResearchQuery()が組み立てるqueryは常に
  // RESEARCH_PATTERNへ一致する語尾を持つため、この補足Researchは
  // 必ずResearch Capability経由になり、Table Schemaが確実に
  // Research Promptへ注入される(省略時は既存Phase78〜89と完全に
  // 同じ挙動)。
  tableSchema?: { columns: string[]; requestedRowCount?: number }
): Promise<SupplementalResearchOutcome> {

  try {

    const query = buildSupplementalResearchQuery(userInput, existingTopic);

    const result = await runOrchestration({ userId, input: query, tableSchema });

    if (result.clarification) {
      return { answer: "", evidence: [] };
    }

    return {
      answer: result.answer,
      evidence: result.tasks.flatMap((task) => task.evidence ?? []),
    };

  } catch (error) {

    console.error("TACT Artifact supplemental research failed:", error);

    return { answer: "", evidence: [] };

  }

}

// Research取得したEvidenceをEvidence Blockへ変換し、既存blocksの末尾へ
// 追加する(既存Blockには一切触れない、Section12絶対条件と同じ精神)。
export function mergeSupplementalEvidence(
  existingBlocks: ArtifactBlock[],
  evidence: ResearchEvidenceItem[]
): ArtifactBlock[] {

  if (evidence.length === 0) {
    return existingBlocks;
  }

  let order = nextOrder(existingBlocks);

  const newBlocks = evidence.map((item) => {

    const block = createEvidenceBlock(
      {
        claim: item.claim,
        source: item.source,
        confidence: item.confidence,
        data: item.snippet,
      },
      order
    );

    order += 1;

    return block;

  });

  return [...existingBlocks, ...newBlocks];

}

// =========================
// mergeSupplementalRowEntities (Phase79 Section8)
// =========================
//
// Comparison Table用の補足Research結果を、Evidence Block(traceability
// 用)とRow Entity(構造化ExampleBlock)の両方として取り込む。
// parseStructuredEntitiesFromText()がsupplemental.answerを構造化
// できなければ、Evidence Blockの追加だけに留める(Row Entityを
// 無理に作らない、Section11「捏造しない」と同じ精神——決定論的に
// 分解できるものだけを分解する)。
// Phase80: Entity抽出+ExampleBlock変換の実処理はartifactMutation.tsの
// appendRowEntitiesFromText()(Phase79のbuildExampleMutationBlocks()から
// 独立させた共通部品)へ委譲する。Research kind自身のanswer(Phase80
// Section2〜4)にも同じ関数を使うため、実装を二重に持たない。
// Phase83: supplemental.evidence(実際に取得したEvidence本文)を
// Evidence Groundingの照合対象として渡す。架空の固有名詞・属性を
// 補足Researchの結果からもRow Entity化しない(Rule4/Rule3)。
export function mergeSupplementalRowEntities(
  existingBlocks: ArtifactBlock[],
  supplemental: SupplementalResearchOutcome
): ArtifactBlock[] {

  const withEvidence = mergeSupplementalEvidence(existingBlocks, supplemental.evidence);

  const evidenceIds = supplemental.evidence.map((item) => item.id);

  return appendRowEntitiesFromText(withEvidence, supplemental.answer, evidenceIds, supplemental.evidence);

}

// Phase80 Section6: Comparison Tableの行として使えるRow Entity
// (fields付きExampleBlock)が要求件数に対して十分かを判定する共通
// 部品。needsSupplementalResearchForArtifact()(既存Table kind用)と
// buildResearchOutcomeWithOptionalTable()(Phase80、Research kind用)の
// 両方から使う(判定基準を重複実装しない)。
export function hasEnoughRowEntities(
  blocks: ArtifactBlock[],
  requestedRowCount?: number
): boolean {

  const structuredEntityCount = blocks.filter(
    (b) => b.type === "example" && !!b.fields && b.fields.length > 0
  ).length;

  return requestedRowCount !== undefined
    ? structuredEntityCount >= requestedRowCount
    : structuredEntityCount > 0;

}

// =========================
// buildBlocksForMutationKind (Phase76、Phase77 Section1でTable/Chartの
// 「作れない場合は拒否する」挙動へ修正)
// =========================
//
// Section7「Mutationを追記から編集へ」: kindごとにArtifactの
// blocks全体をどう変化させるかを決める。Table/Chartのみ「既存の
// 特定Blockを更新する」経路を持つ(Section7の例そのまま:
// 「この表にさらに2件追加して」→既存Table Blockを更新、「このデータを
// グラフにして」→既存Table Blockから導出)。それ以外のkindは常に
// 新しいBlockを末尾へ追加する(Section12絶対条件: 新しいBlockを
// 追加した際に既存Blockが消えるバグを避ける——upsertは対象のidの
// 要素だけを置き換え、他のBlockには一切触れない)。
//
// Repository Evidence(Phase77 Section1で確認したバグ): Phase76実装は
// Table/Chartの元データが無い場合、buildSimpleMutationBlock("generic", ...)
// でplan.answer(chat capabilityの生テキスト)をそのままText Block化
// して追記していた。これは「表にして」と頼んだのに実際にはTable
// Blockが1件も生成されない(Text Blockに化ける)、かつConversation
// 応答は「反映しました」のまま——ユーザーから見て何が起きたか分から
// ない(Phase77 Section1で報告された症状そのもの)という二重の問題を
// 生んでいた。
//
// 修正: 元データが無い場合はArtifactを一切変更せず(blocks: null)、
// 呼び出し元(applyArtifactMutation())がその旨を短く伝える
// (Section1「Mutationを拒否する」を採用。既存Research結果を最大限
// 再利用する方針は維持したまま、無い袖は振らない)。
//
// Chart固有の制約(Phase77 investigationで確認): ResearchEvidenceItem
// (core/tact-research/types.ts)にはconfidence("low"/"medium"/"high"、
// カテゴリ値)以外に数値フィールドが無く、buildTableFromBlocks()が
// Evidence/Exampleから作るTableの列(主張/出典/確信度、事例/詳細)にも
// 数値列は含まれない。そのため現在のデータモデルでは、実際のWeb
// Research結果からChartが作れる場面は基本的に存在しない
// (buildChartFromTable()が数値列を検出できた場合のみ成功する、
// 既存のPhase76ロジックは変更していない)。これは捏造を避けた結果の
// 正直な挙動であり、新しいLLM呼び出しで数値を捏造することはしない
// (Section1絶対条件)。
export interface MutationBuildOutcome {

  // nullの場合、Artifactは一切変更しない(Mutationの拒否)。
  blocks: ArtifactBlock[] | null;

  detail: Omit<MutationConfirmationDetail, "isNewArtifact">;

}

// =========================
// buildTableOutcomeForUserInput (Phase79、Phase80でkind="table"から
// 独立した共通部品へ)
// =========================
//
// Phase79 Section2・9: 「表にして」を、Evidence一覧(出典表)か
// Comparison Table(比較表)かにまず二次分類する。Root Cause
// (Phase79投資調査): 以前はこの分岐が無く、Table生成ロジック
// (buildTableFromBlocks())が固定columnsしか持たなかったため、
// ユーザーが比較軸を指定しても無視され、たまたま存在する
// Evidence Blockから「主張/出典/確信度」という出典表が作られていた。
//
// Phase80 Section2〜3: 「調査して、○件比較表にして」のようにResearch
// 要求と同一メッセージにTable要求がある場合、kind="research"の経路
// (buildResearchOutcomeWithOptionalTable())からも呼ぶ必要が生じた
// ため、kind="table"専用の処理として埋め込まれていたこの関数を
// 独立させた(Root Cause: Table構築ロジックをResearch経路のために
// 二重実装しない、Section11絶対条件)。呼び出し元のkindが"table"か
// "research"かに関わらず、渡されたblocks配列を土台にTable/Comparison
// Tableを構築する処理内容は完全に同一。
function buildTableOutcomeForUserInput(
  userInput: string,
  existingBlocks: ArtifactBlock[]
): MutationBuildOutcome {

  // Phase79 Section2・9: 「表にして」を、Evidence一覧(出典表)か
  // Comparison Table(比較表)かにまず二次分類する。
  const tablePurpose = classifyTablePurpose(userInput);

  if (tablePurpose === "comparison") {

    // 既存のComparison Table(tablePurpose==="comparison")のみを
    // 更新対象とする。Evidence Table(tablePurpose!=="comparison")
    // とは明確に区別し、混同しない(Section2絶対条件)。
    const existingComparisonTable = existingBlocks.find(
      (b): b is TableBlock => b.type === "table" && b.tablePurpose === "comparison"
    );

    // ユーザーがこのTurnで列を明示していればそれを優先し
    // (Section4絶対条件)、明示が無ければ既存Comparison Tableの
    // 列構成を引き継ぐ(初回作成時のみ、fieldsラベルの和集合へ
    // フォールバック、buildComparisonTableFromBlocks()内部)。
    const requestedColumns =
      parseComparisonColumns(userInput) ?? existingComparisonTable?.columns;

    const requestedRowCount = parseRequestedRowCount(userInput);

    const built = buildComparisonTableFromBlocks(
      existingBlocks,
      requestedColumns,
      existingComparisonTable ? existingComparisonTable.order : nextOrder(existingBlocks),
      deriveArtifactTitle(userInput)
    );

    if (existingComparisonTable) {

      // 既存Comparison Tableの更新は、Row Entityが実際に増えた
      // 場合のみ行う(Section7絶対条件: 架空のRowで要求件数を
      // 埋めない)。増えていなければ、Evidence Table側へは
      // フォールバックせず素直に拒否する(既にComparison Table
      // として運用中のTableを、性質の異なるEvidence一覧へ暗黙に
      // 差し替えない)。
      if (!built || built.rows.length <= existingComparisonTable.rows.length) {

        return {
          blocks: null,
          detail: {
            tableStatus: "insufficient_data",
            tablePurpose: "comparison",
            tableRowCount: existingComparisonTable.rows.length,
            tableRequestedRowCount: requestedRowCount,
          },
        };

      }

      // id/order/createdAtを維持したまま中身だけを差し替える
      // (Phase76〜78のappendRowsToTable()と同じ設計方針)。
      const mergedTable: TableBlock = {
        ...built,
        id: existingComparisonTable.id,
        order: existingComparisonTable.order,
        createdAt: existingComparisonTable.createdAt,
      };

      return {
        blocks: existingBlocks.map((b) => (b.id === existingComparisonTable.id ? mergedTable : b)),
        detail: {
          tableStatus: "updated",
          tablePurpose: "comparison",
          tableRowCount: mergedTable.rows.length,
          tableRequestedRowCount: requestedRowCount,
        },
      };

    }

    if (built) {

      return {
        blocks: [...existingBlocks, built],
        detail: {
          tableStatus: "created",
          tablePurpose: "comparison",
          tableRowCount: built.rows.length,
          tableRequestedRowCount: requestedRowCount,
        },
      };

    }

    // Row Entity(fields付きExampleBlock)が1件も無く、新規
    // Comparison Tableを作れなかった場合。
    //
    // Phase82-A(Repository Evidence: Phase81投資調査): 以前はここで
    // 「Example/Evidenceが1件でもあれば下のEvidence Table経路へ
    // returnせずフォールスルーする」という分岐があり、比較表として
    // 成立しないデータ(出典一覧・非構造化の事例)がEvidence Table
    // (「事例|詳細」等)として静かに生成され、tablePurposeも
    // "evidence"へすり替わっていた——ユーザーがcomparisonを要求した
    // という事実そのものが応答から失われる不具合(Phase81 Root
    // Cause 1)。
    //
    // 修正: comparisonリクエストでRow Entityが確保できない場合は、
    // 手元にExample/Evidenceがあるかどうかに関わらず、必ず
    // tablePurpose="comparison"のままinsufficient_dataとして拒否する
    // (Evidence Table経路へは絶対にフォールバックしない、Phase82絶対
    // 条件2)。Evidence Table自体(「根拠を表にして」等、tablePurpose
    // ==="evidence"のリクエスト)は、下のEvidence Table経路がこの分岐
    // を経由せずそのまま処理するため、既存挙動を維持する。
    return {
      blocks: null,
      detail: {
        tableStatus: "insufficient_data",
        tablePurpose: "comparison",
        tableRowCount: 0,
        tableRequestedRowCount: requestedRowCount,
      },
    };

  }

  // ↓ Evidence Table経路(Phase76〜78から変更なし)。Comparison
  // Tableは対象外にする(tablePurpose==="comparison"のTableへ
  // Evidence行を誤って追記しない、Section2絶対条件)。
  const existingTable = existingBlocks.find(
    (b): b is TableBlock => b.type === "table" && b.tablePurpose !== "comparison"
  );

  if (existingTable) {

    const updated = appendRowsToTable(existingTable, existingBlocks);

    if (updated.rows.length === existingTable.rows.length) {

      // 追記できる新しい事例・根拠が無かった(no-op)。Artifactを
      // 変更しない(無意味なversion incrementを避ける、Section12
      // 絶対条件の精神)。
      return { blocks: null, detail: { tableStatus: "insufficient_data", tablePurpose: "evidence" } };

    }

    return {
      blocks: existingBlocks.map((b) => (b.id === existingTable.id ? updated : b)),
      detail: { tableStatus: "updated", tablePurpose: "evidence" },
    };

  }

  const built = buildTableFromBlocks(
    existingBlocks,
    nextOrder(existingBlocks),
    deriveArtifactTitle(userInput)
  );

  if (!built) {
    return { blocks: null, detail: { tableStatus: "insufficient_data", tablePurpose: "evidence" } };
  }

  return {
    blocks: [...existingBlocks, built],
    detail: { tableStatus: "created", tablePurpose: "evidence" },
  };

}

// Phase20の既存方針(isTemporaryFailure()等)と同じ理由でexportする:
// Evaluation Harness(tests/tact/*)がTable/Chartの「拒否」判定
// (Phase77 Section1)を、実装を複製せずに直接検証できるようにする。
export function buildBlocksForMutationKind(
  kind: ArtifactMutationKind,
  userInput: string,
  plan: Extract<ConversationOrchestrationPlan, { kind: "normal" }>,
  existingBlocks: ArtifactBlock[]
): MutationBuildOutcome {

  if (kind === "research") {

    const blocks = buildResearchMutationBlocks(
      userInput,
      plan.answer,
      plan.keyFindings,
      plan.evidence,
      existingBlocks
    );

    // buildResearchMutationBlocks()の実装と同じ規則(keyFindingsが
    // 0件ならanswer全体を1件のFindingとして採用)で件数を数える——
    // 新しいロジックを重複実装せず、実際にBlockが生成された数だけを
    // 報告する(捏造防止)。
    const findingCount =
      plan.keyFindings.length > 0
        ? plan.keyFindings.length
        : plan.answer.trim()
          ? 1
          : 0;

    return {
      blocks,
      detail: { findingCount, evidenceCount: plan.evidence.length },
    };

  }

  if (kind === "table") {
    return buildTableOutcomeForUserInput(userInput, existingBlocks);
  }

  if (kind === "chart") {

    const sourceTable = existingBlocks.find((b): b is TableBlock => b.type === "table");

    const built = sourceTable
      ? buildChartFromTable(sourceTable, nextOrder(existingBlocks), deriveArtifactTitle(userInput))
      : null;

    if (!built) {
      return { blocks: null, detail: { chartStatus: "insufficient_data" } };
    }

    const existingChart = existingBlocks.find((b) => b.type === "chart");

    return {
      blocks: existingChart
        ? existingBlocks.map((b) => (b.id === existingChart.id ? built : b))
        : [...existingBlocks, built],
      detail: { chartStatus: existingChart ? "updated" : "created" },
    };

  }

  if (kind === "example") {

    // Phase79 Section5: chat回答が実際に複数Entityを列挙した構造
    // (Markdown Table/番号付きリスト)であればRow Entityごとに個別の
    // ExampleBlock(fields付き)へ分解する。構造化できない場合は
    // 既存Phase76〜78の挙動(buildSimpleMutationBlock、1件の
    // ExampleBlock)にそのままフォールバックする
    // (buildExampleMutationBlocks()内部で判定)。
    return {
      blocks: buildExampleMutationBlocks(userInput, plan.answer, existingBlocks),
      detail: {},
    };

  }

  return {
    blocks: buildSimpleMutationBlock(kind, userInput, plan.answer, existingBlocks),
    detail: {},
  };

}

// =========================
// buildResearchOutcomeWithOptionalTable (Phase80 Section2〜4)
// =========================
//
// Root Cause(Phase79 DB実データ調査で確認): classifyArtifactMutation()は
// capability==="research"を最優先するため、「○○について調査して、
// イベント名・地域・対象者で比較表にして」のようにResearch要求と
// Comparison Table要求が同一メッセージに含まれる場合、kind="research"
// のまま確定し、buildBlocksForMutationKind()のresearch分岐
// (ResearchSummary/Finding/Evidenceの生成のみ)で処理が終了していた。
// LLMがResearch回答内に正しいMarkdown比較表を生成していても、
// Table Blockへ一切変換されず、生Markdown文字列がResearchSummary
// Blockのcontentに残るだけだった(Phase79投資調査で実際のDBデータ
// から確認)。
//
// 修正方針(Section3「ResearchとTableを排他的なMutation Kindとして
// 扱わないこと」): classifyArtifactMutation()自体は変更しない
// (既存分類を壊さない、Section2絶対条件)。代わりに、kind="research"
// と確定した後、hasTableIntent()/hasChartIntent()(Phase79で確立した
// classifyArtifactMutation()の判定ロジックを独立公開したもの)で
// 「Table/Chart要求が併存していないか」を追加でチェックし、していれば
// Research実行結果を土台にTable/Chart構築フェーズへ継続する。
//
// 絶対条件(Section11): 新しいLLM呼び出し種別を追加しない・Research
// Pipelineを二重実装しない・Table構築ロジックを二重実装しない。
//   - Research回答自体の構造化にはparseStructuredEntitiesFromText()
//     (Phase79)をそのまま再利用する(appendRowEntitiesFromText()経由)。
//   - Table/Chart構築にはbuildTableOutcomeForUserInput()/
//     buildChartFromTable()(Phase79)をそのまま再利用する。
//   - 要求件数に届かない場合の追加Researchは、Phase78で確立した
//     runSupplementalResearchForArtifact()/mergeSupplementalRowEntities()
//     をそのまま再利用する(既存Table kindの経路と全く同じ関数、新規
//     Research呼び出し経路を増やさない)。
//
// buildBlocksForMutationKind()自体は同期関数のまま維持する(既存の
// 呼び出し契約・Evaluation Harnessでの直接テストを壊さない)。Table/
// Chart要求が無い通常のResearch(Test A)は、この関数もbuildBlocksForMutationKind()
// をそのまま呼ぶだけで追加コストが一切発生しない。
export async function buildResearchOutcomeWithOptionalTable(
  userId: string | undefined,
  userInput: string,
  plan: Extract<ConversationOrchestrationPlan, { kind: "normal" }>,
  existingBlocks: ArtifactBlock[]
): Promise<MutationBuildOutcome> {

  const baseOutcome = buildBlocksForMutationKind("research", userInput, plan, existingBlocks);

  // "research" kindのbuildBlocksForMutationKind()は常に非nullの
  // blocksを返す(buildResearchMutationBlocks()が必ず何らかのBlockを
  // 生成するため)。念のため安全側でexistingBlocksへフォールバックする。
  let workingBlocks = baseOutcome.blocks ?? existingBlocks;
  const detail: MutationBuildOutcome["detail"] = { ...baseOutcome.detail };

  const wantsTable = hasTableIntent(userInput);
  const wantsChart = hasChartIntent(userInput);

  // Test A「Researchのみ」: Table/Chart要求が無ければ、Research結果を
  // そのまま返す(既存Phase76〜79の挙動を完全に維持、追加コストなし)。
  // Phase82-D(Repository Evidence: Phase81投資調査): Row Entity化
  // (parseStructuredEntitiesFromText経由)は、このTurn自体がTableも
  // 要求しているかどうかに関わらず常に試みる。新しいLLM呼び出しは
  // 発生しない(plan.answerという既に取得済みのテキストを決定論的に
  // 構造化するだけ)。
  //
  // Root Cause(Phase81): 以前はこの処理がwantsTableのブロック内に
  // あり、「調査して」単体のTurn(Table要求を伴わない)では一切
  // 実行されなかった。そのため「Turn1で調査→Turn2で具体例を追加→
  // Turn3で比較表にして」という複数Turnに分けた自然な使い方では、
  // Turn2で得たRow EntityがArtifactへ一切蓄積されず、Turn3の
  // buildComparisonTableFromBlocks()が常に0件からの構築になっていた。
  // ここを常時実行にすることで、後続Turnが比較表化する際の材料として
  // 機会的に活用できる(Table/Chartの実際の構築・追加Researchの要否
  // 判定は引き続きwantsTable/wantsChartで厳密にgateする、コスト増加は
  // 発生しない)。
  const evidenceIds = plan.evidence.map((item) => item.id);

  // Phase83: plan.evidence(このTurnで実際に取得したEvidence本文)を
  // Evidence Groundingの照合対象として渡す。Research LLMのanswerに
  // 実在する固有名詞だけが登場していても、それがEvidence本文に存在
  // しなければRow Entity化しない(Rule4)。
  workingBlocks = appendRowEntitiesFromText(workingBlocks, plan.answer, evidenceIds, plan.evidence);

  // Canonical Cortex ownership: a plan (including an intentionally empty one)
  // suppresses compatibility projection adapters, so each output is inserted once.
  if (plan.cortexArtifactPlanRequested) {
    return {
      blocks: plan.analysisArtifactPlans?.reduce((blocks, artifactPlan) => mergeAnalysisArtifactPlanBlocks(blocks, artifactPlan), workingBlocks) ?? workingBlocks,
      detail,
    };
  }

  // Cortex Presentation is already validated and selected from a Dataset.
  // Do not route it through the legacy answer-text table/chart inference, and
  // never substitute a different chart for an invalid explicit request.
  if (plan.frameworkArtifactRequested) {
    return {
      blocks: mergeResearchFrameworkBlocks(workingBlocks, plan.frameworkArtifacts ?? []),
      detail,
    };
  }

  if (plan.presentationRequested) {
    return {
      blocks: mergeResearchPresentationBlocks(workingBlocks, plan.presentations ?? []),
      detail,
    };
  }

  if (!wantsTable && !wantsChart) {
    return { blocks: workingBlocks, detail };
  }

  if (wantsTable) {

    const tablePurpose = classifyTablePurpose(userInput);
    const requestedRowCount = parseRequestedRowCount(userInput);

    // Section6: 要求件数に届かない場合のみ、Phase78の仕組みを再利用
    // して1回だけ追加Researchを行う(Evidence Table意図の場合は対象
    // 外——Phase78の既存Table kind経路と同じ判断基準、コスト抑制
    // Section11)。
    if (
      tablePurpose === "comparison" &&
      !hasEnoughRowEntities(workingBlocks, requestedRowCount)
    ) {

      const supplemental = await runSupplementalResearchForArtifact(userId, userInput);

      workingBlocks = mergeSupplementalRowEntities(workingBlocks, supplemental);

    }

    const tableOutcome = buildTableOutcomeForUserInput(userInput, workingBlocks);

    // Table構築が拒否された場合(insufficient_data)でも、既に確定
    // しているResearch結果(Finding/Evidence)は失わない——Table部分の
    // 失敗だけをdetailへ反映する(Section7: Researchは成功している
    // ため、Mutation全体を拒否してはいけない)。
    if (tableOutcome.blocks) {
      workingBlocks = tableOutcome.blocks;
    }

    Object.assign(detail, tableOutcome.detail);

  }

  if (wantsChart) {

    const sourceTable = workingBlocks.find((b): b is TableBlock => b.type === "table");

    const chartBuilt = sourceTable
      ? buildChartFromTable(sourceTable, nextOrder(workingBlocks), deriveArtifactTitle(userInput))
      : null;

    if (chartBuilt) {

      const existingChart = workingBlocks.find((b) => b.type === "chart");

      workingBlocks = existingChart
        ? workingBlocks.map((b) => (b.id === existingChart.id ? chartBuilt : b))
        : [...workingBlocks, chartBuilt];

      detail.chartStatus = existingChart ? "updated" : "created";

    } else {

      // Section16絶対条件・Phase77 Section1: 数値データが無ければ
      // 架空のChartを作らない。Research結果は保持したまま、Chart
      // 部分だけ「見送り」を報告する。
      detail.chartStatus = "insufficient_data";

    }

  }

  return { blocks: workingBlocks, detail };

}

// =========================
// applyArtifactMutation (Phase75、Phase76でBlock構築に対応)
// =========================
//
// Phase75 Section3の設計図(Artifact Mutation Required? → Yes →
// Artifact Mutation → Persist Artifact → Short Conversation Response /
// No → Conversation Response)を、通常完了(plan.kind==="normal")の
// turnに対して適用する。Clarification短絡時はそもそも呼ばれない
// (Invariant3と同じ理由: Artifactの更新もExecutionと同様、実際に
// Taskが実行された場合のみ意味を持つ)。
//
// 絶対条件(Section7〜9): Research詳細本文・Evidence・Findingは
// Artifact側(buildResearchMutationBlocks())へ渡し、Conversation側の
// Assistant Messageには簡潔な確認文(buildArtifactMutationConfirmation())
// のみを返す——ただしMutation対象でない場合(Case A/B)はこれまで通り
// plan.answerをそのまま返す(既存のPhase67〜69の挙動を維持)。
//
// 絶対条件(Section9・Section12): 既存Artifactが見つかった場合は
// buildBlocksForMutationKind()が既存blocks配列を土台に新規/更新Block
// だけを反映し、他のBlockには一切触れない。conversation.artifactIdが
// 指す行が何らかの理由で見つからない場合(削除済み等のデータ不整合)は、
// 新規Artifactを作る安全側のfallbackとする(推測で復元しない、これまでの
// Phase55/68のgetPendingClarification()等と同じ防御的方針)。

async function applyArtifactMutation(
  conversation: Conversation,
  accessToken: string,
  userInput: string,
  plan: Extract<ConversationOrchestrationPlan, { kind: "normal" }>
): Promise<string> {

  // 失敗したExecutionの結果でArtifactを汚染しない(Section7の趣旨:
  // Artifactは「成果物」であり、失敗説明文はConversation側の通常応答
  // としてそのまま見せる方が正しい、Phase67の既存failure semanticsを
  // 維持)。
  if (plan.status === "failed") {
    return plan.answer;
  }

  const kind = classifyArtifactMutation(userInput, plan.capability);

  if (kind === null) {

    // Phase77 Section5: Mutation対象外(Case A/B)でも、既存Artifactを
    // 参照すべき質問(「今の調査で一番重要なのは?」等)であれば、
    // Orchestrator/chat handlerが生成した一般論(plan.answer、
    // Artifactを一切知らないChat Handlerの出力)ではなく、現在の
    // Artifact本文から決定論的に組み立てた回答を返す。新しいLLM
    // 呼び出しは発生しない(Artifact読み取りのみ)。Artifactへの
    // 書き込みは一切行わない(絶対条件: Artifact自体を変更する
    // 必要がない質問ならMutationを発生させない)。
    if (conversation.artifactId && isArtifactReferenceQuestion(userInput)) {

      const currentArtifact = await getArtifact(
        conversation.artifactId,
        conversation.userId,
        accessToken
      );

      const referenceAnswer = currentArtifact
        ? buildArtifactReferenceAnswer(currentArtifact)
        : null;

      if (referenceAnswer) {
        return referenceAnswer;
      }

    }

    return plan.answer;

  }

  const existingArtifact = conversation.artifactId
    ? await getArtifact(conversation.artifactId, conversation.userId, accessToken)
    : undefined;

  const existingBlocks = existingArtifact?.blocks ?? [];

  // Phase80 Section2〜3: kind==="research"の場合、Research自体は既に
  // 実行済み(plan.answer/plan.evidence/plan.keyFindingsとして取得
  // 済み)であるため、Table kindの「事前に追加Researchが必要か判定
  // してから構築する」という順序ではなく、buildResearchOutcomeWithOptionalTable()
  // 内部で「Research結果をまず構築→Table要求があれば構造化→なお
  // 不足すれば追加Research」という順序で処理する(Section3のフロー
  // 通り、Researchは既に完了しているため事前判定は不要)。
  let outcome: MutationBuildOutcome;

  if (kind === "research") {

    outcome = await buildResearchOutcomeWithOptionalTable(
      conversation.userId,
      userInput,
      plan,
      existingBlocks
    );

  } else {

    // Phase78 Tier1(Section2〜3): 「表にして」「グラフにして」で
    // 既存Artifact内に十分なデータが無い場合、Table/Chartを組み立てる
    // 前に1回だけ追加Researchを行い、取得したEvidenceを取り込む。
    // 既存Table更新(appendRowsToTable)・十分なデータが既にある場合は
    // 対象外(needsSupplementalResearchForArtifact()、コスト抑制、
    // Section13)。
    // Phase79 Section8: kind==="table"の場合、Comparison(比較表)か
    // Evidence(出典表)かで「不足」の判定基準・補足Researchの取り込み方
    // が異なる(needsSupplementalResearchForArtifact()・
    // mergeSupplementalRowEntities()参照)。
    const tablePurpose = kind === "table" ? classifyTablePurpose(userInput) : undefined;
    const requestedRowCount = kind === "table" ? parseRequestedRowCount(userInput) : undefined;

    const needsResearch = needsSupplementalResearchForArtifact(kind, existingBlocks, {
      tablePurpose,
      requestedRowCount,
    });

    // Phase88: 既存Artifact.title(最初のTurnで既に確立済みの主題、
    // 例:「愛知県内の大学生向けスポーツイベント」)を補足Researchの
    // クエリへ渡す。userInput自身(例:Turn3の「ここまで調べた内容を
    // 比較表にしてください」)だけでは主題を失うケースの対策
    // (Phase87投資調査、Section4)。
    const existingTopic = existingArtifact?.title;

    // Phase90: Turn3のような「ここまで調べた内容を比較表にして」
    // という補足Researchにも、事前確定済みの列構成・要求件数を渡す
    // (buildResearchTableSchema()はcomparison purpose以外では
    // undefinedを返すため、evidence branchでは自然に無効化される)。
    const tableSchema = buildResearchTableSchema(userInput);

    const workingBlocks = needsResearch
      ? tablePurpose === "comparison"
        ? mergeSupplementalRowEntities(
            existingBlocks,
            await runSupplementalResearchForArtifact(conversation.userId, userInput, existingTopic, tableSchema)
          )
        : mergeSupplementalEvidence(
            existingBlocks,
            (await runSupplementalResearchForArtifact(conversation.userId, userInput, existingTopic)).evidence
          )
      : existingBlocks;

    outcome = buildBlocksForMutationKind(kind, userInput, plan, workingBlocks);

  }

  // Phase77 Section1: Table/Chartの元データが無い(または追記できる
  // 新規データが無い)場合、Artifactは一切変更せず、その旨だけを
  // 短く伝える(Mutationの拒否)。
  if (outcome.blocks === null) {

    return buildMutationConfirmation(kind, userInput, {
      isNewArtifact: !existingArtifact,
      ...outcome.detail,
    });

  }

  if (existingArtifact) {

    await updateArtifactBlocks(existingArtifact, accessToken, outcome.blocks);

    return buildMutationConfirmation(kind, userInput, {
      isNewArtifact: false,
      ...outcome.detail,
    });

  }

  const newArtifact = await createArtifact(
    conversation.userId,
    accessToken,
    deriveArtifactTitle(userInput),
    outcome.blocks,
    conversation.projectId
  );

  await linkConversationArtifact(conversation, accessToken, newArtifact.id);

  return buildMutationConfirmation(kind, userInput, {
    isNewArtifact: true,
    ...outcome.detail,
  });

}

// This instruction is internal-only. The original empty user content remains the
// persisted conversation message; this value is used solely to route an
// attachment-only turn through Research with its resolved user-file Evidence.
export const ATTACHMENT_ONLY_RESEARCH_INSTRUCTION =
  "添付資料を調査して、根拠に基づく要点を報告してください。";

export function getAttachmentOnlyOrchestrationInput(
  userInput: string,
  hasAttachments: boolean
): string {
  const trimmed = userInput.trim();
  return (trimmed || hasAttachments)
    ? trimmed || ATTACHMENT_ONLY_RESEARCH_INSTRUCTION
    : "";
}

async function runNormalTurn(
  conversation: Conversation,
  accessToken: string,
  userInput: string,
  attachmentIds: string[] = [],
  attachmentEvidence: AttachmentEvidence[] = [],
  workspaceEvidence: LocalWorkspaceEvidence[] = []
): Promise<ConversationTurnResult> {

  const userMessage = attachmentIds.length > 0
    ? await appendConversationMessageWithAttachments(conversation, accessToken, userInput, attachmentIds)
    : await appendConversationMessage(conversation, accessToken, "user", userInput);

  const orchestrationInput = getAttachmentOnlyOrchestrationInput(
    userInput,
    attachmentIds.length > 0
  );

  // 定型の挨拶・お礼はローカル応答に確定するため、Orchestrator/Core取得/
  // Research/LLM/Artifact Mutationを実行しない。会話履歴は通常どおり保存する。
  const simpleChatResponse = getSimpleChatResponse(orchestrationInput);

  if (simpleChatResponse) {
    const message = await appendConversationMessage(
      conversation,
      accessToken,
      "assistant",
      simpleChatResponse
    );

    return { conversation, userMessage, message };
  }

  // Phase86: Intent Router(classifyIntent())が「直前Turnの延長として
  // 追加調査を求めているか」を判定できるよう、直前のuser発言を渡す。
  // 新しいMemory/Context Architectureは作らない——既存の
  // getConversationMessages()/findPrecedingUserInput()(Phase68で
  // Clarification再実行のために確立済み)をそのまま再利用するだけ。
  // 履歴取得に失敗しても(初回Turn等)previousUserInputはundefinedの
  // ままとなり、既存(Phase1〜85)と同じ挙動にフォールバックする。
  const history = await getConversationMessages(conversation.id, accessToken);
  const previousUserInput = findPrecedingUserInput(history, userMessage.id) ?? undefined;

  // Phase90(Structured Research Dataset Section4〜6): Table要求を
  // Research実行前に検知できた場合、列構成・要求件数をRequest経由で
  // Research Promptへ注入する(buildResearchTableSchema()、既存の
  // hasTableIntent()/classifyTablePurpose()/parseComparisonColumns()/
  // parseRequestedRowCount()の合成のみ、新しいParserは追加しない)。
  // 取得できない場合(比較軸が明示されていない等)はundefinedのまま、
  // 既存(Phase1〜89)のResearch後Row Entity化の挙動へフォールバックする。
  const tableSchema = buildResearchTableSchema(orchestrationInput);

  const result = await runOrchestration({
    userId: conversation.userId,
    input: orchestrationInput,
    previousUserInput,
    tableSchema,
    attachmentEvidence,
    workspaceEvidence,
  });

  const plan = planConversationTurn(result);

  if (plan.kind === "clarification") {

    const message = await recordClarificationQuestion(
      conversation,
      accessToken,
      plan.question
    );

    return { conversation, userMessage, message };

  }

  const executionRecord = await recordExecution(
    conversation,
    accessToken,
    plan.capability,
    orchestrationInput,
    plan.status,
    plan.executionId
  );

  const assistantContent = await applyArtifactMutation(
    conversation,
    accessToken,
    orchestrationInput,
    plan
  );

  const message = await appendConversationMessage(
    conversation,
    accessToken,
    "assistant",
    assistantContent,
    executionRecord.id
  );

  return { conversation, userMessage, message, executionRecord };

}

// =========================
// runClarificationAnswerTurn (Phase68)
// =========================
//
// Phase68 Section6の責務契約通り:
//   1. User Answer Messageを保存(recordClarificationAnswer()、
//      Phase68で修正済み——answered_atをこの時点では設定しない)
//   2. 元のClarification Question + 会話履歴から復元した元入力 +
//      今回の回答を結合し、Orchestratorを再実行
//   3. 結果を判定(planConversationTurn()、runNormalTurnと共通)
//   4. 通常完了(completed/partial)ならExecutionRecord・Assistant
//      Messageを保存し、pendingをclear(pending_clarification_message_id
//      =null、pending_clarification_answered_at=今回の成功時刻)
//   5. 全滅(failed)ならExecutionRecord(status=failed)・Assistant
//      Messageは保存するが、pendingは一切変更しない(Decision F、
//      Phase68 Section7——「回答は受け取ったが再実行に失敗した」状態を
//      失わない)
//   6. 再実行してもなお曖昧(Orchestratorが再びclarificationを返した)
//      場合は、新しいClarification Questionとして
//      recordClarificationQuestion()を呼ぶ(pending_clarification_message_id
//      が新しいQuestionのidへ差し替わる——古いQuestionは履歴として
//      残ったまま、新しい質問に対する回答を待つ状態になる。新しい
//      state columnを追加せずに既存の2フィールドだけで多段階の
//      Clarification往復を表現できる、Phase68 Section8の要求)
//
// 「成功」の判定基準(status !== "failed"、つまりcompleted/partial両方を
// 成功として扱いpendingをclearする): Phase68 Section7が
// ExecutionRecord.status="failed"の場合のみを明示的に「Failure
// behavior」として説明しており、Clarificationの目的(曖昧性の解消)は
// partial(一部Task失敗)であってもOrchestratorが実際にTaskへ着手できた
// 時点で既に達成されているため、再度同じ質問を繰り返すことは正しくない
// という判断による(Repository Evidenceに基づく解釈、完了報告に明記)。

async function runClarificationAnswerTurn(
  conversation: Conversation,
  accessToken: string,
  answerInput: string,
  pending: PendingClarification
): Promise<ConversationTurnResult> {

  const userMessage = await recordClarificationAnswer(
    conversation,
    accessToken,
    answerInput
  );

  // Orchestratorはstatelessなため(conversationIdを受け取らない、
  // Repository Evidence)、元の曖昧な入力を会話履歴から復元し、1本の
  // input文字列として渡す。復元できない場合もSection4の方針通り
  // 安全側(question+answerのみ)へフォールバックし、再実行自体は継続する。
  const history = await getConversationMessages(conversation.id, accessToken);
  const originalInput = findPrecedingUserInput(history, pending.messageId);

  const resendInput = buildClarificationResendInput(
    originalInput,
    pending.question,
    answerInput
  );

  const result = await runOrchestration({
    userId: conversation.userId,
    input: resendInput,
  });

  const plan = planConversationTurn(result);

  if (plan.kind === "clarification") {

    // 再実行してもなお曖昧だった場合。新しいClarification Questionとして
    // 扱う(ExecutionRecordは作らない、Invariant3)。
    const message = await recordClarificationQuestion(
      conversation,
      accessToken,
      plan.question
    );

    return { conversation, userMessage, message };

  }

  const executionRecord = await recordExecution(
    conversation,
    accessToken,
    plan.capability,
    resendInput,
    plan.status,
    plan.executionId
  );

  // Phase75: 検出用input・Artifactセクションの話題導出には、素の
  // answerInputではなくresendInput(元入力+質問+回答を結合済み)を使う。
  // buildClarificationResendInput()の結合形式上、answerInputは常に
  // resendInputの部分文字列として含まれるため、detectArtifactMutationIntent()
  // の判定漏れは起きない(Section4のキーワードがanswerInput側にあっても
  // resendInput全体に対するincludes()で検出できる)。
  const assistantContent = await applyArtifactMutation(
    conversation,
    accessToken,
    resendInput,
    plan
  );

  const message = await appendConversationMessage(
    conversation,
    accessToken,
    "assistant",
    assistantContent,
    executionRecord.id
  );

  // Decision F(Phase63/68): 全滅(failed)の場合はpendingを一切変更しない。
  // completed/partialの場合のみ、pendingをclearし、成功時刻を
  // pending_clarification_answered_atへ記録する。
  if (plan.status !== "failed") {
    await clearPendingClarification(conversation, accessToken, new Date().toISOString());
  }

  return { conversation, userMessage, message, executionRecord };

}
