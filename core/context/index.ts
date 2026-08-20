import { WorkflowContext, Evidence, ArtifactType, Destination } from "./types";

export function createContext(
  userInput: string,
  mode: "quick" | "think" | "deep" = "think",
  currentOutput?: unknown,
  // STEP18: Conversation層が過去のWorkflowRunから集めたEvidence。
  // currentOutputと同じ位置づけの、任意の初期値。
  // 未指定時は従来どおり空配列から開始する(挙動を変えない)。
  seedEvidence?: Evidence[],
  // STEP74: Conversation層(reconstructCurrentTask())が既に算出済みの
  // artifactType。Workflow内部では新しい判定を行わず、渡された値を
  // そのまま保持するだけ(STEP73の「経路A」)。未指定(Conversation層を
  // 経由しない呼び出し)の場合はundefinedのまま、既存挙動を変えない。
  artifactType?: ArtifactType,
  // STEP74: 新設。未指定の場合は安全側デフォルトとして"tact"を採用する
  // (誤ってTACT Design向けの処理へ送る方が影響範囲が大きいため)。
  destination?: Destination,
  // STEP75: Task Reconstruction前の生に近いユーザー発言。渡された場合、
  // core/workflow/index.tsがevidenceMode/qualityProfileの判定材料として
  // userInput(composedTask)より優先して使う。未指定時はundefinedのまま
  // (既存呼び出し元の挙動は変えない)。
  rawUserInput?: string,
  // STEP131: server側でSupabase Authのセッショントークンを検証して
  // 確定したuserId(core/auth/getAuthenticatedUser.ts)。未指定
  // (未認証、またはConversation層を経由しない呼び出し)の場合は
  // undefinedのまま(既存呼び出し元の挙動は変えない)。
  userId?: string | null
): WorkflowContext {

  return {

    // =========================
    // User
    // =========================

    userInput,

    mode,

    // =========================
    // User Identity (STEP131)
    // =========================

    userId,

    // =========================
    // Conversation連携(前回のWriter出力。無ければundefined)
    // =========================

    currentOutput,

    // =========================
    // Artifact Type / Destination (STEP74)
    // =========================

    artifactType,

    destination: destination ?? "tact",

    rawUserInput,

    // =========================
    // Agent Outputs
    // =========================

    outputs: {},

    stepOutputs: {},

    // 最終成果物
    finalOutput: null,

    // =========================
    // Reviewer Memory
    // =========================

    memory: {},

    // =========================
    // Brain Memory (STEP147)
    // =========================
    //
    // createContext()の時点ではまだrefreshRelevantBrainMemory()が
    // 実行されていないため空配列で初期化する。runWorkflow()冒頭で
    // 実際の値に差し替わる(core/workflow/index.ts)。
    brainMemory: [],

    // =========================
    // Shared Evidence
    // =========================

    evidence: seedEvidence ?? [],

    // =========================
// Agent Handoffs
// =========================

handoffs: {},


    // =========================
    // Workflow State
    // =========================

    agentStatus: {},

    reviewHistory: [],

    logs: [],

    events: [],

  };

}