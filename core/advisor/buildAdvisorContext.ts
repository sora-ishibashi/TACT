// =========================
// buildAdvisorContext (STEP28)
// =========================
//
// Advisorへ渡すContextを、既存のConversationデータだけから組み立てる。
// 新しいDBテーブル・新しいEvidence保存機構は一切追加しない。
//
// 利用する既存データ:
// - conversation.currentOutput            (Writer出力、reconcile済み)
// - collectPastEvidence(conversation)      (STEP18で実装済み、
//                                            過去Turnの実Evidenceを
//                                            正規化して返す既存関数)
// - conversation.workflowRuns              (実行Agent・status・
//                                            started_at/completed_at・
//                                            error・Reviewer出力を含む)
// - conversation.messages                  (直近の会話)
//
// 既知の制約(正直に扱う):
// STEP31で、Workflow実行時の最終的なEvidenceスナップショット
// (core/conversation/index.tsが保存するEVIDENCE_SNAPSHOT_KEY)を
// collectPastEvidence()が優先的に使うようになったため、
// STEP31以降に生成されたTurnについては、section.evidenceIdsと
// 収集済みEvidenceのidが一致し、章ごとの正確な対応付けができる。
// ただし、STEP31より前に生成された古いConversationのTurnには
// このスナップショットが存在せず、idが再生成(不一致)となるため、
// その場合は「件数のみ」の情報にfallbackする(断定しない)。

import {
  Conversation,
  WorkflowRun,
  ConversationAttachment,
} from "../conversation/types";
import { Evidence } from "../context/types";
import {
  collectPastEvidence,
  EVIDENCE_SNAPSHOT_KEY,
} from "../conversation/collectPastEvidence";
import { ARTIFACT_TYPE_SNAPSHOT_KEY } from "../conversation/reconstructTask";

// =========================
// Turnの種類判定
// =========================
//
// core/conversation/reconstructTask.tsのcomposeTask()が実際に
// 埋め込む定型文言を手がかりにする(新しいフィールドを追加せず、
// 既存のrun.inputから判定するだけ)。betaUsageReport.tsと同じ考え方。

const FULL_REWRITE_MARKER =
  "今回の指示は成果物全体の構成を作り直すことを明確に求めています";

const TARGETED_MARKER =
  "現在の成果物に既に存在する章立て";

function classifyRunScope(
  input: string
): "全体書き直し" | "部分更新" | "新規生成/その他" {

  if (input.includes(FULL_REWRITE_MARKER)) return "全体書き直し";
  if (input.includes(TARGETED_MARKER)) return "部分更新";
  return "新規生成/その他";

}

interface ReviewerOutput {
  approved?: unknown;
  score?: unknown;
  issues?: unknown;
}

function formatReviewerVerdict(
  outputs: Record<string, unknown>
): string {

  const reviewer = outputs.reviewer as ReviewerOutput | undefined;

  if (!reviewer) {
    return "Reviewerは実行されていない";
  }

  const approved =
    typeof reviewer.approved === "boolean"
      ? reviewer.approved
      : "不明";

  const score =
    typeof reviewer.score === "number"
      ? reviewer.score
      : "不明";

  const issues =
    Array.isArray(reviewer.issues) && reviewer.issues.length > 0
      ? reviewer.issues.join(" / ")
      : "なし";

  return (
    `Reviewer判定: approved=${approved}, score=${score}, ` +
    `指摘事項=${issues}`
  );

}

function formatWorkflowRun(
  run: WorkflowRun,
  index: number
): string {

  // STEP31/36: EVIDENCE_SNAPSHOT_KEY・ARTIFACT_TYPE_SNAPSHOT_KEYは
  // Agentの出力ではないため、「実行されたAgent」一覧からは除外する。
  const agentsUsed =
    Object.keys(run.outputs ?? {}).filter(
      (key) =>
        key !== EVIDENCE_SNAPSHOT_KEY &&
        key !== ARTIFACT_TYPE_SNAPSHOT_KEY
    );

  const durationLabel =
    run.completedAt
      ? `${(
          (new Date(run.completedAt).getTime() -
            new Date(run.startedAt).getTime()) /
          1000
        ).toFixed(1)}秒`
      : "不明";

  return (
    `Turn${index + 1}: 状態=${run.status}` +
    ` / 種類=${classifyRunScope(run.input)}` +
    ` / 実行されたAgent=${agentsUsed.join(", ") || "なし"}` +
    ` / 実行時間=${durationLabel}` +
    (run.error ? ` / エラー: ${run.error}` : "") +
    ` / ${formatReviewerVerdict(run.outputs ?? {})}`
  );

}

interface OutputSection {
  heading?: unknown;
  evidenceIds?: unknown;
}

interface OutputShape {
  title?: unknown;
  executiveSummary?: unknown;
  sections?: unknown;
}

