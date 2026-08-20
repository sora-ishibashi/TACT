// =========================
// collectPastEvidence (STEP18, STEP31で拡張)
// =========================
//
// 背景:
// Conversationの2Turn目以降、Workflowは毎回context.evidence = []
// (core/context/index.tsのcreateContext())から開始しており、
// 過去TurnでResearcherが収集したEvidenceは一切引き継がれていなかった。
// そのため、部分更新のたびにResearcherが同じ情報をゼロから
// 調べ直す必要があった。
//
// 本モジュールの役割は、conversation.workflowRuns(既に保存済みの
// 過去の実行結果)から、過去に実際に収集されたEvidenceを取り出し、
// runWorkflow()へ「今回の初期Evidence pool」として渡せる形
// (Evidence[])に変換することだけ。
//
// 重要: ここでは新しいDBカラム・永続化構造は一切追加しない。
// conversation.workflowRuns[]に既に保存されているデータのみを
// 再利用する(捏造しない)。
//
// STEP31: run.outputs[EVIDENCE_SNAPSHOT_KEY]
// (core/conversation/index.tsが保存する、そのRunの最終的な
// context.evidenceのスナップショット。Tool(web-search)の生の
// 検索結果から自動生成されたEvidence(source=実URL)も含む)が
// 存在する場合は、そちらを優先して使う。これはResearcherが
// 自分の言葉で要約し直す前の、より正確な情報(実URL等)を保持して
// いるため。STEP31より前に保存された古いWorkflowRunには
// このキーが存在しないため、従来どおりrun.outputs.researcher.evidence
// (Researcher自身の生出力)から再構築する経路にfallbackする
// (後方互換。過去の会話データを壊さない)。

import { Conversation, WorkflowRun } from "./types";
import { Evidence } from "../context/types";
import { normalizeResearcherEvidence } from "../evidence/normalizeResearcherEvidence";

// core/conversation/index.tsと共有する、Evidenceスナップショットの
// 保存先キー名。Agent出力と混同されないよう、他のAgentId
// ("researcher"等)と衝突しない名前にしている。
// betaUsageReport.ts・core/advisor/buildAdvisorContext.tsが
// 「実行されたAgent一覧」を outputs のキーから求める際は、
// このキーを除外すること。
export const EVIDENCE_SNAPSHOT_KEY = "__evidence";

// 過去に遡って参照するWorkflowRunの上限。
// 会話が長くなるほど無制限に遡ると、prompt肥大化・評価コスト増に
// つながるため、直近の完了Runに絞る。
const MAX_PAST_RUNS = 5;

// 収集するEvidence件数の上限。
// 実際にWriter/Researcherへ見せる件数はselectEvidence()側で
// (queryとの関連度で)さらに絞られるため、ここでは「候補pool」の
// 上限として安全側に大きめの値を設定する。
const MAX_SEED_EVIDENCE = 80;

function isValidEvidence(value: unknown): value is Evidence {

  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).claim === "string"
  );

}

// STEP31: run.outputs[EVIDENCE_SNAPSHOT_KEY]から、既に構築済みの
// Evidence[]をそのまま取り出す(再normalize不要=IDも実URLも
// 保存時点の値のまま利用できる)。
function collectFromSnapshot(
  run: WorkflowRun,
  seenHashes: Set<string>
): Evidence[] {

  const snapshot =
    run.outputs[EVIDENCE_SNAPSHOT_KEY];

  if (!Array.isArray(snapshot)) return [];

  const result: Evidence[] = [];

  for (const item of snapshot) {

    if (!isValidEvidence(item)) continue;

    const hash =
      typeof item.hash === "string" ? item.hash : item.id;

    if (seenHashes.has(hash)) continue;

    seenHashes.add(hash);

    result.push(item);

  }

  return result;

}

export function collectPastEvidence(
  conversation: Conversation
): Evidence[] {

  const recentRuns = conversation.workflowRuns
    .filter((run) => run.status === "completed")
    .slice(-MAX_PAST_RUNS);

  const seenHashes = new Set<string>();
  const collected: Evidence[] = [];

  // 直近のRunを優先して採用したいため、新しい順(配列末尾から)に処理する。
  for (let i = recentRuns.length - 1; i >= 0; i--) {

    const run = recentRuns[i];

    if (run.outputs[EVIDENCE_SNAPSHOT_KEY]) {

      // STEP31: 新しい保存形式(スナップショット)が存在する場合は
      // こちらを優先する。
      collected.push(
        ...collectFromSnapshot(run, seenHashes)
      );

    } else {

      // 後方互換: STEP31より前に保存されたRunにはスナップショットが
      // 存在しないため、従来どおりResearcher自身の生出力から
      // 再構築する。
      const researcherOutput = run.outputs.researcher as
        | { evidence?: unknown }
        | undefined;

      if (!researcherOutput?.evidence) continue;

      const normalized = normalizeResearcherEvidence(
        researcherOutput.evidence,
        seenHashes
      );

      collected.push(...normalized);

    }

    if (collected.length >= MAX_SEED_EVIDENCE) break;

  }

  return collected.slice(0, MAX_SEED_EVIDENCE);

}
