import { runOrchestration } from "../tact-orchestrator";
import type { OrchestrationResult, OrchestrationRequest, TaskExecutionSummary } from "../tact-orchestrator";
import { getSimpleChatResponse } from "../tact-intent/ruleRouter";
// Architecture Migration Phase B2: Canonical Work Model。Interfaceが
// 何であってもConversationを経由すれば同じWork Intake/Work Execution
// Boundaryへ到達する(ARCH-R2 Section11)。core/tact-orchestratorは
// この存在を一切知らない(依存方向はcore/tact-conversation →
// core/tact-work → core/tact-orchestratorの一方向、core/tact-work/
// index.tsのコメント参照)。
import {
  resolveWork,
  runWorkTurn,
  defaultRunWorkTurnDeps,
  getApproval,
  listApprovalsForWork,
  listTasksForWork,
  // Fast Port P6a: Task Resume Foundation。
  evaluateTaskResumeEligibility,
} from "../tact-work";
import type {
  WorkIntakeSource,
  ActorReference,
  ResolveIntegrationConnection,
  ExecuteReadIntegrationAction,
  ExecuteReadIntegrationActionOutcome,
  Approval,
  // Fast Port P6a: Task Resume Foundation。
  TaskResumeIntent,
  TaskResumeEligibilityBlockedReasonCode,
  TaskResumeTerminalReasonCode,
} from "../tact-work";
import {
  listConnectionsForUser,
  executeReadIntegrationAction,
  dispatchIntegrationReadToRuntime,
  isRuntimeEligibleIntegrationAction,
  // Fast Port P6b: Canonical Resume Execution。
  executeApprovedIntegrationAction,
  evaluatePolicyDecision,
} from "../tact-integration";
import type { IntegrationService, IntegrationActionExecutionOutcome } from "../tact-integration";
// Fast Port P5c: Trigger.dev routingの有効性(feature flag + config)を
// 決定する唯一のchokepoint。このimport経由でのみ@trigger.dev/sdkへの
// 依存がこのfileへ間接的に伝播する(orchestration.tsはwiring層のため
// 許容——core/tact-work・core/tact-integration自体はSDKを一切知らない)。
import { resolveRuntimeIntegrationReadAdapter } from "../tact-runtime/enablement";

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
  linkConversationWork,
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
import type { ConversationEvidence } from "./conversationEvidence";
import { formatConversationEvidenceAcknowledgement } from "./conversationEvidence";
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
// resolvePendingApproval (Architecture Migration Phase C2.1c-b)
// =========================
//
// OrchestrationResult.pendingApproval(最小限のprimitive shapeのみ、
// tact-orchestratorがApproval型を持たない一方向依存を維持するため)
// から、core/tact-bot/connector/conversationConnector.tsが既存の
// toBotRequestApprovalAction()をそのまま呼べるよう、完全なApproval
// Entityを取得し直す。conversation.workId(resolveAndRunWork()が
// 直前で解決/repair済みの値、同じ参照をmutateしているためこの時点で
// 反映済み)とWork所有者(conversation.userId)によるownership確認は
// 既存getApproval()自体が行う(絶対条件: 新しいownership検証を
// 増やさない)。取得できない場合(理論上到達しないはずだが防御的に)は
// undefinedのまま返し、通常のTurn応答自体は失敗させない。
async function resolvePendingApproval(
  result: OrchestrationResult,
  conversation: Conversation,
  accessToken: string
): Promise<Approval | undefined> {

  if (!result.pendingApproval || !conversation.workId) {
    return undefined;
  }

  return getApproval(
    conversation.workId,
    conversation.userId,
    accessToken,
    result.pendingApproval.approvalId
  );

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

  // Architecture Migration Phase C2.1c-b: このTurnで新規に作られた
  // Approval(canonical Entity、core/tact-work/types.ts)。設定される
  // のはOrchestrationResult.pendingApprovalが返った場合のみ
  // (core/tact-work/execution.tsのrunWorkTurn()参照)。core/tact-bot/
  // connector/conversationConnector.tsが、既存のtoBotRequestApprovalAction()
  // (core/tact-bot/approval.ts)をそのまま呼ぶために、projection化
  // されていない完全なApproval Entityをここで保持する
  // (tact-orchestrator層はApproval型を持たない一方向依存のため、
  // approvalIdからこの層で再取得している、下記resolvePendingApproval()
  // 参照)。
  pendingApproval?: Approval;

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

// Architecture Migration Phase B2: sourceは省略可能(既定"web")。
// app/api/tact/tact-conversations/route.tsはこの引数を渡さずに
// 呼んでいる既存呼び出し元であり、既定値"web"により挙動は一切
// 変わらない。core/tact-bot/execution/trustedConversationTurn.tsの
// runConversationTurnAsTrustedActor()経由の場合のみ"bot"が渡る
// (core/tact-work/(Work Intake)がWork.metadata.sourceとして記録
// するだけの観測用タグであり、実行ロジックはsourceによって分岐
// しない)。
export async function runConversationOrchestration(
  conversation: Conversation,
  accessToken: string,
  userInput: string,
  attachmentIds: string[] = [],
  attachmentEvidence: AttachmentEvidence[] = [],
  // LW-P3: client-side Workspace Context Resolverが既にbound済みの
  // Local Workspace Evidence(app/api/tact/tact-conversations/route.ts
  // でのserver validation通過後の値)。
  workspaceEvidence: LocalWorkspaceEvidence[] = [],
  source: WorkIntakeSource = "web",
  conversationEvidence?: ConversationEvidence
): Promise<ConversationTurnResult> {

  const pending = await getPendingClarification(conversation, accessToken);

  if (pending) {
    return runClarificationAnswerTurn(conversation, accessToken, userInput, pending, source);
  }

  return runNormalTurn(conversation, accessToken, userInput, attachmentIds, attachmentEvidence, workspaceEvidence, source, conversationEvidence);

}

// =========================
// runConversationTurn — shared conversation turn logic (BOT-P2/BOT-P2.5)
// =========================
//
// app/api/tact/tact-conversations/route.tsのPOST handlerが持つ
// 「conversationIdがあれば所有権確認込みで取得・無ければ新規作成
// →runConversationOrchestration()→最新状態を再取得」という一連の
// 流れを、HTTP(NextRequest/NextResponse)から独立した共通関数として
// 抽出したもの。route.ts自体はこの関数を呼ぶよう変更していない
// (既存Web挙動に一切影響を与えない、絶対条件)。
//
// 「Botに独自のConversation管理を作らない」という方針を、
// この関数自体がroute.tsのロジックを複製せず1箇所に集約することで
// 支える。projectId/attachmentIds等、route.ts固有の付随的な入力は
// 意図的に含めない(BOT-P2時点でBotはこれらを使わないため。将来
// 必要になれば、この関数へoptional paramとして追加する)。
//
// BOT-P2.5(投資調査): この関数自体はaccessTokenが「本物のuser JWTか、
// それ以外のtrusted credentialか」を判断しない(token-agnostic、既存
// store.tsの設計と同じ)。BOT-P2時点ではcore/tact-bot/の
// Conversation ConnectorがこのToken-agnosticな性質を利用し、Bot用の
// service role keyを"accessToken"としてこの関数へ直接渡していたが、
// これは「service role keyをuser access tokenの代用品として扱う」
// ように見える設計であり、Web(本物のuser JWT)とBot(server-side
// trusted execution)の認証境界が曖昧になっていた(BOT-P2.5で修正)。
//
// この関数は「shared conversation turn logic」というレイヤーに
// 意図的に留め、代わりに以下の2つの明示的な境界関数を経由させる
// (このファイル内のrunConversationTurnAsAuthenticatedUser、および
// core/tact-bot/execution/trustedConversationTurn.tsの
// runConversationTurnAsTrustedActor)。この関数を直接呼ぶ新しい
// 呼び出し元を増やさないこと——必ずどちらかの境界関数を経由する。
export interface RunConversationTurnParams {

  userId: string;

  accessToken: string;

  content: string;

  // 省略時は新規Conversationを作成する。
  conversationId?: string;

  attachmentEvidence?: AttachmentEvidence[];

  workspaceEvidence?: LocalWorkspaceEvidence[];

  conversationEvidence?: ConversationEvidence;

  // Architecture Migration Phase B2: このTurnがどのInterfaceから
  // 来たか(core/tact-work/のWork Intakeが、新規Work作成時に
  // Work.metadata.sourceとして記録するだけの観測用タグ)。省略時は
  // "web"(既存のrunConversationTurnAsAuthenticatedUser()呼び出し元は
  // 全てこの既定値のままで挙動が変わらない)。
  source?: WorkIntakeSource;

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
    conversationEvidence,
    source = "web",
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
    workspaceEvidence,
    source,
    conversationEvidence
  );

  // route.tsと同じ理由: runConversationOrchestration()の各ステップは
  // Conversation.updated_at等を更新するが、turn自体は最新状態を
  // 返さないため、明示的に再取得する。
  const refreshedConversation =
    (await getConversation(conversation.id, userId, accessToken)) ?? turn.conversation;

  return { ok: true, ...turn, conversation: refreshedConversation };

}

