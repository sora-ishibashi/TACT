import type {
  ArtifactBlock,
  ChartBlock,
  EvidenceBlock,
  ExampleBlock,
  FindingBlock,
  HypothesisBlock,
  RecommendationBlock,
  ResearchSummaryBlock,
  TableBlock,
  TextBlock,
} from "./types";

// =========================
// TACT Artifact — Block Construction / Adapter (Phase 76)
// =========================
//
// Section16の絶対条件: すべて決定論的な純粋関数(DB/LLM/Search API
// 呼び出しを一切含まない)。core/tact-conversation/artifactMutation.ts
// (Phase75、同じ「実LLM呼び出しは一切行わない」方針)と同じ設計思想を
// Block構築ロジックにも適用する。Table/Chartは「既存の構造化Blockから
// 決定論的に導出する」(Section7の例: Example Block→Table Block、
// Table Block→Chart Block)ことで、新しいLLM呼び出しを追加せずに
// Section9の要求(Evidence等をArtifactへ実際に利用できる形で渡す)を
// 満たす。

// core/tact-artifact/store.tsの既存パターン(crypto.randomUUID())を
// そのまま踏襲する。表示順はid自体ではなくorderフィールドで表現する
// (Block生成関数の呼び出し元がnextOrder()で算出して渡す)。
function nextBlockId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

// =========================
// Block生成(単発)
// =========================

export function createTextBlock(content: string, order: number, title?: string): TextBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "text",
    title,
    content,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

export function createResearchSummaryBlock(
  content: string,
  order: number,
  title?: string
): ResearchSummaryBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "research_summary",
    title,
    content,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

export function createFindingBlock(content: string, order: number, title?: string): FindingBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "finding",
    title,
    content,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

export function createEvidenceBlock(
  params: {
    claim: string;
    source?: string;
    confidence?: "low" | "medium" | "high";
    data?: string;
  },
  order: number
): EvidenceBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "evidence",
    claim: params.claim,
    source: params.source,
    confidence: params.confidence,
    data: params.data,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

// Phase79: fieldsは元々型定義(core/tact-artifact/types.ts)には存在した
// が、この関数がsummaryしか受け取らなかったため一度も設定されて
// いなかった(Repository Evidence、Phase79 Root Cause調査で確認)。
// 呼び出し元(core/tact-conversation/orchestration.ts)が
// parseStructuredEntitiesFromText()でEntityごとのfieldsを決定論的に
// 抽出できた場合に、ここで初めて実際に設定する。
export function createExampleBlock(
  summary: string,
  order: number,
  title?: string,
  // Phase90: fields[i].sourceEvidenceIds(field=Attribute単位の
  // Evidence対応)をoptionalで受け取れるようにする(型の拡張のみ、
  // 既存呼び出し元は省略したまま呼べる)。
  fields?: { label: string; value: string; sourceEvidenceIds?: string[] }[],
  sourceEvidenceIds?: string[]
): ExampleBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "example",
    title,
    summary,
    fields,
    sourceEvidenceIds,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

export function createRecommendationBlock(
  content: string,
  order: number,
  title?: string
): RecommendationBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "recommendation",
    title,
    content,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

export function createHypothesisBlock(
  content: string,
  order: number,
  title?: string
): HypothesisBlock {

  const now = nowIso();

  return {
    id: nextBlockId(),
    type: "hypothesis",
    title,
    content,
    order,
    createdAt: now,
    updatedAt: now,
  };

}

// =========================
// Table Block: 既存Blockからの決定論的構築・更新
// =========================
//
// Section7「事例を表にまとめて」→既存Example Blockを参照してTable
// Blockを生成、Section10「Table→実際のHTML tableとして表示」に対応
// するデータ構造をここで組み立てる。ExampleがなければEvidenceから、
// どちらも無ければ空のTableは作らずnullを返す(呼び出し元が安全側
// フォールバックを選べるようにする)。

const EXAMPLE_TABLE_COLUMNS = ["事例", "詳細"];
const EVIDENCE_TABLE_COLUMNS = ["主張", "出典", "確信度"];

