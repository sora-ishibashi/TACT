// =========================
// TACT Referent — DiscourseFocus Reconstruction (REF-P1b)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit §4で確定した、完全にephemeralな
// DiscourseFocus再構築を実装する。turnごとにConversationEvidence
// (bounded prior messages + 現在のtrigger text)から純粋関数として
// 再構築されるだけであり、どのtableにも永続化されない。
//
// 絶対条件(このphaseの明示的指示、frozen):
//   - Work Resolutionの代替ではない。「どのWorkが active か」は
//     一切決定しない・Workを一切importしない・Workを再割り当てる
//     手段を持たない(この module自体がWork型を一切参照しないことで
//     構造的に保証する)。
//   - 副作用・I/O・env var読み取りが一切無い純粋関数。
//   - 「さっきの件」のように複数の既知topicが候補になり得て安全な
//     anchorが無い場合は、絶対に憶測で1つを選ばない(topicStackへ
//     何も追加しない、既存状態を維持するだけ)。
//
// 依存方向: ConversationEvidenceMessage(既存canonical、
// core/tact-conversation/conversationEvidence.ts)を型のみ利用する。
// core/tact-work・core/tact-integration・core/tact-bot配下のいずれも
// importしない。

import type { ConversationEvidenceMessage } from "../tact-conversation/conversationEvidence";
import type { DiscourseFocus, DiscourseTopic } from "./types";

// =========================
// Entity mention extraction (discourse.ts / signals.ts 共有)
// =========================
//
// 保守的な企業/エンティティ言及パターン: 社/商事/株式会社という
// 既知の法人名suffixで終わる文字列のみを対象とする。
//
// 既存core/tact-context-resolution/index.tsのsubjectEntityFromMessage()
// を再利用しなかった理由(意図的な設計判断、このphaseの明示的指示
// 「重複させる理由が無い限りregexを複製しない」への回答):
//   1. 非exportであり(module-private関数)、そのままimportできない。
//   2. その関数は「Xの更新案件」という特定の言い回し専用に設計されて
//      おり(EXPLICIT_UPDATE_SUBJECT正規表現、"更新"というkeywordを
//      要求する)、本phaseが対応すべき「B社の見積も来てる」のような
//      裸の企業言及(「更新」を含まない)を検出できない。
//   3. その関数をより汎用的に拡張することはcore/tact-context-resolution
//      の既存の外部から観測可能な挙動を変更するリスクがあり、この
//      phaseの絶対条件(Context Resolutionの本番挙動を変更しない)に
//      抵触する。
// そのため、目的が異なる新しい・狭いscopeのhelperとしてここに定義する
// (「重複」ではなく、既存helperでは満たせない別の保守的なpatternの
// 追加)。
// 絶対条件(実装時に発見・修正): entity名の文字class自体はひらがなを
// 含めない(\p{Script=Hiragana}を除外する)。ひらがなを許すと、
// 「さっきのA社」「じゃなくてB社」のように、直前の助詞・接続表現
// (さっきの/じゃなくて等、いずれもひらがな)がentity captureへ
// 巻き込まれてしまう——実際にこの実装のtest中で発見された不具合
// (漢字/カタカナ/英数字はentity名の一部になり得るが、ひらがなの
// 接続語はentity名の一部にならない、という日本語表記の実態に基づく
// 保守的な制約)。
// signals.ts(sender抽出)も同じ文字classを再利用する——2箇所で別々の
// 定義を持つと、片方だけ修正されてもう片方は同じ不具合を再発する
// (drift)ため、この1箇所からexportする。
export const ENTITY_NAME_CHAR = "A-Za-z0-9\\p{Script=Han}\\p{Script=Katakana}";
const ENTITY_MENTION_PATTERN = new RegExp(
  `[${ENTITY_NAME_CHAR}][${ENTITY_NAME_CHAR}ー・.]{0,47}?(?:社|商事|株式会社)`,
  "gu"
);

