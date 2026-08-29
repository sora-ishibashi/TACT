// =========================
// TACT Artifact — Domain Types (Phase 75, Phase76でBlock構造へ拡張)
// =========================
//
// Phase75 Section1〜2の思想: Conversationは操作インターフェース、
// Artifactは作業成果物。両者を独立した永続的な状態として分離する。
//
// Phase76 Section3: Artifactを「単一のmarkdown文字列」から、
// 「typeで判別可能なBlockの配列」へ拡張する。Section4の判断
// (Option A: JSONB列としてArtifact内部に保持、別テーブルへは
// 正規化しない)に基づき、DB側は`tact_artifacts.blocks jsonb`列
// 1つに配列全体を保持する(supabase/migrations/
// 20260828000000_add_blocks_to_tact_artifacts.sql)。
//
// Phase76 Section13(Backward Compatibility): blocks列が空/未設定の
// 既存Artifact(Phase75以前に作られた行、content列のみ有効)は、
// core/tact-artifact/blocks.tsのlegacyContentToBlocks()により
// 読み取り時にTextBlock 1件へ変換する。呼び出し元(Conversation層/
// UI)はArtifact.blocksが常に非空配列であることを前提にでき、
// null/undefined分岐を持つ必要がない。

// =========================
// Block型
// =========================
//
// Phase76 Section5で列挙された最低限のBlock種別。各Blockはtype
// (判別可能Union)・id・order(表示順、配列のindexとは独立に保持し、
// 将来の並べ替えに備える)・createdAt/updatedAtという共通構造を持つ
// (Section3の要求)。

export type ArtifactBlockType =
  | "text"
  | "research_summary"
  | "finding"
  | "evidence"
  | "example"
  | "table"
  | "chart"
  | "recommendation"
  | "hypothesis";

interface ArtifactBlockCommon {

  id: string;

  title?: string;

  order: number;

  createdAt: string;

  updatedAt: string;

}

// 素の説明文(Legacy Artifactのadapter先、および分類しづらい
// 自由記述に使う汎用Block)。
export interface TextBlock extends ArtifactBlockCommon {
  type: "text";
  content: string;
}

// Research実行1回分の概要(Section8: Chatには全文を出さず、こちらへ
// 整理して格納する)。
export interface ResearchSummaryBlock extends ArtifactBlockCommon {
  type: "research_summary";
  content: string;
}

// 調査によって得られた重要な発見(Section5「Finding」)。
export interface FindingBlock extends ArtifactBlockCommon {
  type: "finding";
  content: string;
}

// Findingを裏付ける根拠(Section5「Evidence」)。
// core/tact-research/types.tsのResearchEvidenceItemと概ね対応するが、
// Artifact側は将来的にResearch以外の経路(手動追加等)からも
// Evidence Blockを持てるよう、sourceType/urlを独立したoptional
// フィールドとして持つ(Section5「将来的に保持できる構造」)。
export interface EvidenceBlock extends ArtifactBlockCommon {
  type: "evidence";
  claim: string;
  source?: string;
  sourceType?: string;
  url?: string;
  confidence?: "low" | "medium" | "high";
  // Evidence本文からの短い抜粋(core/tact-research/types.tsの
  // ResearchEvidenceItem.snippetと同じ位置づけ)。
  data?: string;
}

// 具体的な事例(Section5「Example」)。columns例(イベント名/地域/
// 対象者/特徴/参考になるポイント)を1件ごとに緩やかなkey-value配列
// として持つ(過度に厳格なschemaにせず、Table Block生成時に
// columnsへ変換できる程度の構造に留める)。
export interface ExampleBlock extends ArtifactBlockCommon {
  type: "example";
  summary: string;
  fields?: {
    label: string;
    value: string;
    // Phase90(Structured Research Dataset Section8〜9): このfield
    // 値(Attribute × Value)を実際に裏付けたEvidence Blockのid。
    // groundParsedEntities()が既に内部で計算している「このEvidenceが
    // この値を裏付けているか」という判定結果(Phase83時点では真偽値
    // としてのみ使い捨てていた)を、判定に使ったEvidence idそのまま
    // として保持する(新しい検証ロジックの追加ではない)。将来Chart/
    // 3C/SWOT等がAttribute単位でEvidenceへ遡るための基盤。
    // 省略時(または対応するEvidenceが特定できなかった場合)は、下の
    // Example全体のsourceEvidenceIds(Entity単位の粗い粒度)へ
    // フォールバックする——既存Artifact(Phase79〜88生成分)は全て
    // このフィールドを持たないため、undefinedのまま正しく解釈できる。
    sourceEvidenceIds?: string[];
  }[];
  // Phase79(Comparison Table Row Entity Section6): このExample
  // (=比較表の1 Row Entity候補)の根拠となったEvidence Blockのid。
  // Research Turnで得られたEvidenceからこのExampleを構成した場合に
  // 設定する(同一Turnで取得した全Evidenceを紐付ける、行単位の
  // 厳密な出典分離は今回のスコープ外——Deferred Decision参照)。
  sourceEvidenceIds?: string[];
}