// =========================
// runConversationTurnAsAuthenticatedUser — Web authenticated execution
// boundary (BOT-P2.5)
// =========================
//
// Web(app/api/tact/tact-conversations/route.ts等、将来この共通関数へ
// 移行する場合)が呼ぶ想定の、唯一のWeb向け境界。呼び出し元は
// accessTokenが「core/auth/getAuthenticatedUser.ts(Supabase
// auth.getUser())で検証済みの、まさにparams.userId本人のSupabase Auth
// JWTである」ことを保証してから呼び出すこと——このrelation自体は
// この関数の外側(呼び出し元)の責務であり、この関数自体は追加の
// 検証を行わない(既存のgetCurrentUserContext()の役割を重複させない)。
//
// 実装はrunConversationTurn()(shared conversation turn logic)を
// そのまま呼ぶだけであり、Web固有の追加ロジックは持たない
// (Web/Botで「どのCredentialを使うか」という境界の意味だけが違う)。
export async function runConversationTurnAsAuthenticatedUser(
  params: RunConversationTurnParams
): Promise<RunConversationTurnResult> {

  return runConversationTurn(params);

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

// Known Architecture Debt(Phase B2完了報告に記載、今回のFinal Fixの
// scope外): runSupplementalResearchForArtifact()内のrunOrchestration()
// 呼び出しは、runNormalTurn()/runClarificationAnswerTurn()と異なり
// core/tact-work/(Work Intake/Work Execution Boundary)を経由しない
// ため、Work/Task/Run Trackingの対象外のままになっている
// (Comparison Tableへの補助的な追加調査であり、既存Turnの主Work配下
// のCapability呼び出しとしては記録されない)。Audit/Costを全面的に
// Work Modelへ寄せる段階で、このLegacy的な直接呼び出しもWork
// Execution Boundary経由へ統合する対象として扱う。

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

  // Phase B2 Section13: Work経由で生成されたArtifactにはWork.idを
  // 付与する(既存Conversation.artifactIdによる紐付けは維持したまま
  // のtemporary dual linkage)。conversation.workIdが未設定の場合
  // (Phase B2導入前の既存Conversation、またはWork Intake未到達の
  // 経路)はnullのまま、既存挙動と完全に同じ。
  const newArtifact = await createArtifact(
    conversation.userId,
    accessToken,
    deriveArtifactTitle(userInput),
    outcome.blocks,
    conversation.projectId,
    conversation.workId
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

// =========================
// shouldRepairConversationWorkLink (Phase B2 Final Fix、純粋関数)
// =========================
//
// Conversation.workIdへの書き戻しが必要かどうかを、既存link
// (currentWorkId、無ければnull/undefined)と、resolveWork()が実際に
// 使うことになったWork.id(resolvedWorkId)の比較だけで決定論的に
// 判定する。DBアクセス無しでテストできるようにするため、判定ロジック
// 自体をresolveAndRunWork()から切り出した。
//
// 以前はここが「conversation.workIdが未設定だったか」だけを条件に
// していたため、conversation.workIdがstale(参照先が存在しない)・
// foreign(他user所有、resolveWork()内のgetWork()が絶対に再利用
// しない)だった場合、resolveWork()は正しく新しいWorkへfallbackする
// ものの、conversation.workId自体は既にnon-nullのため書き戻されず、
// 古い/他user所有のidを指したまま残ってしまっていた——結果、次の
// Turnも同じ無効なlinkを読み、Turnのたびに新しいWorkを作り続けて
// しまう(「1 Conversationから毎Turn別Workが生成される」バグ)。
//
// 修正後は、既存linkと実際に使われたWork.idを比較することで、
// 以下の4ケース全てを正しく扱う:
//   1. link無し                -> 不一致 -> 新規Workをlink
//   2. 有効な自分のWorkへのlink   -> 一致   -> 書き戻し無し(無駄な
//                                            UPDATEを発生させない)
//   3. stale/存在しないlink      -> 不一致 -> 新しいWorkへrepair
//   4. 他user所有のWorkへのlink   -> 不一致 -> 新しいWorkへrepair
//      (foreign Work自体は絶対に再利用しない、resolveWork()内の
//      getWork()による既存ownership防御がこの安全性を保証する。
//      repair自体もlinkConversationWork()の既存
//      `.eq("id", conversation.id).eq("user_id", conversation.userId)`
//      によりconversation所有者の検証を経由する——外部user idを
//      owner判定へ使うことは一切無い)。
export function shouldRepairConversationWorkLink(
  currentWorkId: string | null | undefined,
  resolvedWorkId: string
): boolean {

  return (currentWorkId ?? null) !== resolvedWorkId;

}

// =========================
// resolveAndRunWork (Architecture Migration Phase B2)
// =========================
//
// ARCH-R2の目標経路(Interface → Conversation → Work Intake → Work →
// Work Execution Boundary → existing Orchestrator)を、
// runNormalTurn()・runClarificationAnswerTurn()の両方から共通で
// 呼び出すための薄いヘルパー。既存のconversation.workId
// (tact_conversations.work_id、Phase B2で追加)を「再利用候補」として
// 渡すだけで、このConversation自身のstore.ts(work_id列)へは
// core/tact-work自身は一切問い合わせない(core/tact-work/intake.ts
// のコメント参照、モジュール間の一方向依存を保つ)。
//
// 絶対条件: Work.id ≠ Conversation.id。書き戻しが必要かどうかは
// shouldRepairConversationWorkLink()が判定する(1 Conversation →
// 1 active Workの単純運用、ARCH-R2最重要原則)。
//
// テスト容易性のため、実際のresolveWork()/linkConversationWork()/
// runWorkTurn()呼び出しをConstructor/Parameter Injectionで差し替え
// 可能にする(既定値は実関数。他のcore/tact-work呼び出し箇所と同じ
// DIパターン)。
export interface ResolveAndRunWorkDeps {

  resolveWork: typeof resolveWork;

  linkConversationWork: typeof linkConversationWork;

  runWorkTurn: typeof runWorkTurn;

}

const defaultResolveAndRunWorkDeps: ResolveAndRunWorkDeps = {
  resolveWork,
  linkConversationWork,
  runWorkTurn,
};

// =========================
// resolveIntegrationConnectionViaTactIntegration
// (Architecture Migration Phase C2.1b)
// =========================
//
// core/tact-work/execution.tsのrunWorkTurn()は、循環参照を避けるため
// core/tact-integrationを一切importしない(resolveIntegrationConnection
// という汎用の拡張点の型だけを知る、OrchestrationHooksと同じ設計)。
// core/tact-conversation/はcore/tact-workにもcore/tact-integrationにも
// 依存してよい合成ルート的な位置(どちらからもimportされない)のため、
// この1箇所だけが両者を実際に結び付ける。
//
// 絶対条件: TACT Connectionのcredential/token/providerConnectionRef
// はここでも一切扱わない——listConnectionsForUser()が返すCanonical
// Connection.idだけを使う。
//
// LIVE-1A False Multiple Connection Resolution(READ-ONLY AUDIT確定済み
// root cause、修正): 以前はlistConnectionsForUser()の戻り値(=その
// user/serviceの全status行)の件数だけでsingle/multipleを判定して
// いたため、Gmail provisioningを複数回行った履歴に由来する
// pending/failed/revoked行までもが「複数の候補」として誤って数えられて
// いた。resolution candidateはactive connectionだけであるべき
// (絶対条件、Gmail固有の分岐は作らない——provider/service非依存の
// まま、"active"というcanonical statusをlistConnectionsForUser()の
// 第4引数へ渡すだけ)。pending/failed/revokedな行はDBに残ったままで
// よく、この関数から見て構造的に無視される(削除・移行は一切不要)。
//
// テスト容易性のため、listConnectionsForUser()呼び出しをDI可能な形
// (ResolveIntegrationConnectionViaTactIntegrationDeps)へ切り出し、
// export する(既存core/tact-integration/execution.ts等と同じ
// 「実I/OだけをDepsとして差し替え可能にする」既存パターン)。実DB
// (Supabase)に一切接続せず、実際のsingle/multiple/none判定ロジックを
// 直接検証できるようにするための、振る舞い自体は一切変えないrefactor。
export interface ResolveIntegrationConnectionViaTactIntegrationDeps {
  listConnectionsForUser: typeof listConnectionsForUser;
}

const defaultResolveIntegrationConnectionViaTactIntegrationDeps: ResolveIntegrationConnectionViaTactIntegrationDeps = {
  listConnectionsForUser,
};

export async function resolveIntegrationConnectionViaTactIntegrationForTesting(
  params: Parameters<ResolveIntegrationConnection>[0],
  deps: ResolveIntegrationConnectionViaTactIntegrationDeps = defaultResolveIntegrationConnectionViaTactIntegrationDeps
): ReturnType<ResolveIntegrationConnection> {

  const activeConnections = await deps.listConnectionsForUser(
    params.userId,
    params.accessToken,
    params.service as IntegrationService,
    "active"
  );

  if (activeConnections.length === 0) {
    return { status: "none" };
  }

  if (activeConnections.length > 1) {
    return { status: "multiple", count: activeConnections.length };
  }

  return { status: "single", connectionId: activeConnections[0].id };

}

// 実配線(defaultRunWorkTurnDeps等)はこのラッパーをそのまま使う——
// 既定deps(実listConnectionsForUser)で
// resolveIntegrationConnectionViaTactIntegrationForTesting()を呼ぶだけ、
// 挙動は変更前と完全に同一。
const resolveIntegrationConnectionViaTactIntegration: ResolveIntegrationConnection = (params) =>
  resolveIntegrationConnectionViaTactIntegrationForTesting(params);

// =========================
// formatIntegrationReadResultAnswer (Architecture Migration Phase C2.2)
// =========================
//
// 絶対条件(Section18、最重要): Slack channel list等のuser-visible
// formattingはcore/tact-work・core/tact-integration domainへ持ち込まず、
// この境界(core/tact-conversation)で行う。result.integrationReadResult.
// output(core/tact-work/execution.tsがJSON.stringify()した、canonical
// result——例: core/tact-integration/types.tsのSlackListChannelsResult)
// をここで初めてparseし、人間可読なtextへ変換する。
//
// 絶対条件: raw provider response(Composio生データ)はこの時点で既に
// core/tact-integration/execution.tsのgeneric coreを経由しており、
// output自体がcanonical(Provider非依存)なJSONである前提——万一形式が
// 想定外でも例外を投げず、undefinedを返して既存のplan.answer
// (Capabilityが設定したplaceholder文言)をそのまま使わせる(防御的)。
//
// 絶対条件(Section18): 大量結果に備え、表示件数の安全な上限(先頭20件)
// をこのtext生成側だけに設ける——result.integrationReadResult自体
// (canonical data)は一切書き換えない。
//
// Architecture Migration Phase C2.2c(Read Result Completeness Semantics
// Correction): list_channelsは現在1回のprovider callのみ(limit=100・
// pagination loop無し・types未指定によりprovider既定のpublic_channel
// のみ・exclude_archived未指定)で完結するため、この結果はworkspace内の
// Slackチャンネルを網羅した一覧であることを保証しない(private
// channel・archived channelの扱いもprovider既定に委ねたまま、公開
// channelが100件を超える場合も次ページを取得しない)。そのため
// visible文言は「これが全チャンネルである」と読める断定的な表現
// (「以下のチャンネルがあります」「チャンネル一覧です」等)を避け、
// 「取得できた分」であることが伝わる非網羅的な表現にとどめる
// (pagination対応・includePrivate/includeArchived等のcanonical
// semantics拡張は将来のDebtとして意図的に今回のscope外のまま)。
export function formatIntegrationReadResultAnswer(result: OrchestrationResult): string | undefined {

  const readResult = result.integrationReadResult;

  if (!readResult) {
    return undefined;
  }

  if (readResult.service === "slack" && readResult.operation === "list_channels") {

    try {

      const parsed = JSON.parse(readResult.output) as { channels?: unknown } | null;
      const rawChannels = Array.isArray(parsed?.channels) ? parsed?.channels : [];

      const names = (rawChannels ?? [])
        .map((channel) =>
          channel && typeof channel === "object" && typeof (channel as { name?: unknown }).name === "string"
            ? (channel as { name: string }).name
            : undefined
        )
        .filter((name): name is string => !!name)
        .slice(0, 20);

      if (names.length === 0) {
        // 絶対条件(Section3): 0件をproviderの実行失敗と混同しない
        // (executeReadIntegrationAction()側のfailed経路とは別の、
        // 「実行は成功したが表示できるchannelが無かった」ケース)。
        // 「チャンネルはありません」のような完全性を断定する表現は
        // 避け、「取得できなかった」という非断定的な表現にとどめる。
        return "表示できるSlackチャンネルを取得できませんでした。";
      }

      // 絶対条件(Section4): 「すべてのチャンネル」「チャンネル一覧
      // です」等、網羅性を示唆する表現を使わない(pagination未対応・
      // public_channelのみがprovider既定のため、これは網羅的な一覧
      // ではなく「取得できた分」でしかない)。
      return `取得できたSlackチャンネルです:\n${names.map((name) => `#${name}`).join("\n")}`;

    } catch {
      return undefined;
    }

  }

  if (readResult.service === "gmail" && readResult.operation === "search_messages") {

    try {

      const parsed = JSON.parse(readResult.output) as { messages?: unknown } | null;
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];

      if (messages.length === 0) {
        return "該当するメールは見つかりませんでした。";
      }

      const lines = messages.slice(0, 10).flatMap((message) => {
        if (!message || typeof message !== "object") {
          return [];
        }

        const item = message as Record<string, unknown>;
        const subject = typeof item.subject === "string" ? item.subject : "(件名なし)";
        const from = typeof item.from === "string" ? item.from : "送信者不明";
        const date = typeof item.date === "string" ? item.date : "日付不明";
        const snippet = typeof item.snippet === "string" ? item.snippet : "";

        return [`• ${subject}\n  ${from} / ${date}${snippet ? `\n  ${snippet}` : ""}`];
      });

      return lines.length > 0
        ? `該当メール ${messages.length} 件のうち、取得できた分です。\n${lines.join("\n")}`
        : undefined;

    } catch {
      return undefined;
    }

  }

  if (readResult.service === "notion" && readResult.operation === "search") {

    try {
      const parsed = JSON.parse(readResult.output) as { results?: unknown } | null;
      const items = Array.isArray(parsed?.results) ? parsed.results : [];

      if (items.length === 0) {
        return "Notionで一致するページは見つかりませんでした。";
      }

      const lines = items.slice(0, 5).flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }

        const title = typeof (item as { title?: unknown }).title === "string"
          ? (item as { title: string }).title
          : "無題";
        const lastEditedTime = typeof (item as { lastEditedTime?: unknown }).lastEditedTime === "string"
          ? (item as { lastEditedTime: string }).lastEditedTime
          : undefined;

        return [`• ${title}${lastEditedTime ? `\n  最終更新: ${lastEditedTime.slice(0, 10)}` : ""}`];
      });

      return lines.length > 0
        ? `Notionで ${items.length} 件見つかりました。\n${lines.join("\n")}`
        : undefined;
    } catch {
      return undefined;
    }

  }

  if (readResult.service === "notion" && readResult.operation === "read_page") {

    try {
      const parsed = JSON.parse(readResult.output) as { title?: unknown; text?: unknown } | null;
      const title = typeof parsed?.title === "string" ? parsed.title : "Notionページ";
      const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";

      return text
        ? `「${title}」を確認しました。\n\n${text.slice(0, 2_000)}`
        : `「${title}」を確認しました。本文から読み取れるテキストはありませんでした。`;
    } catch {
      return undefined;
    }

  }

  return undefined;

}

