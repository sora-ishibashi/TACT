// =========================
// TACT Code — 型定義(STEP142)
// =========================
//
// TACT Codeは、core/brain/claudeCodeInstruction.tsが生成した
// Instructionを「実際のCoding Agent実行」へ接続するための、
// Core/Brainとは独立した新しいモジュール(core/codeAgent/)。
//
// 設計原則(STEP142-B):
// - TACT Code自身は特定のCoding Agent実装に依存しない。
//   実行エンジンは CodingAgentAdapter という交換可能な境界の
//   向こう側に置く(今回はClaudeCodeAdapterのみ実装)。
// - core/llm(既存のLLM Provider抽象化、Agent実行が使うOpenAI等の
//   テキスト生成API)とは別物として扱う。Claude Code CLIは
//   「テキスト生成」ではなく「外部プロセスとしてコードを変更する
//   実行エンジン」であり、既存のLLMRequest/runLLM()の型には
//   乗せない(無理に共通化しない)。
// - 完全自律実行は行わない。ready_for_approval → approved の
//   遷移は人間の操作でのみ起こる(STEP142-C)。

// STEP143-B: Preflight Safety Gate / Evaluation / Rollbackのために
// 状態を追加する。既存の値(draft〜failed)は変更しない
// (既存API・既存Taskとの互換性を維持するため)。
//
//   approved
//     ↓
//   preflight_check   … Clean Repository Gate。dirtyならblockedへ
//     ↓
//   running           … ClaudeCodeAdapter.execute()
//     ↓
//   testing           … npx tsc --noEmit
//     ↓
//   evaluating        … before/after比較(可能な場合のみ)
//     ↓
//   completed / failed / blocked / requires_human_review / rolled_back
//
// STEP144-D: "rolled_back"を追加する。scope_violation/dangerous_change/
// test失敗/degraded evaluationが発生し、かつRollbackが実際に成功した
// 場合はこの状態にする("failed"よりも「元に戻せた」ことが明確に
// 伝わるため)。Rollbackが行えなかった、または部分的にしか
// 成功しなかった場合は引き続き"failed"/"requires_human_review"のまま
// とし、人間による確認を促す。
export type CodeTaskStatus =
  | "draft"
  | "ready_for_approval"
  | "approved"
  | "preflight_check"
  | "running"
  | "testing"
  | "evaluating"
  | "completed"
  | "failed"
  | "blocked"
  | "requires_human_review"
  | "rolled_back";

// 将来、承認方針を切り替えられるようにするための独立した軸。
// 今回のAPIはexecutionPolicyの値に関わらず、実際には常に
// human_approval_required相当の挙動(approve APIを経由しない限り
// 実行しない)のみを実装する。auto_approve/safe_modeは型として
// 用意するだけで、今回はどこからも自動選択しない。
export type ExecutionPolicy =
  | "human_approval_required"
  | "auto_approve"
  | "safe_mode";

export interface CodeTaskTestResult {
  typecheckPassed: boolean;
  typecheckExitCode: number | null;
  // 出力全体を保持すると肥大化するため、先頭部分のみ保持する
  // (core/prompt/builder.tsのTOOL_RESULT_SNIPPET_LENGTHと同じ考え方)。
  typecheckOutput: string;
}

export interface CodeTaskExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  changedFiles: string[];
  durationMs: number;
  timedOut: boolean;
}

// =========================
// Checkpoint(STEP143-B: A. Git Checkpoint機構)
// =========================
//
// TACT Code自身は既存の未コミット変更を勝手にcommitしない
// (それ自体がリスクのある操作のため)。代わりに、実行直前の状態を
// 「読み取るだけ」で記録し、Rollback時にファイル単位で内容を
// 復元するための材料として使う。

export interface CodeTaskCheckpoint {
  branch: string;
  headCommit: string;
  // `git status --porcelain`の生出力。対象ファイル・対象外ファイルの
  // 「実行前から既にdirtyだったか」をRollback時に判定するために使う。
  gitStatusPorcelain: string;
  // targetFilesそれぞれの実行直前の内容(ファイルが存在しない場合は
  // undefinedではなくnullを保持し、「新規作成予定だった」ことを
  // 区別できるようにする)。
  targetFileContents: Record<string, string | null>;
  capturedAt: string;
}

// =========================
// Change Scope Gate(STEP143-B: D)
// =========================

export interface CodeTaskScopeCheck {
  targetFiles: string[];
  changedFiles: string[];
  // targetFilesに含まれない変更ファイル。
  violationFiles: string[];
}

// =========================
// Dangerous Change Detection(STEP143-B: E)
// =========================

export interface CodeTaskDangerousChangeCheck {
  flaggedFiles: string[];
  // どのパターンに一致したか(人間が確認しやすいように)。
  reasons: string[];
}

// =========================
// Evaluation(STEP143-B: F/G)
// =========================
//
// 「同じAgent構成でWorkflowを再実行し、Evidence件数・Reviewer
// issue数・quality scoreを比較する」ためには、再現可能な
// userInput/modeが必要。既存のImprovementProposalはこれを
// 保持していないため、CodeTask作成時に明示的に指定された場合のみ
// (evaluationTask)実施する。指定が無い場合はinconclusiveとする
// (存在しないデータを捏造しない)。

export interface CodeTaskEvaluationTask {
  userInput: string;
  mode: "quick" | "think" | "deep";
}

