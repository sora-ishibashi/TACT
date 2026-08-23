// =========================
// TACT Core — Knowledge / Example (STEP175)
// =========================
//
// MemoryとKnowledgeを混同しない(STEP175絶対条件4)。
//   Memory    = TACTが知っておくべき継続的な文脈(例: 「このプロジェクト
//               では資料は簡潔にまとめる」)。core/tact-core/memory/を参照。
//   Knowledge = TACTが参照できる情報・資料そのもの(過去の提案資料、
//               PDF、社内ドキュメント、調査結果、Web情報、成果物等)。
//
// 既存のEvidence(core/context/types.ts)はWorkflow 1回の実行に閉じた、
// Researcherが収集した根拠データであり、ここでのKnowledgeとは責務が
// 異なる(Evidenceは技術的な実行時データ、Knowledgeは横断的に蓄積・
// 再利用される資産)。将来的にEvidenceをKnowledgeへ「昇格」させる
// 経路は考えられるが、STEP175では型の重複作成を避けるため、
// KnowledgeItemはEvidenceを内部に持ち込まず、独立した型として定義する。

export type KnowledgeScope =
  | "user"
  | "organization"
  | "project"
  | "conversation";

// STEP175の指示にある「Document/Example/Evidence/Reference/
// Artifactなどへ拡張できる構造」をkindとして表現する。
export type KnowledgeKind =
  | "document"
  | "example"
  | "evidence"
  | "reference"
  | "artifact";

interface KnowledgeBase {

  id: string;

  scope: KnowledgeScope;

  // STEP205: scopeが指す対象の実際の所有者を識別するID。scopeの値に
  // 応じて意味が変わる、discriminatedな単一フィールドとする
  // (STEP204で発見した「scopeはあるが所有者を識別するIDが無く、
  // 同一scope内のデータがユーザー間で混在しうる」という型契約上の
  // ギャップを解消するために追加した)。
  //
  //   scope === "user"         → ユーザーID(core/auth/*が検証する
  //                               userIdと同じ値、auth.users.idを想定)
  //   scope === "organization" → organization ID
  //   scope === "project"      → project ID
  //   scope === "conversation" → conversation ID(core/conversation/*の
  //                               Conversation.id)
  //
  // 重要(STEP205絶対条件): Organization/ProjectのDB実体・所属関係
  // (あるuserIdがどのorganizationIdに属するか等)は今回新設しない。
  // ここではID文字列同士の意味上の対応を定義するだけであり、実際の
  // 解決・永続化・絞り込みロジックはCoreCapability実装側の将来の
  // 責務とする(mockCoreCapability.tsの既存動作は今回変更しない)。
  ownerId: string;

  // どこから得られた知識か(例: "upload" / "research" / "conversation:<id>"等)。
  source: string;

  tags: string[];

  createdAt: string;

}

export interface KnowledgeItem extends KnowledgeBase {

  kind: KnowledgeKind;

  title: string;

  description?: string;

  // STEP177: Retrievalが実際に返す本文。titleだけでは「参照できる
  // 資料」として不十分なため、内容そのものを保持できるようにする
  // (Capability側が要約・引用等に使う想定)。
  content: string;

  // STEP177: sourceが「どこから得たか(由来の分類)」であるのに対し、
  // referenceは「元データの具体的な所在」(URL・ファイルパス等)を表す。
  // 両方とも必須にはせず、referenceは存在しない場合(手入力等)を許容する。
  reference?: string;

  // STEP177: kind/scope等の固定フィールドでは表現しきれない、将来の
  // Capability固有の付加情報を許容するための開かれた領域。無理に
  // 具体的なフィールドを増やさず、ここへ閉じ込める(STEP177の
  // 「新しい抽象化を増やしすぎない」という方針に沿う)。
  metadata?: Record<string, unknown>;

  updatedAt: string;

}

// =========================
// Example (STEP175絶対条件5)
// =========================
//
// 「単なるファイルではなく、お手本として価値がある成果物」として
// 明示的に区別する。KnowledgeItemの一種(kind:"example")としても
// 表現できるが、STEP175の指示で「特に重要な概念」として個別に
// 定義することを求められているため、独立したinterfaceとして定義する
// (KnowledgeBaseを共有することで、フィールドの重複定義は避ける)。
export interface Example extends KnowledgeBase {

  title: string;

  description?: string;

  // お手本の実体(成果物)を指すID。将来的にWriter出力・Design
  // Document Model等を指す想定だが、STEP175では具体的な参照先の
  // 実装は行わない。
  artifactId?: string;

  // 1(低)〜10(高)。core/tact-core/memory/types.tsのCoreMemory.importance
  // と同じスケールを踏襲する。
  importance: number;

  // STEP177: 「なぜこれが良いお手本なのか」を明示的に保持する
  // (STEP177-Cの要求)。importanceは重要度の数値評価だけであり、
  // 理由そのものは表現できないため分離する。
  reason?: string;

  // STEP177: KnowledgeItem.kindのような固定enumにはせず、Design/
  // Research等それぞれの領域が自由に使える分類ラベルとする
  // (例: "poster" / "report" / "slide" / "email"等)。TACT Design接続時に
  // 「どの種類のお手本を探しているか」で絞り込めるようにするための
  // 最小限の追加。
  category?: string;

}
