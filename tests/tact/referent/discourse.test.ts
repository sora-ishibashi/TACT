// =========================
// TACT Referent — DiscourseFocus Reconstruction Regression (REF-P1b)
// =========================
//
// 対象: core/tact-referent/discourse.ts。Slack/Gmail/Composio/
// Supabase/LLMのいずれにも接続しない、純粋関数のみのtest。

import { currentTopicLabel, extractEntityMentions, reconstructDiscourseFocus } from "../../../core/tact-referent/discourse";
import { slackMessage } from "./fixtures";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // 1. 単純なtopic導入
  {
    const focus = reconstructDiscourseFocus(
      [slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" })],
      "これ確認して"
    );

    results.push(
      check(
        "[REF-P1b discourse] 1. 単一メッセージがA社を導入し、kind=introducedで記録される",
        focus.topicStack.length === 1 &&
          focus.topicStack[0].entityOrSubject === "A社" &&
          focus.topicStack[0].kind === "introduced"
      )
    );
  }

  // 2. A → B、最新topicはB
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "B社の見積も来てる" }),
      ],
      "これ確認して"
    );

    results.push(
      check(
        "[REF-P1b discourse] 2. A社→B社の順で導入されると、現在のtopicはB社になる",
        currentTopicLabel(focus) === "B社"
      )
    );
  }

  // 3. A → B → 明示的なA reactivation
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "B社の見積も来てる" }),
        slackMessage({ messageRef: "s3", text: "さっきのA社の件だけど" }),
      ],
      "これ対応しといて"
    );

    const lastTopic = focus.topicStack[focus.topicStack.length - 1];

    results.push(
      check(
        "[REF-P1b discourse] 3. B社導入後に明示的な「さっきのA社の件」でA社がkind=reactivatedとして再燃し、現在のtopicになる",
        currentTopicLabel(focus) === "A社" &&
          lastTopic.entityOrSubject === "A社" &&
          lastTopic.kind === "reactivated"
      )
    );
  }

  // 4. A → 訂正B(retrospective「あ、Xだった」形)
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の件なんだけど" }),
        slackMessage({ messageRef: "s2", text: "あ、B社だった" }),
      ],
      "これ確認して"
    );

    const corrected = focus.topicStack[focus.topicStack.length - 1];

    results.push(
      check(
        "[REF-P1b discourse] 4. 「あ、B社だった」でB社がkind=correctedとして記録され、現在のtopicになる(平均化・両論併記しない)",
        currentTopicLabel(focus) === "B社" &&
          corrected.kind === "corrected" &&
          focus.topicStack.filter((topic) => topic.entityOrSubject === "A社").length === 1
      )
    );
  }

  // 5. 「AじゃなくてB」形の明示的置換
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の見積の件なんだけど" }),
        slackMessage({ messageRef: "s2", text: "A社じゃなくてB社だった" }),
      ],
      "これ確認して"
    );

    const corrected = focus.topicStack[focus.topicStack.length - 1];

    results.push(
      check(
        "[REF-P1b discourse] 5. 「A社じゃなくてB社」でB社がkind=correctedとしてA社を置き換える",
        currentTopicLabel(focus) === "B社" && corrected.kind === "corrected"
      )
    );
  }

  // 6. 「AじゃなくてBも」は置換として扱わない(additive)
  {
    const focus = reconstructDiscourseFocus(
      [slackMessage({ messageRef: "s1", text: "A社じゃなくてB社も確認して" })],
      "これ確認して"
    );

    results.push(
      check(
        "[REF-P1b discourse] 6. 「A社じゃなくてB社も」はcorrectedを生成せず、A社・B社の両方がintroducedとして扱われる(additive、誤ったconfidentな置換をしない)",
        !focus.topicStack.some((topic) => topic.kind === "corrected") &&
          focus.topicStack.some((topic) => topic.entityOrSubject === "A社" && topic.kind === "introduced") &&
          focus.topicStack.some((topic) => topic.entityOrSubject === "B社" && topic.kind === "introduced")
      )
    );
  }

  // 7. 現在のtopicがdeprioritizeされる
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "それはあとで" }),
      ],
      "特に何もしない"
    );

    const last = focus.topicStack[focus.topicStack.length - 1];

    results.push(
      check(
        "[REF-P1b discourse] 7. 「それはあとで」で直前のtopic(A社)がkind=deprioritizedとして記録され、currentTopicLabel()はdeprioritizedをスキップしてundefinedを返す(自動的に焦点であり続けない)",
        last.entityOrSubject === "A社" && last.kind === "deprioritized" && currentTopicLabel(focus) === undefined
      )
    );
  }

  // 8. deprioritized後にBが導入されるとBが現在のtopicになる
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "それはあとで" }),
        slackMessage({ messageRef: "s3", text: "B社の見積も来てる" }),
      ],
      "これ確認して"
    );

    results.push(
      check(
        "[REF-P1b discourse] 8. A社をdeprioritize後にB社が導入されると、現在のtopicはB社になる",
        currentTopicLabel(focus) === "B社"
      )
    );
  }

  // 9. 「さっきの件」で既知topicが1つだけの場合は安全にreactivateする
  {
    const focus = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "さっきの件、対応して" }),
      ],
      "お願いします"
    );

    const last = focus.topicStack[focus.topicStack.length - 1];

    results.push(
      check(
        "[REF-P1b discourse] 9. 既知topicがA社のみの状態で「さっきの件」と言われた場合、A社がkind=reactivatedとして安全にreactivateされる",
        currentTopicLabel(focus) === "A社" && last.kind === "reactivated"
      )
    );
  }

  // 10. 「さっきの件」で既知topicが複数かつentityの明示が無い場合は憶測しない
  {
    const before = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "B社の見積も来てる" }),
      ],
      "(何もしない)"
    );

    const after = reconstructDiscourseFocus(
      [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "B社の見積も来てる" }),
        slackMessage({ messageRef: "s3", text: "さっきの件、対応して" }),
      ],
      "お願いします"
    );

    results.push(
      check(
        "[REF-P1b discourse] 10. A社/B社2つの既知topicがある状態で無anchorな「さっきの件」は、topicStackへ新規エントリを一切追加せず(reactivatedエントリ0件、長さも不変)、2つ以上の候補から憶測で1つを選ばない",
        !after.topicStack.some((topic) => topic.kind === "reactivated") &&
          after.topicStack.length === before.topicStack.length
      )
    );
  }

  // 11. DiscourseFocusはWork identityを一切参照/変更しない(構造的保証)
  {
    const focus = reconstructDiscourseFocus(
      [slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" })],
      "これ確認して"
    );

    results.push(
      check(
        "[REF-P1b discourse] 11. reconstructDiscourseFocus()の戻り値にはWork関連fieldが一切含まれない(topicStackのみを持つ、構造的にWorkを再割り当てできない)",
        Object.keys(focus).length === 1 && "topicStack" in focus
      )
    );
  }

  // 12. 決定論性
  {
    const messages = [
      slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
      slackMessage({ messageRef: "s2", text: "B社の見積も来てる" }),
      slackMessage({ messageRef: "s3", text: "さっきのA社の件だけど" }),
    ];

    const first = reconstructDiscourseFocus(messages, "これ対応しといて");
    const second = reconstructDiscourseFocus(messages, "これ対応しといて");

    results.push(
      check(
        "[REF-P1b discourse] 12. 同一inputに対しreconstructDiscourseFocus()は常に同一の結果を返す(決定論的)",
        JSON.stringify(first) === JSON.stringify(second)
      )
    );
  }

  // 追加: extractEntityMentions()自体の基本的な重複除去・出現順保持
  {
    const entities = extractEntityMentions("A社の件、A社から来た。B社も気になる。");

    results.push(
      check(
        "[REF-P1b discourse] extractEntityMentions()は同一メッセージ内の重複entityを除去しつつ出現順を保持する",
        entities.length === 2 && entities[0] === "A社" && entities[1] === "B社"
      )
    );
  }

  return summarize("referent/discourse", results);

}
