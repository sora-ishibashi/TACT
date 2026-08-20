import { runWorkflow } from "../workflow";
import { defaultWorkflow } from "../workflow/defaultWorkflow";
import {
  Conversation,
  ConversationMessage,
  ConversationAttachment,
  WorkflowRun,
} from "./types";
import {
  reconstructCurrentTask,
  ARTIFACT_TYPE_SNAPSHOT_KEY,
} from "./reconstructTask";
import {
  reconcileCurrentOutput,
  buildAssistantMessage,
} from "./mergeWriterOutput";
import {
  collectPastEvidence,
  EVIDENCE_SNAPSHOT_KEY,
} from "./collectPastEvidence";
import { WorkflowEvent } from "../context/types";
import { runAdvisor } from "../advisor/runAdvisor";
import { buildAttachmentEvidence } from "../fileAnalysis/buildAttachmentEvidence";
import { detectDestination } from "../workflow/destination";

// =========================
// createConversation
// =========================
//
// 新しいConversationを作成する。
// 永続化(DB保存)は今回のスコープ外。呼び出し元が
// このオブジェクトを保持し、以降のターンで再利用する想定。

export function createConversation(
  userId?: string,
  title?: string
): Conversation {

  const now = new Date().toISOString();

  return {

    id: crypto.randomUUID(),

    userId,

    title,

    createdAt: now,

    updatedAt: now,

    currentTask: "",

    currentOutput: null,

    messages: [],

    workflowRuns: [],

  };

}

// =========================
// addMessage
// =========================

function addMessage(
  conversation: Conversation,
  role: ConversationMessage["role"],
  content: string
): ConversationMessage {

  const message: ConversationMessage = {

    id: crypto.randomUUID(),

    role,

    content,

    createdAt: new Date().toISOString(),

  };

  conversation.messages.push(message);

  conversation.updatedAt = message.createdAt;

  return message;

}

// =========================
// buildAppendedTask (fallback)
// =========================
//
// Task Reconstruction(LLMによる再構成)が失敗した場合に使う
// 従来どおりの単純追記方式。Workflow全体を失敗させないための
// 安全側のフォールバックとして残す。

function buildAppendedTask(
  conversation: Conversation,
  userInput: string
): string {

  return conversation.currentTask
    ? `${conversation.currentTask}\n追加指示: ${userInput}`
    : userInput;

}

// =========================
// buildEffectiveUserInput (STEP32)
// =========================
//
// ファイルが添付されている場合、userInputの先頭に添付ファイル名の
// 一覧を付記する。これにより、Task Reconstruction(LLM)が
// 「この資料」「このPDF」等の指示語を正しく認識できるようにする。
// 抽出済みのテキスト本文はここには含めない(本文はEvidence化して
// Shared Evidence経由でAgentへ渡すため。ここではあくまで
// 「何が添付されたか」を伝えるだけ)。
//
// 添付がない場合はuserInputをそのまま返す(既存の挙動を変えない)。

function buildEffectiveUserInput(
  userInput: string,
  attachments?: ConversationAttachment[]
): string {

  if (!attachments || attachments.length === 0) {
    return userInput;
  }

  const fileList = attachments
    .map((a) => `- ${a.fileName}`)
    .join("\n");

  return (
    `【添付ファイル】\n${fileList}\n\n${userInput}`
  );

}

// =========================
// runConversationTurn
// =========================
//
// Conversation内で新しいユーザー入力を受け取り、
// 既存のWorkflow(runWorkflow)を1回実行して、
// その結果をWorkflowRunとしてConversationへ紐付ける。
//
// 重要: 既存のrunWorkflow()・Agent・Evidence・Reviewer retry等の
// 実行方式には一切手を加えない。ここで行うのは
// 「既存Workflowの実行結果を会話状態として記録する」ことだけ。
//
// STEP28: 今回のユーザー発言が成果物についての質問(question)と
// 判定された場合は、Workflowを一切起動せず、Advisor(独立したQ&A
// 処理。core/workflow/core/agentsには一切参加しない)へ委譲する。
// この場合、WorkflowRunは作成せず、戻り値はnullとなる
// (Advisorの応答はconversation.messagesへ直接追加される)。