// Phase79: classifyTablePurpose()が"evidence"と判定した場合
// (「根拠を表にして」「出典を一覧にして」等)の専用経路になった
// (core/tact-conversation/orchestration.ts参照)。「比較表」用の
// Row Entity中心のTable構築はbuildComparisonTableFromBlocks()
// (下記)が別途担う——両者を混同しないためにPhase79で分離した
// (Root Cause: 以前はこの1関数だけがTable生成全体を担っており、
// Example/Evidenceのどちらがたまたま存在するかで列が変わってしまい
// ユーザー指定の比較軸を反映できなかった)。
export function buildTableFromBlocks(
  blocks: ArtifactBlock[],
  order: number,
  title?: string
): TableBlock | null {

  const examples = blocks.filter((b): b is ExampleBlock => b.type === "example");

  if (examples.length > 0) {

    return {
      id: nextBlockId(),
      type: "table",
      title,
      columns: EXAMPLE_TABLE_COLUMNS,
      rows: examples.map((e) => [e.title ?? "事例", e.summary]),
      tablePurpose: "evidence",
      order,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

  }

  const evidenceBlocks = blocks.filter((b): b is EvidenceBlock => b.type === "evidence");

  if (evidenceBlocks.length > 0) {

    return {
      id: nextBlockId(),
      type: "table",
      title,
      columns: EVIDENCE_TABLE_COLUMNS,
      rows: evidenceBlocks.map((e) => [e.claim, e.source ?? "—", e.confidence ?? "—"]),
      // Phase78 Tier1(Evidence Traceability): この表の各行がどの
      // Evidence Blockから来たかを記録する(Section5)。
      sourceEvidenceIds: evidenceBlocks.map((e) => e.id),
      tablePurpose: "evidence",
      order,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

  }

  return null;

}

// =========================
// Comparison Table: Row Entity中心の比較表 (Phase79)
// =========================
//
// Repository Evidence(Phase79 Root Cause調査): buildTableFromBlocks()
// (上記)は固定columns(EXAMPLE_TABLE_COLUMNS/EVIDENCE_TABLE_COLUMNS)
// しか持たず、ユーザーが指定した比較軸(「イベント名・地域・対象者・
// 特徴・参加しやすい理由」等)を一切反映できない。またExample1件を
// そのまま1行として扱うため、Example自体が構造化されていなければ
// 「事例/詳細」の2列にしかならず、Evidenceしか無ければEvidence一覧
// (主張/出典/確信度)へフォールバックしてしまう——これが「比較表の
// はずが出典表になる」というPhase79の核心問題だった。
//
// この関数は、fieldsを持つ(=構造化済みの)Example Blockだけを
// Row Entityとして採用し、ユーザー指定columnsをそのままTable
// Schemaとして使う(Section4絶対条件)。fieldsを持つExampleが1件も
// 無ければnull(捏造しない、Section11)。
//
// 列の対応付け(Section11「情報未確認」): 指定列名がExampleのfields
// ラベルと完全一致しない場合(表記ゆれ、例:「地域」→「開催地域」)は
// 部分一致で緩く対応づける。それでも対応する値が無い場合は
// 架空の値を作らず"情報未確認"という明示的な欠損値にする。
export function buildComparisonTableFromBlocks(
  blocks: ArtifactBlock[],
  requestedColumns: string[] | undefined,
  order: number,
  title?: string
): TableBlock | null {

  const structuredExamples = blocks.filter(
    (b): b is ExampleBlock => b.type === "example" && !!b.fields && b.fields.length > 0
  );

  if (structuredExamples.length === 0) {
    return null;
  }

  // 全Row Entityのfieldsラベルの和集合を、出現順を保ったまま集める
  // (requestedColumnsが無い場合のフォールバック)。
  const allLabels: string[] = [];

  for (const example of structuredExamples) {

    for (const field of example.fields!) {

      if (!allLabels.includes(field.label)) {
        allLabels.push(field.label);
      }

    }

  }

  const columns = requestedColumns && requestedColumns.length > 0 ? requestedColumns : allLabels;

  const MISSING_VALUE = "情報未確認";

  function findField(example: ExampleBlock, column: string) {

    const exact = example.fields!.find((f) => f.label === column);

    if (exact) {
      return exact;
    }

    return example.fields!.find(
      (f) => f.label.includes(column) || column.includes(f.label)
    );

  }

  function findFieldValue(example: ExampleBlock, column: string): string {

    const field = findField(example, column);

    return field ? field.value : MISSING_VALUE;

  }

  const rows = structuredExamples.map((example) =>
    columns.map((column) => findFieldValue(example, column))
  );

  const rowSourceEvidenceIds = structuredExamples.map(
    (example) => example.sourceEvidenceIds ?? []
  );

  // Phase90(Structured Research Dataset Section8〜10): 行単位より
  // 細かい、セル(行×列)単位のEvidence対応。findField()が見つけた
  // fieldがsourceEvidenceIds(Phase90新設、groundParsedEntities()が
  // 既に計算済みの値をそのまま保持したもの)を持っていればそれを使う。
  // 持たない場合(既存Artifactのfieldsや、値が"情報未確認"のセル)は
  // undefinedのままとし、架空のEvidence対応を作らない——UI側は
  // rowSourceEvidenceIds(行単位)へフォールバックできる。
  const cellSourceEvidenceIds = structuredExamples.map((example) =>
    columns.map((column) => findField(example, column)?.sourceEvidenceIds)
  );

  const hasAnyCellEvidence = cellSourceEvidenceIds.some((row) =>
    row.some((ids) => ids !== undefined)
  );

  // Table単位のsourceEvidenceIdsは、行単位の重複を除いた和集合。
  const sourceEvidenceIds = Array.from(new Set(rowSourceEvidenceIds.flat()));

  return {
    id: nextBlockId(),
    type: "table",
    title,
    columns,
    rows,
    tablePurpose: "comparison",
    rowSourceEvidenceIds,
    cellSourceEvidenceIds: hasAnyCellEvidence ? cellSourceEvidenceIds : undefined,
    sourceEvidenceIds: sourceEvidenceIds.length > 0 ? sourceEvidenceIds : undefined,
    order,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

}

// Section7「この表にさらに2件追加して」: 既存Table Blockの列構成を
// 維持したまま、Example/Evidence Blockから未反映の行だけを追記する
// (既存rowsは一切変更しない、絶対条件Section12「既存Blockが消える
// バグを避ける」)。新しい行の元にできるBlockが無ければ、既存
// TableBlockをそのまま返す(no-opで安全側)。
export function appendRowsToTable(
  table: TableBlock,
  blocks: ArtifactBlock[]
): TableBlock {

  // 参照比較ではなく列名の内容比較で判定する(DB往復後は配列の参照
  // 同一性が失われるため)。
  const isExampleTable =
    table.columns.length === EXAMPLE_TABLE_COLUMNS.length &&
    table.columns.every((col, i) => col === EXAMPLE_TABLE_COLUMNS[i]);

  const source = isExampleTable
    ? blocks.filter((b): b is ExampleBlock => b.type === "example")
    : blocks.filter((b): b is EvidenceBlock => b.type === "evidence");

  const existingRowCount = table.rows.length;

  const newRows =
    source.length > existingRowCount
      ? source
          .slice(existingRowCount)
          .map((item) =>
            item.type === "example"
              ? [item.title ?? "事例", item.summary]
              : [item.claim, item.source ?? "—", item.confidence ?? "—"]
          )
      : [];

  if (newRows.length === 0) {
    return table;
  }

  // Phase78 Tier1: Evidence由来のTableへ行を追記する場合、追記した
  // 行の根拠となったEvidence BlockのidもsourceEvidenceIdsへ追加する
  // (Example由来のTableはそもそもEvidenceを経由しないため対象外)。
  const newSourceEvidenceIds = isExampleTable
    ? table.sourceEvidenceIds
    : [
        ...(table.sourceEvidenceIds ?? []),
        ...(source.slice(existingRowCount) as EvidenceBlock[]).map((e) => e.id),
      ];

  return {
    ...table,
    rows: [...table.rows, ...newRows],
    sourceEvidenceIds: newSourceEvidenceIds,
    updatedAt: nowIso(),
  };

}

// =========================
// Chart Block: 既存Table Blockからの決定論的構築
// =========================
//
// Section10「まずはArtifact内部でtype: "chart"としてデータを保持
// できることを優先する」。数値化できる列(Table.rows内で数値として
// parseできる最初の列)をvalueとして採用する。数値列が1つも無ければ
// nullを返し、呼び出し元が安全側フォールバックする(Section10
// 「偽Tableは目的ではない」と同じく、偽Chartも作らない)。
export function buildChartFromTable(
  table: TableBlock,
  order: number,
  title?: string
): ChartBlock | null {

  let valueColumnIndex = -1;

  for (let col = 1; col < table.columns.length; col++) {

    const allNumeric = table.rows.every((row) => row[col] !== undefined && !Number.isNaN(Number(row[col])));

    if (allNumeric && table.rows.length > 0) {
      valueColumnIndex = col;
      break;
    }

  }

  if (valueColumnIndex === -1) {
    return null;
  }

  return {
    id: nextBlockId(),
    type: "chart",
    title,
    chartType: "bar",
    data: table.rows.map((row) => ({
      label: row[0] ?? "",
      value: Number(row[valueColumnIndex]),
    })),
    // Phase78 Tier1: 元Tableの根拠をそのまま引き継ぐ(Section5)。
    sourceEvidenceIds: table.sourceEvidenceIds,
    order,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

}

// =========================
// Legacy Adapter (Section13)
// =========================
//
// blocks列が未設定(Phase75以前に作られたArtifact、またはblocks=[])
// の場合、既存content(markdown全文)を1件のTextBlockへ変換する。
// 空文字の場合は空配列を返す(空のArtifactを無理にBlock化しない)。

export function legacyContentToBlocks(content: string): ArtifactBlock[] {

  const trimmed = content.trim();

  if (!trimmed) {
    return [];
  }

  return [createTextBlock(trimmed, 0)];

}

// =========================
// renderBlocksToPlainText (Artifact.content列との後方互換用)
// =========================
//
// Section3の型コメント通り、Artifact.contentはblocksから決定論的に
// 再構成したプレーンテキスト(Legacy読み取り専用の互換フィールド)。
// UIはこちらではなくblocksを直接描画する。

function blockToPlainText(block: ArtifactBlock): string {

  const heading = block.title ? `## ${block.title}` : "";

  switch (block.type) {

    case "text":
    case "research_summary":
    case "finding":
    case "recommendation":
    case "hypothesis":
      return [heading, block.content].filter(Boolean).join("\n\n");

    case "evidence":
      return [
        heading,
        `${block.claim}${block.source ? `（出典: ${block.source}）` : ""}`,
      ]
        .filter(Boolean)
        .join("\n\n");

    case "example":
      return [heading, block.summary].filter(Boolean).join("\n\n");

    case "table":
      return [
        heading,
        [block.columns.join(" | "), ...block.rows.map((r) => r.join(" | "))].join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

    case "chart":
      return [
        heading,
        block.data.map((d) => `${d.label}: ${d.value}`).join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

    default:
      return heading;

  }

}

export function renderBlocksToPlainText(blocks: ArtifactBlock[]): string {

  return [...blocks]
    .sort((a, b) => a.order - b.order)
    .map(blockToPlainText)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");

}

// =========================
// nextOrder (呼び出し元がBlock追加時に使う補助)
// =========================

export function nextOrder(blocks: ArtifactBlock[]): number {

  if (blocks.length === 0) {
    return 0;
  }

  return Math.max(...blocks.map((b) => b.order)) + 1;

}