// =========================
// formatIntegrationReadFailureAnswer (LIVE-1A: Read Failure Surfacing)
// =========================
//
// Root cause(READ-ONLY AUDIT): core/tact-work/execution.tsのread
// integration実行が"completed"以外の結果で終わった場合、
// result.integrationReadResultが設定されず、formatIntegrationReadResultAnswer()
// もundefinedを返すため、result.answerはCapabilityが最初に設定した
// placeholder文言("Gmail で該当するメールを検索します。"等)のまま
// 最終回答として返っていた——DBではTask/Runが正しくfailedとして
// 永続化される一方、Slackへは「成功したふりをした」文言だけが届く
// 非対称があった。この関数はその非対称を解消する。
//
// 絶対条件(最重要、provider-neutral): Gmail固有の分岐を作らない——
// service/operation/statusという既にcanonicalなsafe値だけから、
// どのIntegration read(将来Slack以外が増えても)にも共通して効く
// 固定文言を組み立てる。raw provider error(IntegrationExecutionError.
// message)・secret・token・provider metadata・internal reason文字列は
// 一切参照しない(result.integrationReadFailureの型自体がそれらを
// 持たない、core/tact-orchestrator/types.ts参照)。
const INTEGRATION_SERVICE_LABELS: Record<string, string> = {
  gmail: "Gmail",
  slack: "Slack",
  notion: "Notion",
};