// 構造化された表(Section5「Table」)。
export interface TableBlock extends ArtifactBlockCommon {
  type: "table";
  columns: string[];
  rows: string[][];
  // Phase78 Tier1(Evidence-Grounded Artifact Section5): このTable
  // 全体の根拠となったEvidence Blockのid一覧(Table単位の粗い
  // Traceability)。Evidence Block由来のTable(buildTableFromBlocks()の
  // Evidence経路)が設定する。
  sourceEvidenceIds?: string[];
  // Phase79(Comparison Table Section6): rows[i]と同じindexで対応する、
  // 行単位のEvidence/Example Block idの一覧(Table単位の粗い
  // sourceEvidenceIdsより細かい粒度)。既存のrows: string[][]の型・
  // 意味は変更せず、並行する配列として追加する(Section13「既存
  // Artifact JSON互換性を壊さない」——既存の読み手はこのフィールドを
  // 単に無視すればよい)。Evidence Table(buildTableFromBlocks()の
  // Evidence経路)は行=Evidence1件のため、sourceEvidenceIdsと
  // rowSourceEvidenceIds[i]は実質同じ情報を粒度違いで持つ。
  // Comparison Table(buildComparisonTableFromBlocks())は行=Entityで
  // あり、1つのEntityが複数のEvidence/Example Blockから構成される
  // 場合があるため、この行単位の配列が本来の主な用途になる。
  rowSourceEvidenceIds?: string[][];
  // Phase90(Structured Research Dataset Section10): rows[i][j]と同じ
  // index(行×列)で対応する、セル単位のEvidence idの一覧
  // (rowSourceEvidenceIdsより更に細かい粒度)。buildComparisonTableFromBlocks()
  // が、元となったExampleBlock.fields[k].sourceEvidenceIds(Phase90新設)
  // から構築する。値が特定できないセル(情報未確認、またはfield単位の
  // Evidence idが無い既存Artifact)はundefinedのまま——UI側は
  // rowSourceEvidenceIds(行単位)へフォールバックすればよい。省略時
  // (既存Phase76〜89のTable Block全て)はundefinedのまま、既存の
  // 読み手・既存テストに一切影響しない。
  cellSourceEvidenceIds?: (string[] | undefined)[][];
  // Phase79 Section13: 「比較表(comparison)」か「根拠一覧
  // (evidence)」かをUI側が判別するためのmetadata。既存Artifact
  // (Phase76〜78で作られたTable)はこのフィールドを持たないため
  // undefinedのまま——UI側はundefinedをevidence相当として扱う
  // (Phase76〜78のTableは実質すべてEvidence/Example一覧だったため、
  // 後方互換のデフォルトとして自然)。
  tablePurpose?: "comparison" | "evidence";
}

// 将来的にグラフとしてレンダリング可能なデータ(Section5「Chart」)。
// `chartType` is additive: existing bar blocks remain valid while Cortex
// Presentation can render a deterministic single-series line chart.
export interface ChartBlock extends ArtifactBlockCommon {
  type: "chart";
  chartType: "bar" | "line";
  data: { label: string; value: number }[];
  // Phase78 Tier1: ChartはTableから導出されるため、元Tableの
  // sourceEvidenceIdsをそのまま引き継ぐ(同じ絶対条件)。
  sourceEvidenceIds?: string[];
  /** Point-level provenance parallel to `data`; rendering does not require displaying it. */
  pointSourceEvidenceIds?: string[][];
}

// 提案・施策(Section5「Recommendation」)。
export interface RecommendationBlock extends ArtifactBlockCommon {
  type: "recommendation";
  content: string;
}

// 今後検証すべき仮説(Section5「Hypothesis」)。
export interface HypothesisBlock extends ArtifactBlockCommon {
  type: "hypothesis";
  content: string;
}

export type ArtifactBlock =
  | TextBlock
  | ResearchSummaryBlock
  | FindingBlock
  | EvidenceBlock
  | ExampleBlock
  | TableBlock
  | ChartBlock
  | RecommendationBlock
  | HypothesisBlock;

// =========================
// Artifact
// =========================

export interface Artifact {

  id: string;

  userId: string;

  // Phase74のProject=Folderをそのまま利用する(新しいFolder概念は
  // 作らない)。未所属のArtifactも成立する。
  projectId?: string | null;

  title: string;

  // Phase76: 構造化されたBlockの配列。常に非空配列(Legacy Artifactは
  // store.ts側のtoArtifact()がlegacyContentToBlocks()で変換済みの
  // ものを渡す、Section13)。表示順はorderフィールドで表現し、配列の
  // 並び自体もorder昇順を維持する(呼び出し元がsortし直す必要が
  // ないようにする)。
  blocks: ArtifactBlock[];

  // Phase75由来。Phase76以降もDB列自体は維持する(Section4「即座に
  // 削除・破壊しない」)。blocksから決定論的に再構成した
  // プレーンテキスト表現(core/tact-artifact/blocks.tsの
  // renderBlocksToPlainText())を保持し、Legacy(このcontent列のみを
  // 読む可能性のある将来のコード)との互換を保つ。UIはblocksを見る
  // ため、通常はこのフィールドを直接表示しない。
  content: string;

  // 更新のたびに+1する(将来のhistory/diff表示の土台。Phase75では
  // 値の保持のみで、UIからの参照・巻き戻し機能は実装しない)。
  version: number;

  createdAt: string;

  updatedAt: string;

}

export interface ArtifactSummary {

  id: string;

  projectId?: string | null;

  title: string;

  version: number;

  updatedAt: string;

}