/**
 * 1メッセージから、既知の法人名suffixを持つ保守的なentity言及を
 * 抽出する。同一メッセージ内の重複は除去するが、出現順は保持する。
 */
export function extractEntityMentions(text: string): readonly string[] {

  const matches = text.match(ENTITY_MENTION_PATTERN) ?? [];
  const seen = new Set<string>();
  const entities: string[] = [];

  for (const match of matches) {
    if (seen.has(match)) continue;
    seen.add(match);
    entities.push(match);
  }

  return entities;

}

// =========================
// Reactivation cues (Design Freeze §12、このphaseの明示的指示)
// =========================

const REACTIVATION_CUE_PATTERN =
  /さっき(?:話してた|の)|先ほどの|前の(?:件|話)|話戻すけど/u;

// =========================
// Correction cues (Design Freeze §22、このphaseの明示的指示)
// =========================
//
// 絶対条件: 「XじゃなくてYも」のようなadditive(追加)表現は
// replacementとして扱わない——captureしたYの直後に「も」が続く場合は
// 意図的にunmatchedとする(negative lookahead)。
const REPLACEMENT_CONNECTIVE_PATTERN = new RegExp(
  `(?:じゃなくて|じゃなく、?|ではなく)([${ENTITY_NAME_CHAR}][${ENTITY_NAME_CHAR}ー・.]{0,47}?(?:社|商事|株式会社))(?!も)`,
  "u"
);

// 「あ、Xだった/でした」形の自己訂正。
const RETROSPECTIVE_CORRECTION_PATTERN = new RegExp(
  `あ[、,]\\s*([${ENTITY_NAME_CHAR}][${ENTITY_NAME_CHAR}ー・.]{0,47}?(?:社|商事|株式会社))(?:だった|でした)`,
  "u"
);

// =========================
// Deprioritization cues (このphaseの明示的指示)
// =========================

const DEPRIORITIZATION_CUE_PATTERN =
  /それは(?:あとで|置いといて|一旦いい)|その件はあとで/u;

/**
 * topicStackのうち、直近の非deprioritized要素のentityOrSubjectを返す。
 * 「末尾が現在最優先」という型契約(core/tact-referent/types.ts参照)を
 * 尊重しつつ、「今しがたdeprioritizeされたtopicは、それだけでは
 * 自動的に現在の焦点であり続けない」という設計判断(このphaseの
 * 明示的指示)を、この1箇所の探索ロジックへ閉じ込める。
 */
export function currentTopicLabel(focus: DiscourseFocus): string | undefined {

  // deprioritizeされたentityは、それより古い同じentityへのmentionが
  // 残っていても「現在の焦点」としては復活しない——単に直近の
  // deprioritizedエントリを1件skipするだけでは、その直前に同じ
  // entityのintroduced/reactivatedエントリがある場合に誤って同じ
  // entityへ逆戻りしてしまう(このphase実装時に発見・修正した不具合)。
  const deprioritized = new Set<string>();

  for (let i = focus.topicStack.length - 1; i >= 0; i--) {

    const topic = focus.topicStack[i];

    if (topic.kind === "deprioritized") {
      deprioritized.add(topic.entityOrSubject);
      continue;
    }

    if (!deprioritized.has(topic.entityOrSubject)) {
      return topic.entityOrSubject;
    }

  }

  return undefined;

}

/**
 * 完全にephemeralなDiscourseFocusを、bounded priorMessages(既に
 * chronological順であることが既存のConversationEvidence構築規約
 * (core/tact-bot/adapters/slack/slackConversationContext.tsの
 * boundMessages())により保証されている)と、現在のtrigger textから
 * 再構築する。
 *
 * priorMessagesは"trigger"のrelationshipを持つ要素を含めないことを
 * 前提とする(呼び出し元がcore/tact-context-resolution/index.tsの
 * resolveConversationSubject()と同じ既存の除外規約に従う想定——この
 * 関数自身はrelationshipを検査しない、単純な文字列配列+trigger text
 * という最小限の入力面にとどめる)。
 */
