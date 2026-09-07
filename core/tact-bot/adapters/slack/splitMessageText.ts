// =========================
// TACT Bot — Slack Message Text Splitting (S1c)
// =========================
//
// Slack公式ドキュメント(chat.postMessage、docs.slack.dev/reference/
// methods/chat.postMessage、2026-09時点でWebFetch経由で確認済み、
// live Slack API callではなく公開ドキュメント参照): 「For best
// results, limit the number of characters in the text field to
// 4,000 characters.」(推奨上限4,000文字)。40,000文字を超えると
// Slack側で自動truncateされるとも明記されている。したがってこの
// fileは「4,000文字だから」という推測ではなく、この公式推奨値を
// 根拠として採用する。
//
// 絶対条件(Section11): 長文を無言でtruncateしない。全内容を保持し、
// 同一threadへ複数messageとして送れるよう、pure関数として
// chunk配列を返すだけにとどめる(実際のSlack API呼び出しはこの
// fileの外、slackChannelAdapter.tsが担う)。
//
// 分割方針: 段落(空行区切り)→行(改行区切り)→Unicode code point
// 単位、の順で「自然な境界」を優先し、それでも収まらない場合だけ
// 強制分割する。「1文字ずつ」のような過剰message化を避けるため、
// 各segmentはchunk上限まで可能な限り詰め込む(greedy packing)。
// surrogate pair(絵文字等)を破壊しないよう、生のstring index(UTF-16
// code unit単位)ではなくArray.from()で得られるUnicode code point
// 単位で長さ判定・分割を行う。

export const SLACK_RECOMMENDED_TEXT_LIMIT = 4000;

function codePoints(value: string): string[] {
  return Array.from(value);
}

function codePointLength(value: string): number {
  return codePoints(value).length;
}

// 「新しいchunkの先頭になる場合は無視されるseparator」と、それ自体は
// 必ずmaxLength以内であることが保証された文字列の組。
interface TextSegment {
  separator: string;
  text: string;
}

function splitIntoSegments(text: string, maxLength: number): TextSegment[] {

  const segments: TextSegment[] = [];

  const paragraphs = text.split(/\n{2,}/);

  paragraphs.forEach((paragraph, paragraphIndex) => {

    const paragraphSeparator = paragraphIndex === 0 ? "" : "\n\n";

    if (codePointLength(paragraph) <= maxLength) {
      segments.push({ separator: paragraphSeparator, text: paragraph });
      return;
    }

    const lines = paragraph.split(/\n/);

    lines.forEach((line, lineIndex) => {

      const lineSeparator = lineIndex === 0 ? paragraphSeparator : "\n";

      if (codePointLength(line) <= maxLength) {
        segments.push({ separator: lineSeparator, text: line });
        return;
      }

      // 1行自体がmaxLengthを超える場合のみ、Unicode code point単位で
      // 強制分割する(絶対条件: surrogate pairを破壊しない)。
      const points = codePoints(line);

      for (let i = 0; i < points.length; i += maxLength) {

        segments.push({
          separator: i === 0 ? lineSeparator : "",
          text: points.slice(i, i + maxLength).join(""),
        });

      }

    });

  });

  return segments;

}

// 長いtextを、Slack 1 messageあたりの安全な上限(既定4,000文字)以内の
// chunkへ分割する。空文字は空配列を返す(送信対象が無いことを明示、
// 空messageを送らない)。
export function splitSlackMessageText(
  text: string,
  maxLength: number = SLACK_RECOMMENDED_TEXT_LIMIT
): string[] {

  if (!text) {
    return [];
  }

  if (codePointLength(text) <= maxLength) {
    return [text];
  }

  const segments = splitIntoSegments(text, maxLength);

  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {

    const candidate = current ? `${current}${segment.separator}${segment.text}` : segment.text;

    if (codePointLength(candidate) <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    // segment.text自体は常にmaxLength以内(splitIntoSegments()が保証)
    // のため、ここでcurrentへ設定するのは安全。
    current = segment.text;

  }

  if (current) {
    chunks.push(current);
  }

  return chunks;

}
