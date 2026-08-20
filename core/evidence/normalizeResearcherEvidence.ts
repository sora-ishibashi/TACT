// =========================
// normalizeResearcherEvidence (STEP18)
// =========================
//
// 背景:
// core/workflow/runAgent.tsは、Researcherの生出力(parsed.evidence =
// {market:[...], competitors:[...], ...}というカテゴリ別の生データ)を、
// Workflow実行中にcontext.evidence(Evidence[])へ変換・蓄積している。
// この変換ロジック(id発行・hash計算・confidence正規化)は
// runAgent.ts内にインラインで存在するのみで、外部から再利用できない。
//
// STEP18では、過去のConversation.workflowRuns[].outputs.researcher.evidence
// (=過去Turnで実際に保存されたResearcherの生出力)を、今回のWorkflow開始時に
// context.evidenceへ事前投入(seed)したい。そのためには、runAgent.tsと
// 同じ変換ロジックが必要になる。
//
// 重要な方針判断:
// runAgent.ts(core/workflow配下)を書き換えて共通化することもできるが、
// 今回のSTEPと無関係な既存コードのリファクタリングになり、
// 「依頼されたSTEPと無関係な変更はしない」という方針に反する。
// そのため、runAgent.ts側は一切変更せず、同等の変換ロジックを
// このファイルに独立して実装する(多少の重複は許容する)。
//
// 捏造禁止の原則:
// この関数は、渡された生データ(実際にResearcherが過去に返した内容)を
// そのまま変換するだけで、値を推測・生成しない。confidenceが数値で
// 存在しない場合は安全側(low)に倒す。sourceが存在しない場合は
// undefinedのまま(存在するように装わない)。

import { Evidence } from "../context/types";

function computeHash(record: Record<string, unknown>): string {

  const label =
    (record.claim ??
      record.name ??
      record.topic ??
      record.feature ??
      record.metric ??
      record.segment ??
      record.model ??
      record.headline ??
      "") as string;

  return (
    (typeof label === "string" ? label : "") +
    JSON.stringify(record)
  ).toLowerCase();

}

function toConfidenceLevel(
  value: unknown
): Evidence["confidence"] {

  if (typeof value !== "number") {
    return "low";
  }

  if (value >= 0.9) return "high";

  if (value >= 0.7) return "medium";

  return "low";

}

function toSource(
  record: Record<string, unknown>
): string | undefined {

  if (Array.isArray(record.sources)) {

    return record.sources
      .filter((s): s is string => typeof s === "string")
      .join(", ");

  }

  const raw = record.sources ?? record.source;

  return typeof raw === "string" ? raw : undefined;

}

function toClaim(
  record: Record<string, unknown>
): string {

  const label =
    record.claim ??
    record.name ??
    record.topic ??
    record.feature ??
    record.metric ??
    record.segment ??
    record.model ??
    record.headline;

  return typeof label === "string" && label.trim()
    ? label
    : "Unknown";

}

// rawEvidence: Researcherの生出力(parsed.evidence)。
// 形が期待通りでない場合は空配列を返す(捏造しない)。
//
// existingHashes: 呼び出し元(複数Turn分をまとめて処理する場合)が
// 既に採用したhashの集合。渡された場合、重複するEvidenceは
// スキップする。呼び出し元がSetを使い回すことで、Turnをまたいだ
// 重複除去ができる。

export function normalizeResearcherEvidence(
  rawEvidence: unknown,
  existingHashes: Set<string> = new Set()
): Evidence[] {

  const result: Evidence[] = [];

  if (
    !rawEvidence ||
    typeof rawEvidence !== "object"
  ) {
    return result;
  }

  const categories = rawEvidence as Record<string, unknown>;

  for (const category of Object.keys(categories)) {

    const items = categories[category];

    if (!Array.isArray(items)) continue;

    for (const item of items) {

      if (
        !item ||
        typeof item !== "object"
      ) {
        continue;
      }

      const record = item as Record<string, unknown>;

      const hash = computeHash(record);

      if (existingHashes.has(hash)) continue;

      existingHashes.add(hash);

      result.push({

        id: crypto.randomUUID(),

        claim: toClaim(record),

        evidence: JSON.stringify(record),

        source: toSource(record),

        confidence: toConfidenceLevel(record.confidence),

        score: 0,

        hash,

        createdBy: "researcher",

        createdAt: Date.now(),

        tags: [category],

        references: [],

      });

    }

  }

  return result;

}