// 表示用のprovider名(未知serviceでも安全にfallbackする——固定
// allowlistの外へ出ても例外を投げない防御的実装)。
function integrationServiceLabel(service: string): string {
  return INTEGRATION_SERVICE_LABELS[service] ?? service;
}

// 操作の性質を表す動詞(read operationが増えても、この小さなmapへ
// 追記するだけでよい——未知operationは安全な既定語「処理」へ
// fallbackする)。
const READ_OPERATION_VERBS: Record<string, string> = {
  search_messages: "検索",
  list_channels: "取得",
  search: "検索",
  read_page: "読み取り",
};

function readOperationVerb(operation: string): string {
  return READ_OPERATION_VERBS[operation] ?? "処理";
}

export function formatIntegrationReadFailureAnswer(result: OrchestrationResult): string | undefined {

  const failure = result.integrationReadFailure;

  if (!failure) {
    return undefined;
  }

  const label = integrationServiceLabel(failure.service);
  const verb = readOperationVerb(failure.operation);

  switch (failure.status) {

    case "connection_unavailable":
      return `${label}との接続を確認できなかったため、${verb}できませんでした。`;

    case "failed":
      return `${label}の${verb}中にエラーが発生しました。`;

    case "invalid_action":
    case "not_found":
    case "work_not_runnable":
    case "task_not_executable":
      return `${label}の${verb}を完了できませんでした。もう一度お試しください。`;

    default: {
      // core/tact-orchestrator/types.tsのintegrationReadFailure.statusは
      // 上記6値のunionとして定義済み(exhaustive switch、絶対条件)。
      const exhaustiveCheck: never = failure.status;
      return exhaustiveCheck;
    }

  }

}

