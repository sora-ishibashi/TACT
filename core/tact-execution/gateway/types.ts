// =========================
// TACT Canonical Execution — Generic Observation Gateway Types (SOR-129)
// =========================
//
// 背景 (SOR-129): core/tact-execution/adapters/notion/observeNotionMcpExecution.ts
// が確立したorchestration(normalize結果を受け取ってからcapture→
// permission→correlationを呼び、失敗を隔離・記録する)は、実際には
// provider中立なロジックだった——Notion固有だったのは入力型と
// normalizer自身だけ。このfileはそのorchestrationの契約面だけを抽出する
// (Notionの実装を壊して作り直すのではない、絶対条件)。
//
// Build less. Orchestrate more: 新しいCanonical Execution/Outcome schema
// は一切作らない。既存のCaptureExecutionInput/CanonicalExecution/
// ExecutionAdapterNormalizeResult/IngestionFailureStageをそのまま
// destination契約として再利用する。

import type { CaptureExecutionOutcome } from "../store";
import type { PersistPermissionDecisionOutcome } from "../permission";
import type { ObserveExecutionWorkCorrelationOutcome } from "../correlation";
import type { CanonicalExecution, CaptureExecutionInput, ExecutionProvider } from "../types";
import type { ExecutionAdapterNormalizeResult } from "../adapters/types";
import type { IngestionFailureStage, RecordIngestionFailureInput } from "../telemetry/ingestionFailureStore";

export type { ExecutionAdapterNormalizeResult, IngestionFailureStage };

// normalizationが失敗した時点ではCaptureExecutionInputがまだ存在しない
// ため、failure報告に必要な最小限のsource identityを呼び出し元
// (provider固有のwrapper)が独立して渡す——観測できない経路も
// 「どのprovider/tenant/connectionで観測しようとして失敗したか」だけは
// 記録できるようにする(observeNotionMcpExecution.tsの既存動作と同じ)。
export interface ObservationSource {

  userId: string;

  provider: ExecutionProvider;

  connectionId: string | null;

  adapterVersion: string;

}

// SOR-129: observeNotionMcpExecution.tsの既存ObserveNotionMcpExecutionDeps
// と構造的に同一(絶対条件、Notionの現行Reality Test behaviorを維持する
// ため、既存depsのshapeを変えない)。captureExecution/
// observeExecutionPermission/observeExecutionWorkCorrelationはいずれも
// 元々CanonicalExecution/CaptureExecutionInputという中立契約だけを
// 受け渡す関数であり、provider固有の型を一切含まない——ここに移しても
// 意味は変わらない。
//
// Outcome assertion(SOR-119)はこのGatewayの自動flowには含めない
// (絶対条件: migrationは原則不要)。既存のtact_execution_ingestion_
// failures.stage CHECK制約は4値(normalization/capture/
// permission_evaluation/work_correlation)のみを許容しており、Outcome
// assertion stage向けのfailure telemetryを追加するには制約拡張
// migrationが必要になる。SOR-119時点でどのadapterもOutcomeを
// assertしていない(genuineな確認signalが無い)ため、今この段階で
// 使われないstageのためだけにmigrationを追加しない——将来、実際に
// outcomeを主張できるproviderが現れた時点で、必要なら追加する
// (Never Guess Rule/最小追加の原則)。
export interface ObserveCanonicalExecutionDeps {

  captureExecution: (input: CaptureExecutionInput) => Promise<CaptureExecutionOutcome>;

  observeExecutionPermission: (execution: CanonicalExecution) => Promise<PersistPermissionDecisionOutcome>;

  observeExecutionWorkCorrelation: (execution: CanonicalExecution) => Promise<ObserveExecutionWorkCorrelationOutcome>;

  onFailure: (stage: IngestionFailureStage, error: unknown) => void;

  recordIngestionFailure?: (input: RecordIngestionFailureInput) => Promise<void>;

}
