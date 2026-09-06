// =========================
// Slack send_message Intent/Extraction Regression
// (Architecture Migration Phase C2.1b)
// =========================
//
// 対象: core/tact-intent/ruleRouter.tsのextractSlackSendIntent()・
// classifyIntent()の新規分岐。LLMは一切使わない決定論的な純粋関数の
// ため、Category A(Deterministic Evaluation)。

import { classifyIntent, extractSlackSendIntent } from "../../../core/tact-intent/ruleRouter";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case 1: channel/textが両方揃った完全な依頼 ----
  {
    const extracted = extractSlackSendIntent("Slackの#tactに『明日の会議は10時です』って送って");

    results.push(
      check(
        "[Case1] channel/textが両方揃った場合、matched:trueでchannel/textを正しく抽出する",
        extracted.matched === true &&
          !("missing" in extracted) &&
          extracted.channel === "tact" &&
          extracted.text === "明日の会議は10時です"
      )
    );

    const decision = classifyIntent("Slackの#tactに『明日の会議は10時です』って送って");

    results.push(
      check(
        "[Case1] classifyIntent()がintegration_slack_send_messageと判定する",
        decision.intent === "integration_slack_send_message"
      )
    );
  }

  // ---- Case 4: channel欠落 ----
  {
    const extracted = extractSlackSendIntent("Slackに『明日の会議は10時です』って送って");

    results.push(
      check(
        "[Case4] channelが欠落している場合、matched:true・missing:channelを返す",
        extracted.matched === true && "missing" in extracted && extracted.missing === "channel"
      )
    );

    const decision = classifyIntent("Slackに『明日の会議は10時です』って送って");

    results.push(
      check(
        "[Case4] classifyIntent()はchannel欠落時にintegration_slack_send_messageと判定しない(ambiguityDetectorが先に処理する前提)",
        decision.intent !== "integration_slack_send_message"
      )
    );
  }

  // ---- Case 5: text(引用符)欠落 ----
  {
    const extracted = extractSlackSendIntent("Slackの#tactへ送っておいて");

    results.push(
      check(
        "[Case5] textが欠落している場合、matched:true・missing:textを返す",
        extracted.matched === true && "missing" in extracted && extracted.missing === "text"
      )
    );
  }

  // ---- 両方欠落 ----
  {
    const extracted = extractSlackSendIntent("Slackに送って");

    results.push(
      check(
        "[両方欠落] channel/textどちらも無い場合、missing:bothを返す",
        extracted.matched === true && "missing" in extracted && extracted.missing === "both"
      )
    );
  }

  // ---- Case 6: Slack送信の試みでない入力は一切干渉しない(既存flow保護) ----
  {
    const notAttempted1 = extractSlackSendIntent("日本の人口を調べて");
    const notAttempted2 = extractSlackSendIntent("Slackってどんなツールですか?");
    const notAttempted3 = extractSlackSendIntent("こんにちは");

    results.push(
      check(
        "[Case6] 送信系動詞を含まない/Slackへの言及のみの入力はmatched:falseのまま(既存chat/research判定に干渉しない)",
        notAttempted1.matched === false &&
          notAttempted2.matched === false &&
          notAttempted3.matched === false
      )
    );

    results.push(
      check(
        "[Case6] 既存のresearch判定はintegration_slack_send_message追加後も変化しない",
        classifyIntent("日本の人口を調べて").intent === "research"
      )
    );

    results.push(
      check(
        "[Case6] 既存のchat判定(既定値)もintegration_slack_send_message追加後も変化しない",
        classifyIntent("こんにちは！").intent === "chat"
      )
    );
  }

  return summarize("intent/slackSendIntent", results);

}