export async function runConversationTurn(
  conversation: Conversation,
  userInput: string,
  mode: "quick" | "think" | "deep" = "think",
  // STEP17: runWorkflow()が既に発火しているAgent開始/完了/失敗
  // イベントを、呼び出し元(SSEルート等)へそのまま中継するための
  // 任意コールバック。省略時の挙動(既存のPOSTルート)は一切変わらない。
  onEvent?: (event: WorkflowEvent) => void,
  // STEP32: ユーザーがチャットに添付したファイルから、既に抽出済みの
  // テキスト(画像は説明文)。省略時(undefined、既存の全呼び出し)は
  // 従来の挙動と一切変わらない。
  attachments?: ConversationAttachment[],
  // STEP131: server側でSupabase Authのセッショントークンを検証して
  // 確定したuserId(core/auth/getAuthenticatedUser.ts)。
  // conversation.userId(現状クライアント由来で未検証)とは別に、
  // Workflow Context(context.userId)へ渡すための信頼できる値として
  // 保持する。未指定(未認証、または呼び出し元が未対応)の場合は
  // undefinedのまま(既存挙動を変えない)。
  authenticatedUserId?: string | null
): Promise<WorkflowRun | null> {

  const effectiveUserInput =
    buildEffectiveUserInput(userInput, attachments);

  // Task Reconstruction: 会話履歴・現在の成果物・直前までの
  // currentTask・最新発言をもとに、LLMで作業状態を再構成する。
  // ここではまだconversation.messagesに今回のuserInputを
  // 追加していない(=「これまでの会話」と「最新の発言」を
  // 区別してLLMに渡すため)。
  //
  // 失敗時(LLM呼び出し失敗・JSON不正・task欠落)は、
  // 既存の単純追記方式へフォールバックし、Workflow全体は
  // 失敗させない。この場合、STEP17の対象外章保護
  // (preserveHeadings/isFullRewrite)も従来どおり働かせない
  // (保護なし=これまでの挙動のまま)。STEP28のrequestTypeも
  // 判定できないため、安全側として常にtask(通常Workflow)として扱う。

  let nextTask: string;
  let preserveHeadings: string[] = [];
  let isFullRewrite = false;
  let requestType: "task" | "question" = "task";
  // STEP36: 次Turn以降も元のartifactTypeを復元できるよう、
  // run.outputsへ保存するために保持する。
  let artifactType:
    | "report"
    | "comparison"
    | "proposal"
    | "presentation" = "report";
  // STEP39: requestType(task/question)とは独立した軸。Advisorへ
  // そのまま渡すために保持する(Workflow側にはcomposedTask内の
  // IDEA_MODE_MARKERとして既に埋め込まれているため、別途渡す
  // 必要はない)。
  let conversationMode: "evidence" | "idea" = "evidence";

  try {

    // STEP32: 添付ファイル名の一覧を含むeffectiveUserInputを渡し、
    // 「この資料」等の指示語をLLMが認識できるようにする。
    // STEP52: modeをOutputSpecのdetailLevel決定(補助的な影響)に
    // 使うため、既に受け取っているmodeをそのまま渡す。
    const reconstruction =
      await reconstructCurrentTask(
        conversation,
        effectiveUserInput,
        mode
      );

    nextTask = reconstruction.composedTask;
    preserveHeadings = reconstruction.preserveHeadings;
    isFullRewrite = reconstruction.isFullRewrite;
    requestType = reconstruction.requestType;
    artifactType = reconstruction.artifactType;
    conversationMode = reconstruction.conversationMode;

  } catch (error) {

    console.error(
      "[Conversation] Task reconstruction failed. Falling back to simple append.",
      error
    );

    nextTask =
      buildAppendedTask(
        conversation,
        effectiveUserInput
      );

  }

  // STEP74: Destinationは新規判定。Task Reconstruction(LLM)の成否には
  // 依存させず、実際のユーザー発言(effectiveUserInput)から独立に
  // 決定論的判定する(新しいLLM呼び出しは追加しない)。
  const destination =
    detectDestination(effectiveUserInput);

  addMessage(
    conversation,
    "user",
    effectiveUserInput
  );

  // STEP28: 成果物についての質問と判定され、かつ既に成果物が
  // 存在する場合のみAdvisorへ委譲する。成果物がまだ存在しない場合は
  // 質問対象が存在しないため、reconstructCurrentTask()側で既に
  // requestTypeがtaskへ補正されている(念のためここでも
  // currentOutputの有無を確認する)。
  //
  // STEP32: AdvisorはrunWorkflow()を経由しない(=Evidence poolを
  // 経由しない)ため、今回添付されたファイルの内容を直接
  // 参照できるよう、attachmentsをそのまま渡す。
  if (
    requestType === "question" &&
    conversation.currentOutput
  ) {

    const answer =
      await runAdvisor(
        conversation,
        userInput,
        attachments,
        conversationMode
      );

    addMessage(
      conversation,
      "assistant",
      answer
    );

    conversation.updatedAt =
      new Date().toISOString();

    return null;

  }

  conversation.currentTask = nextTask;

  const run: WorkflowRun = {

    id: crypto.randomUUID(),

    // 現時点では、蓄積された現在のTaskをそのまま
    // 既存Workflowへの入力として渡す。
    input: conversation.currentTask,

    outputs: {},

    status: "running",

    startedAt: new Date().toISOString(),

  };

  conversation.workflowRuns.push(run);

  // STEP18: 全面書き直し(isFullRewrite)でない場合のみ、
  // 過去のWorkflowRunで実際に収集されたEvidenceをWorkflowへ
  // 事前投入する。既存のShared Evidence(core/prompt/builder.ts)
  // ・Researcher自身のprompt指示("既存Evidenceより品質が高い場合
  // のみ追加"等)をそのまま利用するため、Researcher/Writerの
  // system prompt・責務は一切変更していない。
  // 全面書き直しの場合は、ユーザーが構成ごと作り直すことを
  // 明確に求めているため、過去Evidenceの再利用を強制しない
  // (=空のまま渡し、Researcherに素の状態で調査させる)。
  //
  // STEP32: 今回のTurnで新たに添付されたファイルのEvidenceは、
  // isFullRewriteかどうかに関わらず常に含める。全面書き直しが
  // 対象とするのは「過去Turnの再利用」であり、今回まさに
  // ユーザーが提供した資料は「過去のEvidence」ではないため。
  const attachmentEvidence =
    buildAttachmentEvidence(attachments ?? []);

  const seedEvidence = [
    ...(isFullRewrite ? [] : collectPastEvidence(conversation)),
    ...attachmentEvidence,
  ];

  try {

    const context =
      await runWorkflow(
        defaultWorkflow,
        conversation.currentTask,
        mode,
        onEvent,
        conversation.currentOutput,
        seedEvidence,
        // STEP74: reconstructCurrentTask()が既に算出済みのartifactTypeを
        // Workflow層へ構造的に渡す(従来はcomposedTaskへのテキスト
        // 埋め込みのみだった)。
        artifactType,
        destination,
        // STEP75: Task Reconstruction前の生に近いユーザー発言。
        // evidenceMode/qualityProfileの判定材料として、composedTask
        // (LLMによる言い換えでキーワードが失われ得る)より優先させる。
        effectiveUserInput,
        // STEP131: server側で検証済みのuserId。
        authenticatedUserId,
        // 最速実装モード STEP2: Brain Memory/Execution Historyを
        // Conversationへ紐付けて永続化するため。
        conversation.id
      );

    // STEP31: context.evidence(このRunの最終的なEvidence pool。
    // Researcherが自ら書いた要約だけでなく、Tool(web-search)の
    // 生の検索結果から自動生成されたEvidence(source=実URL)も
    // 含まれる)は、これまでWorkflowRunに永続化されておらず、
    // Turn終了時に破棄されていた。これが「Evidenceの一次情報URLを
    // 後から確認できない」問題の直接の原因だったため、
    // outputs内の既存Agent出力を壊さない形で、追加のキーとして
    // 保存する。新しいDBカラム・テーブルは不要
    // (conversation_workflow_runs.outputsは既存のJSONBカラムで
    // 任意のキーを保持できるため)。
    // STEP36: artifactTypeも同じJSONBカラムへ追加のキーとして保存する
    // (EVIDENCE_SNAPSHOT_KEYと全く同じパターン)。全体書き直し時に
    // 次Turn以降も元の成果物タイプを復元できるようにするため。
    run.outputs = {
      ...context.outputs,
      [EVIDENCE_SNAPSHOT_KEY]: context.evidence,
      [ARTIFACT_TYPE_SNAPSHOT_KEY]: artifactType,
    };

    run.status = "completed";

    run.completedAt = new Date().toISOString();

    // STEP16-A: Writerの出力を無条件に採用せず、既存章が
    // 不用意に失われていないかをConversation層で確認してから
    // currentOutputへ反映する。context.outputs.writerがfalsyの
    // 場合の挙動(旧currentOutputを維持)は従来と変えない。
    //
    // STEP17: preserveHeadings/isFullRewriteをあわせて渡し、
    // 「ユーザーが変更を求めた章」以外がWriterによって
    // 書き換えられていた場合は機械的に旧内容へ戻す。
    const previousOutput = conversation.currentOutput;

    const reconciledOutput =
      context.outputs.writer
        ? reconcileCurrentOutput(
            previousOutput,
            context.outputs.writer,
            { preserveHeadings, isFullRewrite }
          )
        : previousOutput;

    // STEP16-B: assistant messageは、Writerの生出力ではなく
    // reconcileCurrentOutput()を通過した最終的な成果物を基準に
    // 差分から機械的に組み立てる。LLM呼び出しは追加しない。
    // context.outputs.writerが存在しない(=Writerが実行されていない)
    // 場合は差分自体が発生し得ないため、既存の固定文言のままにする。
    const assistantMessage =
      context.outputs.writer
        ? buildAssistantMessage(
            previousOutput,
            reconciledOutput
          )
        : "成果物を更新しました。";

    conversation.currentOutput = reconciledOutput;

    addMessage(
      conversation,
      "assistant",
      assistantMessage
    );

  } catch (error) {

    run.status = "failed";

    run.error = String(error);

    run.completedAt = new Date().toISOString();

    throw error;

  } finally {

    conversation.updatedAt = new Date().toISOString();

  }

  return run;

}
