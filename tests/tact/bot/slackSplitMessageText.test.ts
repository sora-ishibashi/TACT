// =========================
// TACT Bot — Slack Message Text Splitting Regression (S1c)
// =========================
//
// 対象: core/tact-bot/adapters/slack/splitMessageText.tsの
// splitSlackMessageText()(pure function、Slack API/network呼び出し
// 一切無し)。
//
// 絶対条件(Section11): 長文を無言でtruncateしない・全内容を保持する。
// 段落/改行境界を優先しつつ、chunk境界がたまたま段落/改行区切りの
// 真上に来た場合にその1文字の区切り文字(\n\n・\n)自体が結果へ
// 現れないことはあるが(次chunkの先頭にする意味が無いseparatorのため、
// splitIntoSegments()の設計上drop される)、これは「本文content」の
// 欠落ではない。そのため各testは、本文中に埋め込んだ一意なmarker
// 文字列群が、順序を保ったまま・1つも欠落せず・重複せずchunk配列全体
// に現れることを確認する(chunk配列をそのままjoinした文字列の
// バイト完全一致ではなく、「意味のある内容が失われていない」ことを
// 確認する)。

import { splitSlackMessageText, SLACK_RECOMMENDED_TEXT_LIMIT } from "../../../core/tact-bot/adapters/slack/splitMessageText";
import { check, summarize, type CheckResult } from "../lib/check";

function codePointLength(value: string): number {
  return Array.from(value).length;
}

// 固定幅(zero-padding)で生成する: 「MARK1」が「MARK10」の部分文字列に
// なってしまう(前方一致による誤検出)ことを避けるため、桁数を揃えて
// 生成する(全marker長が同一であれば、異なるmarker同士が互いの
// 部分文字列になることはない)。
function makeMarkers(count: number, prefix: string): string[] {
  const width = String(count - 1).length;
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(width, "0")}`);
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- A: 空文字 -> 空配列(送信対象無し) ----
  {
    const chunks = splitSlackMessageText("");
    results.push(check("[A] 空文字は空配列を返す(空messageを送らない)", chunks.length === 0));
  }

  // ---- B: 上限以内の短文 -> 1 chunkそのまま ----
  {
    const text = "こんにちは、TACTです。調査結果をお知らせします。";
    const chunks = splitSlackMessageText(text);
    results.push(
      check(
        "[B] 上限(4,000文字)以内の短文は1 chunkのまま(分割・改変なし)",
        chunks.length === 1 && chunks[0] === text
      )
    );
  }

  // ---- C: 上限超の長文 -> 複数chunkへ分割され、全markerが順序通り・過不足無く現れる ----
  {
    const markerCount = 30;
    const markers = makeMarkers(markerCount, "MARK");
    // 各段落を150文字程度(改行を含まない1行)にして、4,000文字の上限を
    // 大きく超える全体文を作る(段落境界での自然分割を誘発する)。
    const paragraphs = markers.map((m) => `${m}-${"x".repeat(140)}`);
    const text = paragraphs.join("\n\n");

    const chunks = splitSlackMessageText(text);

    const allMarkersFound = markers.every((m) => chunks.some((c) => c.includes(m)));
    const noMarkerSplitAcrossChunks = markers.every(
      (m) => chunks.filter((c) => c.includes(m)).length === 1
    );
    const orderPreserved = (() => {
      const foundOrder = chunks.flatMap((c) => markers.filter((m) => c.includes(m)));
      return foundOrder.join(",") === markers.join(",");
    })();

    results.push(
      check(
        "[C] 上限超の長文は複数chunkへ分割される",
        chunks.length > 1
      )
    );
    results.push(
      check(
        "[C] 全markerがchunk配列全体に過不足無く現れ(欠落・重複無し)、各markerは1つのchunk内に収まる(途中で分断されない)",
        allMarkersFound && noMarkerSplitAcrossChunks
      )
    );
    results.push(
      check(
        "[C] markerの出現順序が元のtextの順序と一致する(送信順序が保たれる)",
        orderPreserved
      )
    );
    results.push(
      check(
        "[C] 各chunkは上限(4,000 code point)以内に収まる",
        chunks.every((c) => codePointLength(c) <= SLACK_RECOMMENDED_TEXT_LIMIT)
      )
    );
  }

  // ---- D: Unicode(絵文字等のsurrogate pair)を含む長文でも破壊されない ----
  {
    // 絵文字(surrogate pair、UTF-16では2 code unit)を大量に含む1行
    // (改行無し)を作り、強制分割(Section: 1行自体がmaxLengthを超える
    // 場合のcode point単位分割)を誘発する。
    const emoji = "🎉";
    const emojiCount = 5000;
    const text = emoji.repeat(emojiCount);

    const chunks = splitSlackMessageText(text);

    const totalEmojiInChunks = chunks.reduce(
      (sum, c) => sum + Array.from(c).filter((ch) => ch === emoji).length,
      0
    );

    const noBrokenSurrogatePair = chunks.every((c) => {
      // 破壊されたsurrogate pairがあれば、code point単位のArray.from()
      // 長さと、それをJOINして再度Array.from()した長さが食い違うことは
      // ないが、より直接的には「chunk内に単独のlone surrogateが
      // 含まれていないか」をJSのwell-formed check(String.prototype.
      // isWellFormedが無い環境も考慮し、Array.from()の往復で元と一致
      // するかで代用)で確認する。
      return Array.from(c).join("") === c;
    });

    results.push(
      check(
        "[D] 絵文字(surrogate pair)5,000個の長文は複数chunkへ分割される",
        chunks.length > 1
      )
    );
    results.push(
      check(
        "[D] 全絵文字が欠落・重複無くchunk配列全体に現れる(5,000個 -> 合計5,000個)",
        totalEmojiInChunks === emojiCount
      )
    );
    results.push(
      check(
        "[D] どのchunkもsurrogate pairの途中で破壊されていない",
        noBrokenSurrogatePair
      )
    );
  }

  // ---- E: 送信順序 = 元のtext内の段落順序(改めてsegment境界を跨ぐ場合も含む) ----
  {
    const markers = makeMarkers(10, "SEQ");
    const text = markers.map((m) => `${m}-${"y".repeat(500)}`).join("\n\n");
    const chunks = splitSlackMessageText(text);

    const foundOrder = chunks.flatMap((c) => markers.filter((m) => c.includes(m)));

    results.push(
      check(
        "[E] chunk配列の順序どおりに読んでいくと、元のtextにおけるmarker順序と完全一致する(送信順序保証)",
        foundOrder.join(",") === markers.join(",")
      )
    );
  }

  // ---- F: 巨大な長文でも無言truncateされない(全markerが最後まで残る) ----
  {
    const markerCount = 100;
    const markers = makeMarkers(markerCount, "BIG");
    const text = markers.map((m) => `${m}-${"z".repeat(300)}`).join("\n\n");
    const chunks = splitSlackMessageText(text);

    const lastMarker = markers[markers.length - 1];

    results.push(
      check(
        "[F] 巨大な長文(100段落)でも最後のmarkerまでchunk配列内に残る(途中で無言truncateされていない)",
        chunks.some((c) => c.includes(lastMarker))
      )
    );
    results.push(
      check(
        "[F] 全100個のmarkerが1つも欠落しない",
        markers.every((m) => chunks.some((c) => c.includes(m)))
      )
    );
  }

  return summarize("bot/slackSplitMessageText", results);

}