// =========================
// executeReadIntegrationActionViaTactIntegration
// (Architecture Migration Phase C2.2)
// =========================
//
// resolveIntegrationConnectionViaTactIntegrationと全く同じ設計思想:
// core/tact-work/execution.tsのrunWorkTurn()は、循環参照を避けるため
// core/tact-integrationを一切importしない(executeReadIntegrationAction
// という汎用の拡張点の型だけを知る)。core/tact-conversation/がこの
// 唯一の実配線点であり、TaskApprovalAction.metadata(service/operation/
// input)からIntegrationAction(core/tact-integration所有の型)を
// 組み立て直し、core/tact-integration/execution.tsの実
// executeReadIntegrationAction()を呼ぶ。
//
// 絶対条件: このfileはBot-specific formatting(表示整形)を一切行わない
// ——canonical read result(JSON文字列化されたoutput)をそのまま
// ExecuteReadIntegrationActionOutcome.resultOutputへ運ぶだけ。
const executeReadIntegrationActionViaTactIntegration: ExecuteReadIntegrationAction = async (
  params
) => {

  const metadata = params.action.metadata as
    | { service?: unknown; operation?: unknown; input?: unknown }
    | undefined;

  const service = typeof metadata?.service === "string" ? metadata.service : undefined;
  const operation = typeof metadata?.operation === "string" ? metadata.operation : undefined;
  const input =
    metadata?.input && typeof metadata.input === "object"
      ? (metadata.input as Record<string, unknown>)
      : {};

  if (!service || !operation) {
    return { status: "invalid_action" };
  }

  const outcome = await executeReadIntegrationAction({
    workId: params.workId,
    userId: params.userId,
    accessToken: params.accessToken,
    taskId: params.taskId,
    connectionId: params.connectionId,
    action: { service: service as IntegrationService, operation, input },
  });

  switch (outcome.status) {

    case "completed":
      return { status: "completed", resultOutput: outcome.run.result?.output ?? undefined };

    case "failed":
      return { status: "failed" };

    case "connection_unavailable":
      return { status: "connection_unavailable" };

    case "invalid_action":
      return { status: "invalid_action" };

    case "task_not_executable":
      return { status: "task_not_executable" };

    case "not_found":
      return { status: "not_found" };

    case "work_not_runnable":
      return { status: "work_not_runnable" };

    // read境界はApproval/dedupの対象外のため通常到達しない
    // (executeReadIntegrationAction()自身がapprovalIdを一切扱わない)
    // が、IntegrationActionExecutionOutcome型としては存在するため、
    // 安全側(invalid_action)へfallbackするだけにとどめる(絶対条件:
    // readのためにApprovalを偽造しない、新しいoutcome分類も増やさない)。
    // Architecture Migration ARCH-P1c: approval_integrity_failedも
    // 同じ理由で通常到達しない(read境界はApproval Integrity検証
    // 自体を一切行わない、core/tact-integration/execution.tsの
    // executeApprovedIntegrationAction()専用の分岐)。
    case "approval_not_approved":
    case "already_executed":
    case "approval_integrity_failed":
      return { status: "invalid_action" };

    default: {
      const exhaustiveCheck: never = outcome;
      return exhaustiveCheck;
    }

  }

};

