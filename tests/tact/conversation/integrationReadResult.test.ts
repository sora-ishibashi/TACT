// =========================
// TACT Conversation — formatIntegrationReadResultAnswer Regression
// (Architecture Migration Phase C2.2)
// =========================
//
// 対象: core/tact-conversation/orchestration.tsのformatIntegrationRead
// ResultAnswer()。純粋関数(DBアクセス・LLM呼び出しなし)、
// OrchestrationResult.integrationReadResultをBot向けtextへ変換する
// (絶対条件Section18: Bot-specific formattingはこの境界でのみ行う)。

import { formatIntegrationReadResultAnswer } from "../../../core/tact-conversation/orchestration";
import type { OrchestrationResult } from "../../../core/tact-orchestrator";
import { check, summarize, type CheckResult } from "../lib/check";

function makeResult(overrides: Partial<OrchestrationResult> = {}): OrchestrationResult {
  return {
    answer: "placeholder",
    executionId: "exec-1",
    tasks: [],
    memoryUsed: [],
    toolsUsed: [],
    memoryWrites: [],
    learningSignals: [],
    metadata: { executionMode: "single-execution" },
    ...overrides,
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 正常系: channel一覧がuser-visible textへ整形される ----
  {
    const result = makeResult({
      integrationReadResult: {
        service: "slack",
        operation: "list_channels",
        output: JSON.stringify({
          channels: [
            { id: "C1", name: "general", isPrivate: false },
            { id: "C2", name: "tact" },
          ],
        }),
      },
    });

    const text = formatIntegrationReadResultAnswer(result);

    results.push(
      check(
        "[正常系] Slackのチャンネル名がvisible textへ含まれる",
        !!text && text.includes("#general") && text.includes("#tact")
      )
    );

    results.push(
      check(
        "[正常系] 内部channel id(C1/C2)はvisible textへ含まれない(Section7: channel idは内部監査用途のみ)",
        !!text && !text.includes("C1") && !text.includes("C2")
      )
    );

    // Architecture Migration Phase C2.2c(Read Result Completeness
    // Semantics Correction): pagination未実装・provider既定で
    // public_channelのみが対象のため、「これが全チャンネルである」と
    // 読める断定的な表現を使わないことを直接確認する。
    results.push(
      check(
        "[Case2/C2.2c] visible wordingが完全性・網羅性を断定しない(「すべてのチャンネル」「全チャンネル」「チャンネル一覧です」「これがチャンネル一覧です」「チャンネルは以下です」を含まない)",
        !!text &&
          !text.includes("すべてのチャンネル") &&
          !text.includes("全チャンネル") &&
          !text.includes("チャンネル一覧です") &&
          !text.includes("これがチャンネル一覧です") &&
          !text.includes("チャンネルは以下です")
      )
    );
  }

  // ---- integrationReadResultが無い場合はundefined(既存answerを壊さない) ----
  {
    const result = makeResult();

    results.push(
      check(
        "[非対象] integrationReadResultが無い場合はundefinedを返し、既存result.answerを上書きしない",
        formatIntegrationReadResultAnswer(result) === undefined
      )
    );
  }

  // ---- 未対応service/operationは安全にundefined ----
  {
    const result = makeResult({
      integrationReadResult: { service: "slack", operation: "list_messages", output: "{}" },
    });

    results.push(
      check(
        "[非対象] 未対応operation(list_messages等)は安全にundefinedを返す(このPhaseで実装済みのlist_channelsのみ対象)",
        formatIntegrationReadResultAnswer(result) === undefined
      )
    );
  }

  // ---- 不正なJSON出力でも例外を投げず安全にfallbackする ----
  {
    const result = makeResult({
      integrationReadResult: { service: "slack", operation: "list_channels", output: "not-json{{{" },
    });

    let threw = false;
    let text: string | undefined;

    try {
      text = formatIntegrationReadResultAnswer(result);
    } catch {
      threw = true;
    }

    results.push(
      check(
        "[防御的] outputが不正なJSONでも例外を投げず、undefinedへ安全にfallbackする",
        threw === false && text === undefined
      )
    );
  }

  // ---- Case3: nameが無いchannelはvisibleへ出ない ----
  {
    const result = makeResult({
      integrationReadResult: {
        service: "slack",
        operation: "list_channels",
        output: JSON.stringify({
          channels: [{ id: "C1", name: "general" }, { id: "C3" }],
        }),
      },
    });

    const text = formatIntegrationReadResultAnswer(result) ?? "";

    results.push(
      check(
        "[Case3] nameが無いchannel(schema上optional、DM混入等)はvisible listから除外され、idも一切表示されない",
        text.includes("#general") && !text.includes("C3")
      )
    );
  }

  // ---- Case5: 0件の場合は完全性を断定しない安全な文言 ----
  {
    const result = makeResult({
      integrationReadResult: { service: "slack", operation: "list_channels", output: JSON.stringify({ channels: [] }) },
    });

    const text = formatIntegrationReadResultAnswer(result);

    results.push(
      check(
        "[Case5/C2.2c] channelsが空配列の場合、「表示できるSlackチャンネルを取得できませんでした。」という非断定的な安全文言を返す(「チャンネルはありません」等の完全性を断定する表現は使わない、provider failureとは別の経路であることも明確)",
        text === "表示できるSlackチャンネルを取得できませんでした。"
      )
    );
  }

  // ---- Case4: 表示件数の上限(先頭20件)、21件以上でも上限維持 ----
  {
    const manyChannels = Array.from({ length: 30 }, (_, i) => ({ id: `C${i}`, name: `channel-${i}` }));

    const result = makeResult({
      integrationReadResult: {
        service: "slack",
        operation: "list_channels",
        output: JSON.stringify({ channels: manyChannels }),
      },
    });

    const text = formatIntegrationReadResultAnswer(result) ?? "";
    const lineCount = text.split("\n").filter((line) => line.startsWith("#")).length;

    results.push(
      check(
        "[Case4] 30件(21件以上)のchannelがあっても、visible textは先頭20件までに切り詰められる(canonical result自体は破壊しない、textだけの安全上限)",
        lineCount === 20
      )
    );
  }

  // ---- Case6: provider/internal情報が一切含まれない ----
  {
    const result = makeResult({
      integrationReadResult: {
        service: "slack",
        operation: "list_channels",
        output: JSON.stringify({
          channels: [{ id: "C1", name: "general" }],
          response_metadata: { next_cursor: "SOME_NEXT_CURSOR" },
        }),
      },
    });

    const text = (formatIntegrationReadResultAnswer(result) ?? "").toLowerCase();

    results.push(
      check(
        "[Case6] visible textにchannel id/providerExecutionRef/connectedAccountId/providerConnectionRef/SLACK_LIST_ALL_CHANNELS/Composio/next_cursorのいずれも含まれない",
        !text.includes("c1") &&
          !text.includes("providerexecutionref") &&
          !text.includes("connectedaccountid") &&
          !text.includes("providerconnectionref") &&
          !text.includes("slack_list_all_channels") &&
          !text.includes("composio") &&
          !text.includes("next_cursor") &&
          !text.includes("some_next_cursor")
      )
    );
  }

  return summarize("conversation/integrationReadResult", results);

}