export function reconstructDiscourseFocus(
  priorMessages: readonly ConversationEvidenceMessage[],
  currentTriggerText: string
): DiscourseFocus {

  const topicStack: DiscourseTopic[] = [];
  const knownEntities = new Set<string>();

  function processMessage(text: string, mentionIndex: number): void {

    // 1. correction(最優先): 訂正表現が検出された場合、そのメッセージ
    // 全体を1つのcorrection eventとして扱い、通常のentity導入scanは
    // 行わない(同じmessage内の元entityを誤って"introduced"として
    // 二重に扱わないため)。
    const replacementMatch = text.match(REPLACEMENT_CONNECTIVE_PATTERN);
    const retrospectiveMatch = text.match(RETROSPECTIVE_CORRECTION_PATTERN);
    const correctedEntity = replacementMatch?.[1] ?? retrospectiveMatch?.[1];

    if (correctedEntity) {
      topicStack.push({ entityOrSubject: correctedEntity, mentionIndex, kind: "corrected" });
      knownEntities.add(correctedEntity);
      return;
    }

    // 2. deprioritization
    if (DEPRIORITIZATION_CUE_PATTERN.test(text)) {
      const current = currentTopicLabel({ topicStack });
      if (current) {
        topicStack.push({ entityOrSubject: current, mentionIndex, kind: "deprioritized" });
      }
      return;
    }

    // 3. reactivation — 絶対条件: 安全なanchorが無い限り憶測しない。
    if (REACTIVATION_CUE_PATTERN.test(text)) {

      const mentionedEntities = extractEntityMentions(text);

      if (mentionedEntities.length === 1) {
        const [entity] = mentionedEntities;
        if (knownEntities.has(entity)) {
          // 明示的にentityを名指ししたreactivation
          // (例:「さっきのA社の件だけど」)。
          topicStack.push({ entityOrSubject: entity, mentionIndex, kind: "reactivated" });
        } else {
          // reactivation cueは付いているが、名指しされたentity自体が
          // 未知——実質的には新規導入として扱う(既知topicの再燃では
          // ない)。
          topicStack.push({ entityOrSubject: entity, mentionIndex, kind: "introduced" });
          knownEntities.add(entity);
        }
        return;
      }

      if (mentionedEntities.length === 0) {
        // 「さっきの件」のようにentityが明示されていない場合、既知
        // topicがちょうど1つだけなら安全にreactivateする。2つ以上
        // 候補がある場合、または既知topicが無い場合は、絶対に憶測で
        // 選ばない(topicStackへ何も追加しない)。
        const eligible = [...knownEntities];
        if (eligible.length === 1) {
          topicStack.push({ entityOrSubject: eligible[0], mentionIndex, kind: "reactivated" });
        }
        return;
      }

      // 2つ以上のentityが同じreactivation発言内に明示されている場合も
      // 同様に、どちらを指すか安全に決定できないため何もしない。
      return;

    }

    // 4. 通常のtopic導入 — 新規entityのみを追加する。
    for (const entity of extractEntityMentions(text)) {
      if (!knownEntities.has(entity)) {
        topicStack.push({ entityOrSubject: entity, mentionIndex, kind: "introduced" });
        knownEntities.add(entity);
      }
    }

  }

  priorMessages.forEach((message, index) => processMessage(message.text, index));
  // 現在のtriggerは認証済み現在ユーザー自身の発言であり、historical
  // messageではない——しかしdiscourse上は依然として最も新しい発言
  // であり、reactivation/correction/deprioritizationの文言をそこに
  // 含むこと自体は正当な会話事実である(Authorization/requestTypeの
  // 決定権とは無関係、このphaseの明示的指示「多話者境界」と同じ
  // 「意味理解には影響してよいが権限には影響しない」という分離)。
  processMessage(currentTriggerText, priorMessages.length);

  return { topicStack };

}