// =========================
// executeReadIntegrationActionWithRuntimeRouting
// (Fast Port P5c: Route One Non-Side-Effecting Integration Read
// Through Trigger.dev)
// =========================
//
// executeReadIntegrationActionViaTactIntegration()の既存挙動を一切
// 変えない、additiveなwrapper。絶対条件(Step2/20): routingは
// service==="slack" && operation==="list_channels"のみのhard-gated
// opt-in(isRuntimeEligibleIntegrationAction())——それ以外(send_message
// を含む)は必ず既存direct pathへそのまま委譲する。Runtime未設定
// (flag false/missing)の場合も同様に既存direct pathへ委譲する
// (Step21: 既存Slack live flowを壊さない)。
//
// 絶対条件(Step22): flag=trueだがconfigが不正な場合はsilent direct
// fallbackをしない——fail closed(invalid_action)で止める。operator
// intentと実際のexecution substrateがズレたまま実行してしまうことを
// 防ぐため。
export const executeReadIntegrationActionWithRuntimeRouting: ExecuteReadIntegrationAction = async (
  params
) => {

  const metadata = params.action.metadata as
    | { service?: unknown; operation?: unknown }
    | undefined;

  const service = typeof metadata?.service === "string" ? metadata.service : undefined;
  const operation = typeof metadata?.operation === "string" ? metadata.operation : undefined;

  if (!service || !operation || !isRuntimeEligibleIntegrationAction(service, operation)) {
    return executeReadIntegrationActionViaTactIntegration(params);
  }

  const resolution = resolveRuntimeIntegrationReadAdapter();

  if (resolution.status === "disabled") {
    return executeReadIntegrationActionViaTactIntegration(params);
  }

  if (resolution.status === "misconfigured") {
    return { status: "invalid_action" };
  }

  const connectionId = typeof (metadata as { connectionId?: unknown })?.connectionId === "string"
    ? (metadata as { connectionId?: string }).connectionId!
    : params.connectionId;

  const dispatchOutcome = await dispatchIntegrationReadToRuntime(
    {
      workId: params.workId,
      userId: params.userId,
      accessToken: params.accessToken,
      taskId: params.taskId,
      connectionId,
      action: { service: "slack", operation, input: {} },
    },
    resolution.adapter
  );

  switch (dispatchOutcome.status) {

    case "dispatched":
      return { status: "runtime_dispatched" };

    // Fast Port P5d: startがRuntimeへ実際に届いたか不明(ambiguous)な
    // 場合も、Runは既にrunningのまま維持されている(failedへ確定
    // していない)——同期的な呼び出し元から見た意味は「非同期に
    // handoffされ、結果はまだ確定していない」という点でdispatched
    // と同じであり、既存の"runtime_dispatched"へそのまま合流させる
    // (callerに新statusを増やしすぎない、Step6)。
    case "ambiguous":
      return { status: "runtime_dispatched" };

    case "runtime_start_failed":
      return { status: "failed" };

    case "not_found":
      return { status: "not_found" };

    case "work_not_runnable":
      return { status: "work_not_runnable" };

    case "connection_unavailable":
      return { status: "connection_unavailable" };

    case "invalid_action":
      return { status: "invalid_action" };

    case "task_not_executable":
      return { status: "task_not_executable" };

    default: {
      const exhaustiveCheck: never = dispatchOutcome;
      return exhaustiveCheck;
    }

  }

};

// =========================
// executePreparedTaskResume (Fast Port P6b: Canonical Resume Execution)
// =========================
//
// P6a(core/tact-work/resume.ts)のrequestTaskResume()が返した
// TaskResumeIntentを、TACT-owned execution boundaryとして安全に実行へ
// 接続する。絶対条件(最重要、P6a/P6b共通): resolved ≠ resumed。この
// 関数自身が「実行してよいか」の最終判断者ではなく、prepared intentを
// authorization tokenとして信用せず、この呼び出し自身が毎回
// evaluateTaskResumeEligibility()を再実行する(Step3絶対条件——prepared
// 後にApproval追加・Task terminal化・別Run開始・completed Run発生・
// Work cancellation等が起こり得るため)。
//
// caller供給禁止(Step2絶対条件): userId/accessToken以外の
// connectionId/provider/runtime provider/resolvedAction/Approval
// subject/credential/raw external inputはこの関数のシグネチャに
// 一切存在しない——全てTask.assignedCapability・既存approved
// Approval・既存Connection(唯一のactive Connection)という、canonical
// persisted stateからこの関数自身が再解決する。
//
// 既存provider-neutral execution routingの再利用(Step8/9/10絶対条件):
//   - write(policyDecision==="require_approval"): 既存
//     executeApprovedIntegrationAction()(Policy live recheck・Approval
//     Integrity検証・dedup・Run lifecycleを完全に内包する既存境界)へ
//     そのまま委譲する。Approval検証ロジックはここで一切複製しない。
//   - read(policyDecision==="allow"): このfile自身の既存
//     executeReadIntegrationActionWithRuntimeRouting()(P5c/P5d、
//     Runtime/Native routing決定を完全に内包)へそのまま委譲する。
//     TriggerDevRuntimeAdapterを直接newしない・Composio等Providerを
//     直接呼ばない(いずれも既存境界の内部に閉じたまま)。
//
// exactly-one NEW Run(Step5/6/7/16絶対条件、最重要): 新しいRunは常に
// 上記の既存境界内部のprepareRunForExecution()が作る(この関数自身は
// createRunを一切呼ばない、Retry=new Runという既存不変条件をそのまま
// 継承する)。並行呼び出しに対するexactly-one保証は、新しいmigrationを
// 追加せず、既存schema(supabase/migrations/20260905000000_create_
// tact_work_tables.sqlのunique index idx_tact_runs_task_id_attempt、
// (task_id, attempt)の一意性)をそのまま利用する——評価の結論
// (Step16): 2つの並行呼び出しが同じ(taskId, attempt)でcreateRun()を
// 試みた場合、一方は既存core/tact-work/store.tsのcreateRun()自身が
// 投げる例外(isDuplicateAttempt()のapplication-level throw、または
// DB unique constraint violation)によって必ず失敗する——この既存
// 一意性だけで「exactly one canonical Run claim」が既に保証されており、
// 新しいDB制約(execution lease等)を追加する必要は無い。この関数は
// その例外を検出し、"concurrent_resume_detected"という安全なoutcome
// へ正規化するだけにとどめる。

// Step5/16: store.tsのcreateRun()が投げる「同じ(task_id, attempt)への
// 同時挿入」エラーを検出する。createRun()自身の固定throw文言と、
// Postgres unique_violationの標準エラーコード("23505")の2経路で
// 判定するため、通常の予期しないエラー(接続断等)を誤って握り潰す
// ことはない——該当しない例外は呼び出し元へそのまま再送出する。
function isConcurrentRunClaimError(error: unknown): boolean {

  if (error instanceof Error && error.message.includes("Run attempt already exists")) {
    return true;
  }

  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  ) {
    return true;
  }

  return false;

}

// WorkTask.assignedCapabilityは、core/tact-integration/execution.tsの
// prepareRunForExecution()がRun.capabilityへ書き込む値
// (`integration.${service}.${operation}`)と同じ形式で永続化される
// (既存precedent、tests/tact/work/execution.test.ts参照)。この関数は
// その形式をcaller入力を経由せず逆算するだけの純粋関数——
// "integration."で始まらないcapability(research等、Integration
// 以外のCapability)はP6bのscope外として安全にundefinedを返す。
function parseIntegrationCapability(
  assignedCapability: string
): { service: string; operation: string } | undefined {

  const parts = assignedCapability.split(".");

  if (parts.length !== 3 || parts[0] !== "integration" || !parts[1] || !parts[2]) {
    return undefined;
  }

  return { service: parts[1], operation: parts[2] };

}

