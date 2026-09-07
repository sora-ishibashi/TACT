// =========================
// Slack list_channels Intent Regression
// (Architecture Migration Phase C2.2)
// =========================
//
// 対象: core/tact-intent/ruleRouter.tsのclassifyIntent()の新規分岐
// (list_channels)。LLMは一切使わない決定論的な純粋関数のため、
// Category A(Deterministic Evaluation)。

import { classifyIntent } from "../../../core/tact-intent/ruleRouter";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case1: 「Slackのチャンネル一覧を見せて」 ----
  {
    const decision = classifyIntent("Slackのチャンネル一覧を見せて");

    results.push(
      check(
        "[Case1] 「Slackのチャンネル一覧を見せて」はintegration_slack_list_channelsと判定される",
        decision.intent === "integration_slack_list_channels"
      )
    );
  }

  // ---- Case2: 「Slackのチャンネルを一覧で見たい」 ----
  {
    const decision = classifyIntent("Slackのチャンネルを一覧で見たい");

    results.push(
      check(
        "[Case2] 「Slackのチャンネルを一覧で見たい」もintegration_slack_list_channelsと判定される",
        decision.intent === "integration_slack_list_channels"
      )
    );
  }

  // ---- Case3: 既存のsend_message intentと競合しない ----
  {
    const sendDecision = classifyIntent("Slackの#tactに『明日の会議は10時です』って送って");

    results.push(
      check(
        "[Case3] 既存のsend_message intentはlist_channels追加後も変化しない(送信要求は一覧要求と誤判定されない)",
        sendDecision.intent === "integration_slack_send_message"
      )
    );

    const listDecisionWithChannelWord = classifyIntent("Slackの#generalチャンネルに『了解です』って送って");

    results.push(
      check(
        "[Case3] 「チャンネル」という語を含む送信依頼(#general channel等)もsend_messageのまま誤ってlist_channelsへ倒れない",
        listDecisionWithChannelWord.intent === "integration_slack_send_message"
      )
    );
  }

  // ---- Case4: Slackへの言及のみ/一覧要求のみでは一致しない(誤検出防止) ----
  {
    const notSlack = classifyIntent("チャンネル一覧を見せて");
    const notList = classifyIntent("Slackってどんなツールですか?");

    results.push(
      check(
        "[Case4] Slackへの言及が無い「チャンネル一覧を見せて」はlist_channelsと判定しない(絶対条件: Slack以外のserviceへ拡大解釈しない)",
        notSlack.intent !== "integration_slack_list_channels"
      )
    );

    results.push(
      check(
        "[Case4] 「チャンネル」「一覧」いずれの語も含まない、Slackへの言及のみの入力はlist_channelsと判定しない",
        notList.intent !== "integration_slack_list_channels"
      )
    );
  }

  // ---- Case5: 既存chat/research判定への非干渉 ----
  {
    results.push(
      check(
        "[Case5] 既存のresearch判定はlist_channels追加後も変化しない",
        classifyIntent("日本の人口を調べて").intent === "research"
      )
    );

    results.push(
      check(
        "[Case5] 既存のchat判定(既定値)もlist_channels追加後も変化しない",
        classifyIntent("こんにちは！").intent === "chat"
      )
    );
  }

  return summarize("intent/slackListChannelsIntent", results);

}