export interface CodeTaskEvaluationMetrics {
  evidenceCount: number;
  reviewerIssueCount: number;
  qualityScore: number | null;
}

export type CodeTaskEvaluationClassification =
  | "improved"
  | "unchanged"
  | "degraded"
  | "inconclusive";

export interface CodeTaskEvaluation {
  before: CodeTaskEvaluationMetrics | null;
  after: CodeTaskEvaluationMetrics | null;
  classification: CodeTaskEvaluationClassification;
  // inconclusiveの場合、なぜ比較できなかったかを人間に伝えるため。
  reason?: string;
}

// =========================
// Rollback(STEP143-B: H)
// =========================

export interface CodeTaskRollbackFileResult {
  file: string;
  method: "restored_from_checkpoint" | "git_checkout_clean" | "unavailable";
  success: boolean;
  detail?: string;
}

export interface CodeTaskRollbackResult {
  attempted: boolean;
  success: boolean;
  files: CodeTaskRollbackFileResult[];
  detail: string;
}

// =========================
// Git連携(STEP144-C/E/F)
// =========================
//
// core/codeAgent/gitProvider.tsのGitProvider実装が返す結果を、
// CodeTaskへ保存するための型。gitProvider.ts側の型と意図的に
// 分けている(types.ts ⇔ gitProvider.tsの循環importを避けるため。
// 形は概ね対応している)。

export interface CodeTaskCommitResult {
  success: boolean;
  sha?: string;
  message: string;
  detail: string;
}

export interface CodeTaskPushResult {
  attempted: boolean;
  success: boolean;
  detail: string;
  requiresExternalAuth?: boolean;
}

export interface CodeTaskPullRequestResult {
  attempted: boolean;
  success: boolean;
  url?: string;
  detail: string;
  requiresExternalAuth?: boolean;
}

export interface CodeTask {
  id: string;

  // core/brain/memory.tsのStoredImprovementProposal.id。
  proposalId: string;

  status: CodeTaskStatus;

  executionPolicy: ExecutionPolicy;

  // 実行対象のリポジトリ(今回は単一リポジトリ前提。プロジェクト
  // ルートのみを扱う。マルチリポジトリ対応は今回のスコープ外)。
  repositoryPath: string;

  // core/brain/claudeCodeInstruction.tsのbuildClaudeCodeInstruction()
  // が生成したMarkdown全文。
  instruction: string;

  // claudeCodeInstruction.tsのguessTargetFiles()が推定したファイル一覧
  // (「これだけを変更してよい」という人間向けの参考情報。
  // Adapter自体はこれを強制はしない)。
  targetFiles: string[];

  timeoutMs?: number;

  // STEP144-B: どのCodingAgentProviderで実行するか
  // (core/codeAgent/adapterRegistry.ts)。省略時は"claude-code"。
  codingAgentProviderId?: string;

  // STEP144-E: trueの場合、実行前にFeature Branchを作成し、
  // そのBranch上でCoding Agentを実行する(Productionブランチを
  // 直接変更しない)。省略時(false相当)は、STEP143-Bまでと同じく
  // 現在のBranch上で直接実行する(既存Taskとの後方互換を維持する
  // ためのデフォルト)。
  useBranch?: boolean;
  branchName?: string;

  // STEP143-B: Evaluation(F/G)を行うための、再現可能なWorkflow入力。
  // 省略時はEvaluationをinconclusiveとする(存在しないbefore/after
  // データを捏造しない)。
  evaluationTask?: CodeTaskEvaluationTask;

  createdAt: string;
  updatedAt: string;
  approvedAt?: string;

  checkpoint?: CodeTaskCheckpoint;

  execution?: CodeTaskExecutionResult;
  test?: CodeTaskTestResult;
  scopeCheck?: CodeTaskScopeCheck;
  dangerousChangeCheck?: CodeTaskDangerousChangeCheck;
  evaluation?: CodeTaskEvaluation;
  rollback?: CodeTaskRollbackResult;

  // STEP144-F: completed後、人間が別途/commit・/pushを呼んだ場合の結果。
  // executeの時点では設定されない(Human Approvalを介した別ゲート)。
  commitCandidate?: {
    files: string[];
    diff: string;
    suggestedMessage: string;
  };
  gitCommit?: CodeTaskCommitResult;
  gitPush?: CodeTaskPushResult;
  gitPullRequest?: CodeTaskPullRequestResult;

  // status が blocked / failed / requires_human_review になった理由
  // (人間向けの短い説明)。
  blockedReason?: string;

  error?: string;
}

// =========================
// CodingAgentAdapter(交換可能な実行エンジン境界)
// =========================
//
// TACT Code
//   ↓
// CodingAgentAdapter
//   ├─ ClaudeCodeAdapter(今回実装)
//   ├─ Codex(将来)
//   └─ その他Coding Agent(将来)

export interface CodingAgentAdapter {
  readonly id: string;

  // 実行環境でこのAdapterが実際に呼び出し可能かを、副作用なしで確認する。
  isAvailable(): Promise<{
    available: boolean;
    detail: string;
  }>;

  // status === "approved" のCodeTaskのみを受け付ける
  // (未承認Taskの実行を拒否する安全弁。呼び出し側のガードとは別に、
  // Adapter自身も必ずこのチェックを行う)。
  execute(
    task: CodeTask
  ): Promise<CodeTaskExecutionResult>;
}