export interface ExecutePreparedTaskResumeParams {

  intent: TaskResumeIntent;

  userId: string;

  accessToken: string;

}

// テスト容易性のため(Fast Port P4a incidentの教訓、既存core/tact-work/
// 各execution boundaryと同じDIパターン): 実Supabase/Composio/
// Trigger.devへ到達する既存関数を、全てConstructor/Parameter
// Injectionで差し替え可能にする。既定値は実際にwiring済みの既存関数
// そのまま(挙動変更なし)。
export interface ExecutePreparedTaskResumeDeps {

  evaluateTaskResumeEligibility: typeof evaluateTaskResumeEligibility;

  listTasksForWork: typeof listTasksForWork;

  listApprovalsForWork: typeof listApprovalsForWork;

  evaluatePolicyDecision: typeof evaluatePolicyDecision;

  executeApprovedIntegrationAction: typeof executeApprovedIntegrationAction;

  resolveIntegrationConnection: ResolveIntegrationConnection;

  executeReadIntegrationAction: ExecuteReadIntegrationAction;

}

const defaultExecutePreparedTaskResumeDeps: ExecutePreparedTaskResumeDeps = {
  evaluateTaskResumeEligibility,
  listTasksForWork,
  listApprovalsForWork,
  evaluatePolicyDecision,
  executeApprovedIntegrationAction,
  resolveIntegrationConnection: resolveIntegrationConnectionViaTactIntegration,
  executeReadIntegrationAction: executeReadIntegrationActionWithRuntimeRouting,
};

// Step5絶対条件: 新しいRun statusを追加しない——write pathは既存
// IntegrationActionExecutionOutcome、read pathは既存
// ExecuteReadIntegrationActionOutcomeをそのまま透過する。このunionが
// 追加するのは「そもそも実行境界(既存Approval/Policy/Runtime
// boundary)へ到達できなかった」という、このresume operation自身に
// 固有の分岐だけ。
export type TaskResumeExecutionOutcome =
  | { status: "not_eligible"; reasonCode: TaskResumeEligibilityBlockedReasonCode }
  | { status: "already_terminal"; reasonCode: TaskResumeTerminalReasonCode }
  | { status: "unsupported_capability" }
  | { status: "policy_not_executable" }
  | { status: "approval_not_found" }
  | { status: "connection_unresolved" }
  | { status: "concurrent_resume_detected" }
  | { status: "write_executed"; outcome: IntegrationActionExecutionOutcome }
  | { status: "read_executed"; outcome: ExecuteReadIntegrationActionOutcome };

export async function executePreparedTaskResume(
  params: ExecutePreparedTaskResumeParams,
  deps: ExecutePreparedTaskResumeDeps = defaultExecutePreparedTaskResumeDeps
): Promise<TaskResumeExecutionOutcome> {

  const { intent, userId, accessToken } = params;
  const { workId, taskId } = intent;

  // Step3絶対条件(最重要): prepared intentを信用せず、この呼び出し
  // 自身が毎回eligibilityを再確認する。
  const eligibility = await deps.evaluateTaskResumeEligibility({ workId, userId, accessToken, taskId });

  if (eligibility.status === "blocked") {
    return { status: "not_eligible", reasonCode: eligibility.reasonCode };
  }

  if (eligibility.status === "already_terminal") {
    return { status: "already_terminal", reasonCode: eligibility.reasonCode };
  }

  // eligibility.status === "eligible"。Task本体(assignedCapability)を
  // 再取得する(evaluateTaskResumeEligibility()自身はTask存在/状態
  // だけを見て、capability文字列自体は呼び出し元へ返さないため、
  // defense-in-depthも兼ねてここで再度Work/Task correlationごと
  // 取得する)。
  const tasks = await deps.listTasksForWork(workId, userId, accessToken);
  const task = tasks.find((candidate) => candidate.id === taskId && candidate.workId === workId);

  if (!task || !task.assignedCapability) {
    return { status: "unsupported_capability" };
  }

  const parsedCapability = parseIntegrationCapability(task.assignedCapability);

  if (!parsedCapability) {
    // integration.<service>.<operation>形状ではないcapability
    // (例: "research")は、P6bのscope(Integration execution boundary
    // への接続)対象外——既存Capability実行経路(Orchestrator Executor)
    // は一切変更しない。ここでは「resume executionとして対応できない」
    // ことを安全に報告するだけ。
    return { status: "unsupported_capability" };
  }

  const { service, operation } = parsedCapability;

  // Step4絶対条件: execution開始直前にcanonical Policyを再評価する
  // (prepared時点のPolicyを使い回さない、live recheck)。
  const policyDecision = deps.evaluatePolicyDecision(service, operation);

  if (policyDecision.decision === "require_input" || policyDecision.decision === "deny") {
    return { status: "policy_not_executable" };
  }

  if (policyDecision.decision === "require_approval") {

    // Step9絶対条件: 既存approve/reject/eligibilityで確定した
    // Approval状態を、ここで再構築・再判定しない。eligibility自身が
    // 既にpending/rejected/cancelled/expiredなApprovalの存在をblock
    // しているため、ここに到達した時点でこのTaskに紐づくApprovalは
    // "approved"だけのはず——それを見つけて既存
    // executeApprovedIntegrationAction()(Policy live recheck・
    // Approval Integrity検証・dedupを完全に内包する既存境界)へそのまま
    // 委譲するだけで、Approval検証ロジックをここで複製しない。
    const approvals = await deps.listApprovalsForWork(workId, userId, accessToken);
    const approvedApproval = approvals.find(
      (approval) => approval.taskId === taskId && approval.status === "approved"
    );

    if (!approvedApproval) {
      return { status: "approval_not_found" };
    }

    try {

      const outcome = await deps.executeApprovedIntegrationAction(workId, userId, accessToken, approvedApproval.id);

      return { status: "write_executed", outcome };

    } catch (error) {

      if (isConcurrentRunClaimError(error)) {
        return { status: "concurrent_resume_detected" };
      }

      throw error;

    }

  }

  // policyDecision.decision === "allow"(read)。connectionIdは
  // callerから受け取らず、既存resolveIntegrationConnectionViaTact
  // Integration()(このfile内、Web/Bot通常turnと全く同じ既存関数)で
  // 唯一のactive Connectionを再解決する。
  const connectionResolution = await deps.resolveIntegrationConnection({
    service,
    userId,
    accessToken,
  });

  if (connectionResolution.status !== "single") {
    return { status: "connection_unresolved" };
  }

  try {

    // 既存executeReadIntegrationActionWithRuntimeRouting()
    // (P5c/P5d、Runtime/Native routing決定を完全に内包)へそのまま
    // 委譲する。inputは常に空({})——resume executionはraw external
    // inputをcallerから受け取らない(絶対条件Step2)。
    const outcome = await deps.executeReadIntegrationAction({
      workId,
      userId,
      accessToken,
      taskId,
      connectionId: connectionResolution.connectionId,
      action: {
        kind: "integration_action",
        summary: `resume: ${service}.${operation}`,
        metadata: { service, operation, input: {}, connectionId: connectionResolution.connectionId },
      },
    });

    return { status: "read_executed", outcome };

  } catch (error) {

    if (isConcurrentRunClaimError(error)) {
      return { status: "concurrent_resume_detected" };
    }

    throw error;

  }

}