// STEP31: evidencePool(collectPastEvidence()の結果)とID照合できる
// 場合は、章ごとに実際のEvidence(claim/出典)を提示する。
// 照合できない場合(pre-STEP31データ等)は、件数のみのfallbackにする
// (断定的な対応付けを作り出さない)。
function formatSectionEvidenceDetail(
  currentOutput: unknown,
  evidencePool: Evidence[]
): string {

  if (!currentOutput || typeof currentOutput !== "object") {
    return "(成果物がまだ存在しません)";
  }

  const output = currentOutput as OutputShape;

  if (!Array.isArray(output.sections)) {
    return "(章構成を確認できません)";
  }

  const evidenceById = new Map(
    evidencePool.map((e) => [e.id, e])
  );

  return output.sections
    .map((section, index) => {

      const s = section as OutputSection;

      const heading =
        typeof s.heading === "string" ? s.heading : "(見出し未設定)";

      const ids =
        Array.isArray(s.evidenceIds)
          ? s.evidenceIds.filter(
              (id): id is string => typeof id === "string"
            )
          : [];

      if (ids.length === 0) {
        return `第${index + 1}章「${heading}」: 紐付けられたEvidenceなし`;
      }

      const matched = ids
        .map((id) => evidenceById.get(id))
        .filter((e): e is Evidence => !!e);

      if (matched.length === 0) {

        // idが一致しない(pre-STEP31データ等)場合は件数のみ。
        return (
          `第${index + 1}章「${heading}」: ` +
          `紐付けられたEvidence件数=${ids.length}` +
          `(個々の内容はこのConversationの記録からは特定できません)`
        );

      }

      const details = matched
        .map((e) => `${e.claim}(出典: ${e.source ?? "不明"})`)
        .join(" / ");

      return `第${index + 1}章「${heading}」: ${details}`;

    })
    .join("\n");

}

const MAX_RECENT_MESSAGES = 10;

// =========================
// 今回添付されたファイル (STEP32)
// =========================
//
// Advisorはワークフロー(seedEvidence/Evidence pool)を経由しないため、
// 今回のTurnで添付されたファイルの内容は、この関数の呼び出し元
// (runAdvisor.ts)から直接受け取り、ここでcontextへ追記する。
// 新しいEvidence保存機構は使わず、単純にテキストとして渡すだけ。
function formatAttachments(
  attachments?: ConversationAttachment[]
): string {

  if (!attachments || attachments.length === 0) {
    return "(今回のTurnでファイルは添付されていません)";
  }

  return attachments
    .map(
      (a) =>
        `--- ${a.fileName} ---\n` +
        (a.extractedText.trim() || "(内容を抽出できませんでした)")
    )
    .join("\n\n");

}

export function buildAdvisorContext(
  conversation: Conversation,
  attachments?: ConversationAttachment[]
): string {

  const parts: string[] = [];

  parts.push(
    "========================\n" +
    "今回添付されたファイル(このTurnでユーザーが新たに添付した資料。" +
    "根拠がここに存在しない場合は「添付資料からは確認できません」と" +
    "回答すること)\n" +
    "========================\n" +
    formatAttachments(attachments)
  );

  parts.push(
    "========================\n" +
    "現在の成果物(currentOutput)\n" +
    "========================\n" +
    JSON.stringify(conversation.currentOutput, null, 2)
  );

  // STEP18で実装済みのcollectPastEvidence()をそのまま再利用する。
  // STEP31でスナップショット保存に対応したことで、章ごとのID対応が
  // 可能な場合はそちらを使う(collectPastEvidence()側で吸収)。
  // 新しいEvidence収集・保存機構は作らない。
  const evidence = collectPastEvidence(conversation);

  parts.push(
    "========================\n" +
    "章ごとのEvidence対応(可能な場合は具体的な内容・出典。" +
    "対応付けできない場合は件数のみ)\n" +
    "========================\n" +
    formatSectionEvidenceDetail(conversation.currentOutput, evidence)
  );

  parts.push(
    "========================\n" +
    "このConversationで実際に収集されたEvidence(source列がURL形式の" +
    "場合、実際の一次情報源です。URLでない場合は出典の記述のみで、" +
    "URLは確認できていません)\n" +
    "========================\n" +
    (evidence.length > 0
      ? evidence
          .map(
            (e) =>
              `- [信頼度:${e.confidence}] ${e.claim}\n` +
              `  出典: ${e.source ?? "不明"}`
          )
          .join("\n")
      : "(このConversationでEvidenceは確認されていません)")
  );

  parts.push(
    "========================\n" +
    "Workflow実行履歴(このConversationの全Turn)\n" +
    "========================\n" +
    (conversation.workflowRuns.length > 0
      ? conversation.workflowRuns
          .map((run, index) => formatWorkflowRun(run, index))
          .join("\n")
      : "(実行履歴がありません)")
  );

  const recentMessages = conversation.messages
    .slice(-MAX_RECENT_MESSAGES)
    .map(
      (m) =>
        `${m.role === "user" ? "ユーザー" : "TACT"}: ${m.content}`
    )
    .join("\n");

  parts.push(
    "========================\n" +
    "直近の会話\n" +
    "========================\n" +
    (recentMessages || "(まだ会話はありません)")
  );

  return parts.join("\n\n");

}
