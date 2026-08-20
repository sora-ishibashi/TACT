import { EvidenceMode } from "../evidence/evidenceMode";
import { QualityProfile } from "../workflow/qualityProfile";
import { ConclusionState } from "../workflow/conclusionState";

// =========================
// Artifact Type / Destination (STEP74)
// =========================
//
// STEP73の調査で、core/conversation/reconstructTask.tsの
// TaskReconstruction.artifactTypeが実質的な「Document Format」の
// 唯一の情報源であることが判明した。ここでは同じ4値を、
// あちらの型をimportするのではなく独立したリテラル和として再定義する
// (conversation層は既にcontext層をimportしているため、逆方向
// のimport(context→conversation)を新設して依存の輪を作らないため。
// 値の集合が同一であれば、TypeScript的にも代入互換になる)。
// artifactType自体の意味・生成ロジックは一切変更しない。
export type ArtifactType =
  | "report"
  | "comparison"
  | "proposal"
  | "presentation";

// STEP73で「現状どこにも存在しない」と結論した新規軸。
// tact: TACT本体で完成物として利用する(既定)
// design: TACT Designへ渡し、編集・構造化・デザインする
export type Destination = "tact" | "design";

// =========================
// Workflow Log
// =========================

export interface WorkflowLog {
  agent: string;
  message: string;
  timestamp: number;
}

// =========================
// Workflow Event
// =========================

export interface WorkflowEvent {
  type:
    | "start"
    | "complete"
    | "failed";

  agent: string;

  timestamp: number;
}

// =========================
// Brain Rule
// =========================

export interface BrainRule {

  // 改善対象
  targetAgent?: string;

  // 改善内容
  rule: string;

  // なぜ必要か
  reason: string;

  // 優先度
  priority?:
    | "low"
    | "medium"
    | "high";

  // 作成日時
  createdAt: number;
}

// =========================
// Execution Record
// =========================

export interface ExecutionRecord {

  id: string;

  userInput: string;

  mode:
    | "quick"
    | "think"
    | "deep";

  agents: string[];

  outputs: Record<string, unknown>;

  quality?: {
    score: number;
    issues: string[];
    improvements: BrainRule[];
  };

  duration?: number;

  success?: boolean;

  failedAgents?: string[];

  reviewerAgent?: string;

  cost?: {
    tokens: number;
    estimatedUSD: number;
  };

  // STEP70: 今回のRunで採用されたEvidenceMode。新しい課金計算基盤は
  // 作らず、既存のagents(実際に実行されたAgent一覧)と併せてログ・
  // 実行履歴上でコスト比較できるようにするための記録専用フィールド。
  // 判定できなかった場合(researcher等を含まないcategory等)はundefined。
  evidenceMode?: EvidenceMode;

  // STEP71: 今回のRunで採用されたQualityProfile。evidenceModeと同じ
  // 位置づけの記録専用フィールド(Workflowの分岐そのものは
  // context.qualityProfileを見て行われるが、ここには実行後の
  // 記録として複製するだけ)。
  qualityProfile?: QualityProfile;

  // STEP71: Writer Critique(STEP67)/Writer Revision(STEP68)が
  // 実際に実行されたかどうか。新しいログ構造は増やさず、
  // 既存のcontext.writerCritique/context.writerRevisionの有無から
  // 導出できる値をexecutionRecordにも複製し、実行履歴だけで
  // コスト比較できるようにする。
  critiqueExecuted?: boolean;

  revisionExecuted?: boolean;

  // STEP74: 今回のRunで採用されたArtifactType/Destination。
  // evidenceMode/qualityProfileと同じ位置づけの記録専用フィールド。
  // Conversation層を経由しない呼び出し(app/api/tact/route.ts等)では
  // artifactTypeはundefinedのまま(無理に既定値を補完しない)。
  // destinationはcreateContext()側で常に"tact"へフォールバックするため、
  // 実質的に必ず値が入る。
  artifactType?: ArtifactType;

  destination?: Destination;

  createdAt: number;
}

// =========================
// Evidence
// =========================

export interface Evidence {

  // 一意ID
  id: string;

  // 一言で表したEvidence
  claim: string;

  // ResearcherのEvidence(JSON文字列)
  evidence: string;

  // 出典URL
  source?: string;

  // 信頼度
  confidence:
    | "low"
    | "medium"
    | "high";

  // Evidence品質
  score: number;

  // 時間情報
  publishedAt?: string;

  updatedAt?: string;

  retrievedAt?: string;

  // 出典分類
  // STEP32: "user_file"は、ユーザーがチャットに添付したファイル
  // (PDF/Word/Excel/PowerPoint/画像)から抽出した内容であることを表す。
  // Web検索由来のEvidenceと明確に区別するための追加値であり、
  // 既存の分類値・判定ロジック(inferSourceType等)は変更していない。
  sourceType?:
    | "official"
    | "government"
    | "paper"
    | "news"
    | "media"
    | "community"
    | "user_file"
    | "unknown";

  // メタデータ
  isPrimarySource?: boolean;