export async function resolveAndRunWork(
  conversation: Conversation,
  accessToken: string,
  orchestrationRequest: OrchestrationRequest,
  content: string,
  source: WorkIntakeSource,
  deps: ResolveAndRunWorkDeps = defaultResolveAndRunWorkDeps
): Promise<OrchestrationResult> {

  const requestedByActor: ActorReference = { kind: "user", id: conversation.userId };

  const work = await deps.resolveWork(
    {
      userId: conversation.userId,
      requestedByActor,
      content,
      source,
      conversationId: conversation.id,
      existingWorkId: conversation.workId ?? null,
    },
    accessToken
  );

  if (shouldRepairConversationWorkLink(conversation.workId, work.id)) {

    await deps.linkConversationWork(conversation, accessToken, work.id);

    // このTurn内で後続処理(applyArtifactMutation()等)が
    // conversation.workIdを参照する場合に備え、in-memoryの値も
    // 更新する(DBへは既にlinkConversationWork()で反映済み)。
    conversation.workId = work.id;

  }

  // Architecture Migration Phase C2.1b: runWorkTurn()自体はConnection
  // 解決の実装を知らない(既定は常に"none"を返す安全なfallback)。
  // ここがその唯一の実配線点(deps.runWorkTurnが実runWorkTurnの場合は
  // defaultRunWorkTurnDepsをベースに上書きする。テストがdeps.
  // runWorkTurn自体を偽実装に差し替えている場合はこの第2引数は
  // 単に無視される、既存のtest互換性への影響は無い)。
  return deps.runWorkTurn(
    {
      work,
      userId: conversation.userId,
      accessToken,
      orchestrationRequest,
    },
    {
      ...defaultRunWorkTurnDeps,
      resolveIntegrationConnection: resolveIntegrationConnectionViaTactIntegration,
      executeReadIntegrationAction: executeReadIntegrationActionWithRuntimeRouting,
    }
  );

}

async function runNormalTurn(
  conversation: Conversation,
  accessToken: string,
  userInput: string,
  attachmentIds: string[] = [],
  attachmentEvidence: AttachmentEvidence[] = [],
  workspaceEvidence: LocalWorkspaceEvidence[] = [],
  source: WorkIntakeSource = "web",
  conversationEvidence?: ConversationEvidence
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

  // Architecture Migration Phase B2: Orchestratorを直接呼ぶ代わりに
  // Work Intake/Work Execution Boundary(core/tact-work/)経由で呼ぶ。
  // OrchestrationRequestの中身自体は既存(Phase1〜90)と完全に同じ
  // ——resolveAndRunWork()はWork解決/Task・Run永続化を行うだけで、
  // Orchestratorへ渡すrequestを一切変更しない。
  let result = await resolveAndRunWork(
    conversation,
    accessToken,
    {
      userId: conversation.userId,
      input: orchestrationInput,
      previousUserInput,
      tableSchema,
      attachmentEvidence,
      workspaceEvidence,
      conversationEvidence,
    },
    orchestrationInput,
    source
  );

  // Architecture Migration Phase C2.2: read integration実行結果
  // (result.integrationReadResult)があれば、ここ(Conversation境界)で
  // 初めてBot向けtextへ整形し、result.answerへ反映する
  // (既存のintegrationConnectionIssues→result.answer上書き、
  // Phase C2.1bと同じ既存pattern)。
  //
  // LIVE-1A(絶対条件、最重要): 成功結果が無い場合でも、read failure
  // (result.integrationReadFailure)があればplaceholder文言のままに
  // せず、必ずuser-facingなfailure文言で上書きする。優先順位:
  //   1. integrationReadResult(成功)
  //   2. integrationReadFailure(失敗)
  //   3. 既存answer(read integration自体が発生しなかった通常Turn)
  const integrationReadAnswer =
    formatIntegrationReadResultAnswer(result) ?? formatIntegrationReadFailureAnswer(result);

  if (integrationReadAnswer) {
    result = { ...result, answer: integrationReadAnswer };
  }

  const contextAcknowledgement = conversationEvidence
    ? formatConversationEvidenceAcknowledgement(orchestrationInput, conversationEvidence)
    : undefined;
  if (contextAcknowledgement) {
    result = { ...result, answer: contextAcknowledgement };
  }

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

  const pendingApproval = await resolvePendingApproval(result, conversation, accessToken);

  return { conversation, userMessage, message, executionRecord, pendingApproval };

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
  pending: PendingClarification,
  source: WorkIntakeSource = "web"
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

  // Architecture Migration Phase B2: 同上(runNormalTurn()参照)。
  // Clarification再実行は、既存のWork(waiting_for_input状態のはず)を
  // resolveAndRunWork()が再利用し、Task計画が実際に行われた時点で
  // runningへ戻す(core/tact-work/execution.tsのonTasksPlanned)。
  let result = await resolveAndRunWork(
    conversation,
    accessToken,
    {
      userId: conversation.userId,
      input: resendInput,
    },
    resendInput,
    source
  );

  // Architecture Migration Phase C2.2 / LIVE-1A: runNormalTurn()と同じ理由
  // (formatIntegrationReadResultAnswer() / formatIntegrationReadFailureAnswer()
  // 参照、優先順位も同じ: 成功 → 失敗 → 既存answer)。
  const integrationReadAnswer =
    formatIntegrationReadResultAnswer(result) ?? formatIntegrationReadFailureAnswer(result);

  if (integrationReadAnswer) {
    result = { ...result, answer: integrationReadAnswer };
  }

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

  const pendingApproval = await resolvePendingApproval(result, conversation, accessToken);

  return { conversation, userMessage, message, executionRecord, pendingApproval };

}
