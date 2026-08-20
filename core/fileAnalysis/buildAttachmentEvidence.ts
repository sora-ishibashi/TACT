// =========================
// buildAttachmentEvidence (STEP32)
// =========================
//
// ユーザーが添付したファイルから抽出済みのテキスト(ConversationAttachment)
// を、既存のEvidence型(core/context/types.ts)へ変換するだけの、
// 独立した純粋関数。新しいEvidence保存機構・新しいDBは作らず、
// core/conversation/index.tsが既存のseedEvidence(STEP18)へ
// マージすることで、既存のShared Evidence(core/prompt/builder.ts)
// パイプラインへ自然に合流させる。
//
// 重要: sourceTypeを"user_file"にすることで、Web検索由来のEvidenceと
// 区別できるようにする(core/context/types.tsで追加した値)。
// 出典(source)にはファイル名をそのまま使う(URLの捏造はしない)。

import { Evidence } from "../context/types";
import { ConversationAttachment } from "../conversation/types";

// 1件のEvidenceに詰め込む本文の目安文字数。
// core/prompt/builder.tsのEVIDENCE_SNIPPET_LENGTH(500文字)で
// 表示時に切り詰められるため、それより少し大きい単位で分割し、
// 段落単位の文脈が失われすぎないようにする。
const CHUNK_SIZE = 700;

// 1ファイルあたりの最大チャンク数。
// 非常に長い資料でもEvidence poolが際限なく肥大化しないための上限。
const MAX_CHUNKS_PER_FILE = 20;

// 段落(空行区切り)を優先して分割し、1段落が大きすぎる場合のみ
// 文字数で強制的に分割する。
function chunkText(
  text: string,
  chunkSize: number
): string[] {

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  function pushCurrent() {

    if (!current) return;

    if (current.length <= chunkSize * 2) {
      chunks.push(current);
      return;
    }

    // 1段落が極端に長い場合(表データ等)は文字数で強制分割する。
    for (let i = 0; i < current.length; i += chunkSize) {
      chunks.push(current.slice(i, i + chunkSize));
    }

  }

  for (const paragraph of paragraphs) {

    const candidate =
      current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length > chunkSize && current) {

      pushCurrent();
      current = paragraph;

    } else {

      current = candidate;

    }

  }

  pushCurrent();

  return chunks.length > 0 ? chunks : [text.trim()].filter(Boolean);

}

export function buildAttachmentEvidence(
  attachments: ConversationAttachment[]
): Evidence[] {

  const evidence: Evidence[] = [];

  for (const attachment of attachments) {

    if (!attachment.extractedText.trim()) continue;

    const chunks = chunkText(
      attachment.extractedText,
      CHUNK_SIZE
    ).slice(0, MAX_CHUNKS_PER_FILE);

    chunks.forEach((chunk, index) => {

      evidence.push({

        id: crypto.randomUUID(),

        claim:
          chunks.length > 1
            ? `${attachment.fileName}(${index + 1}/${chunks.length})の内容`
            : `${attachment.fileName}の内容`,

        evidence: chunk,

        // ユーザーが自ら提供した一次資料そのものであるため、
        // 出典はファイル名をそのまま使う(URLの捏造はしない)。
        source: attachment.fileName,

        // ユーザー自身が提供した資料であるため、情報源としての
        // 信頼度はhighとする(内容の正確性そのものを保証するわけ
        // ではない。Reviewer等による検証は従来どおり別途行われる)。
        confidence: "high",

        score: 0,

        sourceType: "user_file",

        // STEP35: ユーザーが今回の作業のために直接提供した一次資料で
        // あるため、core/evidence/rankEvidence.tsの既存の一次情報
        // 優遇ロジック(isPrimarySourceがtrueの場合+20点)へ乗せる。
        // isPrimarySourceは既存フィールドだが、これまでどの生成経路
        // でも設定されておらず未使用だった。新しいランキング軸は
        // 追加せず、既存フィールドを実際に活用するだけの変更。
        isPrimarySource: true,

        createdBy: "user_upload",

        createdAt: Date.now(),

        tags: ["user_file"],

        references: [],

      });

    });

  }

  return evidence;

}
