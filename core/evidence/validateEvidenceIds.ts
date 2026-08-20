import { Evidence } from "../context/types";

// =========================
// Agent出力の型
// =========================
//
// Analyst/WriterはいずれもLLMが生成するJSONであり、フィールドの
// 厳密な形は core/prompt/outputFormats.ts の各エントリが定義している。
// ここでは検証に必要な最小限の形(evidenceIdsを持つ項目の配列)だけを
// 構造的に表現し、それ以外のフィールドは unknown のまま保持する。
//
// STEP66: 型名は歴史的経緯でAnalystOutputのままだが、構造は
// 「evidenceIdsを持つ項目配列をトップレベルに複数持つJSON」という
// Analyst固有ではない汎用形であるため、Writer出力(sections[])の
// 検証にもそのまま再利用できる。

export interface EvidenceReferencingItem {
  evidenceIds?: unknown;
  [key: string]: unknown;
}

export interface AnalystOutput {
  insights?: EvidenceReferencingItem[];
  comparisons?: EvidenceReferencingItem[];
  opportunities?: EvidenceReferencingItem[];
  risks?: EvidenceReferencingItem[];
  recommendations?: EvidenceReferencingItem[];
  [key: string]: unknown;
}

export interface ValidateEvidenceIdsResult {
  cleaned: AnalystOutput;
  issues: string[];
}

// Analyst呼び出し(fields省略時)のデフォルト対象フィールド。
// 既存呼び出し元(Analyst)の挙動は変更しない。
const DEFAULT_VALIDATED_FIELDS = [
  "insights",
  "comparisons",
  "opportunities",
  "risks",
  "recommendations",
] as const;

// Evidence.id はcrypto.randomUUID()が生成する標準的なUUID形式
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =========================
// validateEvidenceIds
// =========================
//
// 責務:
// parsed内の対象フィールド(省略時はinsights/comparisons/opportunities/
// risks/recommendations、Analystのデフォルト)それぞれについて、
// evidenceIds配列の中身が
//   1. 配列であること
//   2. 各要素がUUID形式の文字列であること
//   3. そのUUIDが、今回のAgent実行時に渡されたEvidence pool(pool引数)に
//      実在すること
// を機械的に確認し、いずれかを満たさない値だけをevidenceIdsから除去する。
//
// 項目(insight/opportunity/risk/section等)そのものは削除しない。
// 件数・論点の重複といった意味的な判断はここでは行わない。
// 副作用を持たない純粋関数として実装する。
//
// STEP66: 第3引数fieldsを追加。省略時はDEFAULT_VALIDATED_FIELDS
// (=従来通りのAnalyst向け5フィールド)を使うため、既存呼び出し元
// (Analyst)の挙動・戻り値は一切変わらない。Writer向けにはrunAgent.ts側
// から ["sections"] を明示的に渡す。

export function validateEvidenceIds(
  parsed: AnalystOutput,
  pool: Evidence[],
  fields: readonly string[] = DEFAULT_VALIDATED_FIELDS
): ValidateEvidenceIdsResult {

  const poolIds = new Set(
    pool.map((e) => e.id)
  );

  const issues: string[] = [];

  const cleaned: AnalystOutput = {
    ...parsed,
  };

  for (const field of fields) {

    const items = parsed[field];

    if (!Array.isArray(items)) continue;

    cleaned[field] = items.map(
      (item, index) => {

        if (
          item === null ||
          typeof item !== "object"
        ) {
          return item;
        }

        const evidenceIds =
          (item as EvidenceReferencingItem)
            .evidenceIds;

        if (!Array.isArray(evidenceIds)) {

          if (evidenceIds !== undefined) {

            issues.push(
              `${field}[${index}].evidenceIds is not an array: ${JSON.stringify(
                evidenceIds
              )}`
            );

          }

          return item;

        }

        const validIds: unknown[] = [];

        for (const id of evidenceIds) {

          if (
            typeof id !== "string" ||
            !UUID_PATTERN.test(id)
          ) {

            issues.push(
              `${field}[${index}].evidenceIds contains a non-UUID value: ${JSON.stringify(
                id
              )}`
            );

            continue;

          }

          if (!poolIds.has(id)) {

            issues.push(
              `${field}[${index}].evidenceIds contains an ID not present in the evidence pool: ${id}`
            );

            continue;

          }

          validIds.push(id);

        }

        // 除去対象が無ければ元の項目をそのまま返す(内容を変更しない)
        if (validIds.length === evidenceIds.length) {
          return item;
        }

        return {
          ...item,
          evidenceIds: validIds,
        };

      }
    );

  }

  return {
    cleaned,
    issues,
  };

}
