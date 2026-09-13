// =========================
// TACT Bot — Slack Mention -> Referent Selection Chain
// (REF-P1 LIVE FIX 2)
// =========================
//
// LIVE bug再現(REF-P1 LIVE Diagnostic 2): pinned referent Clarification
// (候補1/2/3)に対し、Slackで"@TACT 2"と返信したユーザーの回答が
// 「有効な番号で選んでください。」(invalid_selection)として拒否された。
//
// このtestは、実際にSlack transport正規化(normalizeSlackAppMentionEvent
// → buildBotContext)を経由した後の値が、P1dのdomain parser
// (parseNumericSelection()、core/tact-referent/clarification.ts)に
// 正しく渡ることを、fake/mock無しの実関数チェーンで直接証明する
// (DBアクセス無し、完全にpure)。
//
// 絶対条件(このphaseの明示的指示): 「@TACT 2」からの正規化はBot/
// Conversation境界(normalizeSlackAppMentionEvent/buildBotContext)だけの
// 責務であり、core/tact-referent/自体はSlack mention構文を一切学習
// しない——parseNumericSelection()自体は変更しない(このtestは
// 既存2つの正規化関数の合成が正しく機能することだけを検証する)。

import { normalizeSlackAppMentionEvent } from "../../../core/tact-bot/adapters/slack/normalizeSlackEvent";
import { buildBotContext } from "../../../core/tact-bot/context/buildBotContext";
import type { SlackEventCallbackEnvelope } from "../../../core/tact-bot/adapters/slack/types";
import { parseNumericSelection } from "../../../core/tact-referent/clarification";
import { check, summarize, type CheckResult } from "../lib/check";

function makeSlackNumericReplyEnvelope(text: string): SlackEventCallbackEnvelope {
  return {
    type: "event_callback",
    team_id: "T123TEAM",
    event_id: "Ev123",
    event_time: 1893456200,
    event: {
      type: "app_mention",
      user: "U123USER",
      text,
      ts: "1893456200.000300",
      channel: "C123CHANNEL",
      thread_ts: "1893456000.000100",
    },
  };
}

// Slack transport正規化(normalizeSlackAppMentionEvent + buildBotContext)
// をこの順で通した最終的なnormalizedInputを返す、testだけの合成
// helper(生成物自体は既存2関数の実装そのまま、複製しない)。
function normalizeSlackTextForConversation(rawText: string): string | undefined {
  const message = normalizeSlackAppMentionEvent(makeSlackNumericReplyEnvelope(rawText));
  if (!message) return undefined;
  return buildBotContext(message, null).normalizedInput;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. 生のSlack mention付き数値回答は、Bot境界の正規化を経て
  // parseNumericSelection()が受理できる厳密な"2"になる ----
  {
    const normalized = normalizeSlackTextForConversation("<@U999TACTBOT> 2");
    const parsed = normalized !== undefined ? parseNumericSelection(normalized) : { ok: false as const };

    results.push(check(
      "[REF-P1 LIVE FIX 2] 1. \"<@BOTID> 2\"はBot境界の正規化後に厳密な\"2\"になる",
      normalized === "2"
    ));

    results.push(check(
      "[REF-P1 LIVE FIX 2] 2. 正規化後の\"2\"はparseNumericSelection()でindex=2として受理される(P1d domain parserは一切変更していない)",
      parsed.ok === true && parsed.ok && parsed.index === 2
    ));
  }

  // ---- 3. 同じ形式で候補1/3も正しく解決できる(2だけの特別扱いではない) ----
  {
    const normalized1 = normalizeSlackTextForConversation("<@U999TACTBOT> 1");
    const normalized3 = normalizeSlackTextForConversation("<@U999TACTBOT> 3");

    results.push(check(
      "[REF-P1 LIVE FIX 2] 3. \"<@BOTID> 1\"/\"<@BOTID> 3\"も同様に厳密な\"1\"/\"3\"へ正規化される",
      normalized1 === "1" && normalized3 === "3"
    ));
  }

  // ---- 4. 無効な番号(候補範囲外)は正規化後もinvalid_selection相当のまま
  // ("8"という文字列自体はparseNumericSelectionを通過するが、
  // candidate_snapshot側にindex=8が無いため、上位のresolveReferent
  // ClarificationSelection()がindex_out_of_rangeとして拒否する
  // ——ここではBot境界の正規化がその後続判定を妨げないことだけを
  // 確認する) ----
  {
    const normalized = normalizeSlackTextForConversation("<@U999TACTBOT> 8");
    const parsed = normalized !== undefined ? parseNumericSelection(normalized) : { ok: false as const };

    results.push(check(
      "[REF-P1 LIVE FIX 2] 4. \"<@BOTID> 8\"も同様に厳密な\"8\"へ正規化され、数値としては正しくparseされる(範囲外判定はcandidate_snapshot側の責務)",
      normalized === "8" && parsed.ok === true && parsed.ok && parsed.index === 8
    ));
  }

  // ---- 5. mention token直後の空白/コロンのバリエーションでも同様 ----
  {
    const variants = ["<@U999TACTBOT>   2", "<@U999TACTBOT>: 2", "<@U999TACTBOT> 2 "];

    results.push(check(
      "[REF-P1 LIVE FIX 2] 5. mention token直後の空白/コロンのバリエーションでも厳密に\"2\"へ正規化される",
      variants.every((raw) => normalizeSlackTextForConversation(raw) === "2")
    ));
  }

  // ---- 6. 通常の依頼文(mentionの後に自然文が続く既存ケース)は
  // 従来通り正しく正規化される(この修正がGenericなmention除去挙動を
  // 壊していないことの回帰確認) ----
  {
    const normalized = normalizeSlackTextForConversation("<@U999TACTBOT> これ対応して");

    results.push(check(
      "[REF-P1 LIVE FIX 2] 6. 通常の自然文依頼は引き続き正しく正規化される(既存挙動への影響なし)",
      normalized === "これ対応して"
    ));
  }

  return summarize("bot/referentSelectionMentionChain", results);

}