  freshnessScore?: number;

  hash?: string;

  // 作成者
  createdBy: string;

  // 作成日時
  createdAt: number;

  // タグ（検索用）
tags: string[];

references?: string[];
}

// =========================
// Workflow Context
// =========================

export interface WorkflowContext {

  // =====================
  // User
  // =====================

  userInput: string;

  mode:
    | "quick"
    | "think"
    | "deep";

  // =====================
  // User Identity (STEP131)
  // =====================
  //
  // server側でSupabase Authのセッショントークンを検証して確定した
  // userId(core/auth/getAuthenticatedUser.ts)。クライアントから
  // 送られてくる未検証の値ではない。未認証、またはConversation層を
  // 経由しない呼び出し(app/api/tact/route.ts等)ではnull/undefinedの
  // まま(既存挙動を変えない)。
  userId?: string | null;

  // =====================
  // Agent Output
  // =====================

  outputs: Record<string, unknown>;

  stepOutputs: Record<
    string,
    {
      agent: string;
      output: unknown;
    }
  >;

  // =====================
  // Memory
  // =====================

  memory: Record<
    string,
    (
      | string
      | BrainRule
    )[]
  >;

  // =====================
  // Brain Memory (STEP147)
  // =====================
  //
  // 上のmemory(Reviewer Memory、Agent別のretry改善メモ)とは別物。
  // こちらはcore/brain/memory.tsのrefreshRelevantBrainMemory()が
  // このWorkflow実行1回分だけのために取得した「今回のuserIdに
  // スコープされたBrain Memoryのスナップショット」を保持する。
  //
  // 背景(STEP146→STEP147): 以前はrefreshRelevantBrainMemory()が
  // core/brain/memory.ts側のmodule-scope共有配列を書き換え、
  // formatBrainMemory()が同じ共有配列を読む設計だったため、複数の
  // Workflowが同一プロセス上で同時実行された場合、Aのretrieval後・
  // Bのretrieval後にformatBrainMemory()が呼ばれるとBのMemoryを
  // 読んでしまう(=Aへ混入する)Race Conditionが理論上存在した。
  // 今回、Brain MemoryをこのWorkflowContext(1 Workflow実行につき
  // 1つ新規作成される、他Workflowと共有されないオブジェクト)へ
  // 保持することで、共有可変状態を経由せずにcore/prompt/builder.ts
  // (buildPrompt())まで値を伝播できるようにする。
  //
  // Workflow開始直後(runWorkflow()冒頭)にrefreshRelevantBrainMemory()
  // の戻り値で設定され、以降このWorkflow内では読み取り専用として扱う。
  brainMemory: BrainRule[];

// =====================
// Shared Evidence
// =====================

evidence: Evidence[];

// Analystが実際に参照したEvidence(selectEvidence()の結果そのもの)。
// Reviewerが同じEvidenceを確認できるようにするために保持する。
// Analystが実行されないWorkflowではundefinedのまま。
analystEvidence?: Evidence[];

// =====================
// Conclusion State (STEP106)
// =====================
//
// Analyst実行直後にresolveConclusionState()(core/workflow/
// conclusionState.ts)が判定する、現在の結論状態(HOLD/DECIDED)。
// STEP101-104の実測で、Writerが「Analystが優先順位付けを保留して
// いる」状態を無視し未支持の規範的結論をExecutiveSummaryへ生成する
// 問題が確認されたため、Writer実行前にこの状態を構造化して渡す
// (STEP105で設計、STEP106で実装)。Analystが実行されないWorkflowでは
// undefinedのまま。
conclusionState?: ConclusionState;

// STEP33のResearch Requirement Guard(core/workflow/runAgent.ts)が
// Researcher実行時に算出した判定結果。analystEvidenceと同じ考え方で、
// 後続のAgent(STEP34時点ではWriterのみ)がRunをまたいで参照できる
// ようにするための保持場所。Researcherが実行されないWorkflowでは
// undefinedのまま。
researchGuard?: {
  researchRequired: boolean;
  searchAttempted: boolean;
  searchSucceeded: boolean;
  guardTriggered: boolean;
  retryAttempted: boolean;
};

// =====================
// Writer Critique (STEP67)
// =====================
//
// Writerの最終出力に対して、既存Reviewerを「文章そのものを読む
// Critic」として1回だけ追加実行した結果。既存のcontext.outputs.reviewer
// (Writer実行前のReviewer判定。core/brain/analyzer.ts・
// core/advisor/buildAdvisorContext.tsが参照する既存の意味を持つ)は
// 上書きしない。Writerが実行されなかったWorkflow、またはCritic実行に
// 失敗した場合はundefinedのまま(Workflow全体は失敗させない)。
// 出力の形は既存のReviewer Output Format(outputFormats.tsのreviewer
// エントリ)をそのまま流用するため、新しい型は定義しない。
writerCritique?: unknown;

// =====================
// Writer Revision (STEP68)
// =====================
//
// writerCritique.approved === falseの場合に、最大1回だけ実行される
// Writer Revisionの記録。実際に発生した場合のみ設定される
// (Revisionが発生しなかった場合はundefinedのまま)。
//
// 重要: Revision後の「現在の」Writer出力はcontext.outputs.writerを
// 上書きする(=既存のFinal Output算出・core/conversation/index.tsの
// reconcileCurrentOutput()/run.outputsが、追加の分岐なしにそのまま
// Revision後の内容を扱えるようにするため)。ここでは
// originalOutput/revisedOutputの両方を保持し、初回とRevision後を
// 比較・追跡できるようにするだけで、二重に「正」を持たせない。
writerRevision?: {
  originalOutput: unknown;
  revisedOutput: unknown;
};

// Revision後にreviewWriterOutput()をもう一度だけ実行した結果
// (Reviewer再確認)。既存のwriterCritique(初回)は上書きしない。
// Revisionが発生しなかった場合、またはRevision後の再確認に
// 失敗した場合はundefinedのまま。
writerFinalCritique?: unknown;

// =====================
// Evidence Mode (STEP70)
// =====================
//
// handlePlanner.tsがPlanner実行直後に一度だけ算出する、今回のRunの
// EvidenceMode(core/evidence/evidenceMode.ts)。researcher/queryBuilder/
// analystをteamへ含めるかどうかの判断に使われた値をそのまま保持し、
// ログ・executionRecord経由でコスト比較できるようにする
// (新しい課金計算システムは作らない)。Plannerがcategoryを返さなかった
// 場合等、team構築自体が行われなかった場合はundefinedのまま。
evidenceMode?: EvidenceMode;

// =====================
// Quality Profile (STEP71)
// =====================
//
// handlePlanner.tsがevidenceModeと同時に一度だけ算出する、今回のRunの
// QualityProfile(core/workflow/qualityProfile.ts)。Writer Critique
// (STEP67)/Writer Revision(STEP68)を実行するかどうかの判断に使う。
// EvidenceModeとは独立した軸として扱う(「Evidence不要=品質チェック
// 不要」にはしない)。team構築自体が行われなかった場合はundefinedの
// まま(その場合core/workflow/index.ts側で既存のSTEP67/68挙動
// (常にCritique実行)を維持する安全側のデフォルトを使う)。
qualityProfile?: QualityProfile;

// =====================
// Artifact Type / Destination (STEP74)
// =====================
//
// STEP70/71のevidenceMode/qualityProfileが「Workflow内部で決定論的に
// 算出する」フィールドだったのに対し、artifactType/destinationは
// 「Conversation層(reconstructCurrentTask()/detectDestination())が
// 既に算出済みの値を、runWorkflow()の引数経由でそのまま受け取って
// 保持するだけ」のフィールドである。Workflow内部で新しい判定ロジックは
// 持たない(STEP73の「経路A」を採用したため)。
//
// artifactType: Conversation層を経由しない呼び出し(app/api/tact/route.ts等)
// ではundefinedのまま(既存呼び出し元の挙動は一切変えないため、
// 無理に既定値を補完しない)。
artifactType?: ArtifactType;

// destination: createContext()側で常に"tact"へフォールバックするため、
// 呼び出し元に関わらず必ず値が入る(STEP74の安全側デフォルト方針)。
destination?: Destination;

// STEP75: Conversation層(runConversationTurn())が保持している、
// Task Reconstruction前の生に近いユーザー発言(effectiveUserInput)。
// 背景: detectEvidenceMode()/detectQualityProfile()(core/workflow/
// handlePlanner.ts)は、これまでcontext.userInput(=composedTask。
// Task ReconstructionのLLMが言い換えた要約)の先頭段落を判定材料に
// していたため、「壁打ちしてください」等のユーザーの原文キーワードが
// 言い換えで失われ、判定がぶれる問題がSTEP74のE2Eで実際に観測された。
// rawUserInputが存在する場合、core/workflow/index.tsがhandlePlanner()
// 呼び出し時にこちらを優先する(存在しない場合はcontext.userInputへ
// フォールバックし、既存の呼び出し元(app/api/tact/route.ts等、
// Conversation層を経由しない経路)の挙動は一切変えない)。
rawUserInput?: string;

// =====================
// Conversation連携
// =====================

// Conversation.currentOutput(前回のWorkflow実行でのWriter出力)。
// 会話の2ターン目以降、既存の成果物を踏まえて更新するために使う。
// Writerの出力Schemaを変更しないため、型はunknownのまま保持する。
// 初回Turn(既存Workflowの単発実行を含む)ではundefinedのまま。
currentOutput?: unknown;

// =====================
// Agent Handoffs
// =====================

handoffs: Record<string, unknown>;

// =====================
// Runtime
// =====================

agentStatus: Record<string, string>;

  reviewHistory: unknown[];

  logs: WorkflowLog[];

  events: WorkflowEvent[];

  // =====================
  // Final
  // =====================

  finalOutput: unknown;

  // =====================
  // Self Improvement
  // =====================

  executionRecord?: ExecutionRecord;
}