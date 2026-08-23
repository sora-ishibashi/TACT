import type { Task, TaskExecutionSummary } from "./task";
import type {
  OrchestrationRequest,
  OrchestrationResult,
  MemoryReference,
  ToolExecutionSummary,
} from "./types";
import type { MemoryWriteOutcome } from "./memoryWriter";
import type { Provider } from "../agent/types";

// =========================
// Episode (Phase 11 — 調査の結論として最小骨格のみ実装)
// =========================
//
// 本Phaseの調査結論(詳細はPhase 11完了報告を参照):
//   Episode = 「1回のユーザー依頼に対して、TACTが何をしたかの記録」
//   Memory  = 「その記録のうち、将来も覚えておく価値があると判断された
//              一部」(既存のMemoryCandidate/MemoryPolicy/MemoryWriterが
//              既に担う責務、Phase 5)
// この2つは意図的に分離されたまま残す(絶対条件: Episode全体を無条件で
// Memoryへ格上げしない)。EpisodeはMemoryCandidateBuilderへの新しい
// 入力経路にはまだ接続しない(Phase 12以降の検討候補として報告のみ)。
//
// 永続化しない(絶対条件2・14: 新規DBテーブルを勝手に追加しない、DB/
// migration/RLS変更は必要性が実証されるまで行わない)。ここにあるのは
// 「既にOrchestratorが実行の過程で持っている情報を、1つの一貫した
// 形へ束ねるだけ」の純粋関数であり、EpisodeをどこかへWriteする処理は
// 一切持たない。呼び出し元(将来のログ基盤・Phase 12のPersistence層等)
// が、この関数の戻り値を必要に応じて保存するかどうかを決める。
//
// 既存データからの再構成可能性(Step1/5の調査結果): 現在の
// runOrchestration()の公開契約(OrchestrationResult)には、実行開始時刻
// (startedAt、内部ではdurationMsの差分計算にのみ使われ外部へ露出しない)
// と、Decomposerが計画したTask[](Task.description/dependencies等の
// 「計画」情報。公開契約上はTaskExecutionSummary[]という「結果」しか
// 見えない)の2つが欠落している。この2つは呼び出し元が別途保持して
// いる場合のみ引数として補える形にし(plannedTasks/timestampを省略可能
// パラメータとする)、既存のcommander.ts・OrchestrationResult型は
// 一切変更しない(絶対条件: 既存コードを大規模に変更しない、Commander
// の構造変更をしない)。
export interface Episode {

  // OrchestrationResult.executionIdをそのまま使う(新しいID体系を
  // 増やさない)。
  episodeId: string;

  userId?: string;

  // ISO 8601文字列。呼び出し元がcommander.ts内部の実行開始時刻を
  // 別途保持していればそれを渡せる(省略可能引数)。省略時はこの関数の
  // 呼び出し時刻で代用する(実行開始時刻の近似値であり、真の開始時刻
  // ではないことをコメントで明示する。既存契約に無い値を推測で
  // 埋めない、というPhase 8以来の方針に基づき、この近似の性質を
  // metadata.timestampIsApproximateで機械的に判別可能にする)。
  timestamp: string;

  timestampIsApproximate: boolean;

  goal: string;

  // Decomposerが計画したTaskの最小限の情報(id/description/
  // assignedCapability/dependencies)。呼び出し元がdecomposeTask()の
  // 結果を別途保持している場合のみ渡せる。現状の公開APIだけでは
  // 取得不能なため省略可能とする(Step1の調査結果、無理に補わない)。
  plannedTasks?: {
    id: string;
    description: string;
    assignedCapability?: string;
    dependencies?: string[];
  }[];

  // 実行結果(何が起きたか)。既存TaskExecutionSummary型をそのまま
  // 再利用する(新しい型を作らない)。
  taskResults: TaskExecutionSummary[];

  outcome: {

    answer: string;

    executionMode: string;

    // 全Taskが完了したかどうか。既存のstatusフィールドから機械的に
    // 導出するだけで、成功/失敗の意味を新しく判定するロジックは
    // 持たない(絶対条件7: LLMを使わない決定論的な構成)。
    allTasksCompleted: boolean;

  };

  toolsUsed: ToolExecutionSummary[];

  // 実際にCoreから使われたMemory参照(既存MemoryReference型のまま)。
  memoryUsed: MemoryReference[];

  // このEpisodeの結果、Coreへの書き込みが試行されたMemory Candidateの
  // 一覧(採用・却下・失敗を問わず、既存MemoryWriteOutcome型のまま)。
  memoryWrites: MemoryWriteOutcome[];

  metadata: {

    durationMs?: number;

    provider?: Provider;

    model?: string;

  };

}

export interface BuildEpisodeOptions {

  // Decomposerの計画情報(省略可能、Step1参照)。
  plannedTasks?: Task[];

  // 実行開始時刻(ISO 8601)。呼び出し元がcommander.ts相当の処理で
  // 保持している場合のみ渡す。省略時はこの関数の呼び出し時刻を
  // 近似値として使う(Episode.timestampIsApproximate=trueとなる)。
  timestamp?: string;

}

// =========================
// buildEpisode
// =========================
//
// 純粋関数。DBアクセス・LLM呼び出し・ネットワークI/Oを一切行わない
// (絶対条件4・7)。OrchestrationRequest(何を頼まれたか)と
// OrchestrationResult(何をしたか)という、runOrchestration()の入力・
// 出力として既に存在する2つのオブジェクトを、1つの一貫した記録へ
// 束ねるだけ。
export function buildEpisode(
  request: OrchestrationRequest,
  result: OrchestrationResult,
  options?: BuildEpisodeOptions
): Episode {

  const timestampIsApproximate = !options?.timestamp;

  return {

    episodeId: result.executionId,

    userId: request.userId,

    timestamp: options?.timestamp ?? new Date().toISOString(),

    timestampIsApproximate,

    goal: request.input,

    plannedTasks: options?.plannedTasks?.map((task) => ({
      id: task.id,
      description: task.description,
      assignedCapability: task.assignedCapability,
      dependencies: task.dependencies,
    })),

    taskResults: result.tasks,

    outcome: {

      answer: result.answer,

      executionMode: result.metadata.executionMode,

      allTasksCompleted: result.tasks.every(
        (task) => task.status === "completed"
      ),

    },

    toolsUsed: result.toolsUsed,

    memoryUsed: result.memoryUsed,

    memoryWrites: result.memoryWrites,

    metadata: {

      durationMs: result.metadata.durationMs,

      provider: result.metadata.provider,

      model: result.metadata.model,

    },

  };

}
