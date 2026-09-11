import {
  retrieveSlackConversationContext,
  SLACK_CHANNEL_CONTEXT_MAX_PRECEDING_MESSAGES,
  SLACK_THREAD_CONTEXT_MAX_MESSAGES,
} from "../../../core/tact-bot/adapters/slack/slackConversationContext";
import { formatConversationEvidenceAcknowledgement } from "../../../core/tact-conversation/conversationEvidence";
import { check, summarize, type CheckResult } from "../lib/check";

const trigger = {
  channelRef: "C1",
  triggerMessageRef: "1900000000.000",
  triggerAuthorRef: "U-trigger",
  triggerText: "これ確認して",
  triggerTimestamp: "1900000000.000",
};

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  {
    let threadCalls = 0;
    const evidence = await retrieveSlackConversationContext({ ...trigger, threadRef: "1899999990.000" }, {
      getThreadReplies: async () => {
        threadCalls += 1;
        return { ok: true, messages: [
          { ts: "1899999990.000", user: "U1", text: "A社の更新案件" },
          { ts: "1899999995.000", user: "U2", text: "先方からメールが来ている" },
          { ts: "1900000001.000", user: "U3", text: "after trigger" },
        ] };
      },
      getChannelHistory: async () => ({ ok: true, messages: [] }),
    });
    results.push(check("[context thread] root/prior/trigger are chronological and post-trigger is excluded", threadCalls === 1 && evidence.provenance.retrievalMode === "thread" && evidence.messages.map((m) => m.text).join("|") === "A社の更新案件|先方からメールが来ている|これ確認して"));
    const acknowledgement = formatConversationEvidenceAcknowledgement("これ確認して", evidence);
    results.push(check("[context authorization] evidence is acknowledged as context and cannot become an action", acknowledgement?.includes("直前のSlack会話") === true && !acknowledgement?.includes("実行しました")));
  }
  {
    let params: { channel: string; latest: string; limit: number } | undefined;
    const evidence = await retrieveSlackConversationContext(trigger, {
      getThreadReplies: async () => ({ ok: true, messages: [] }),
      getChannelHistory: async (input) => {
        params = input;
        return { ok: true, messages: [
          { ts: "1899990000.000", user: "U0", text: "distant" },
          { ts: "1899999999.000", user: "U1", text: "nearby", files: [{ id: "F1", name: "brief.pdf", mimetype: "application/pdf" }] },
          { ts: "1899999999.500", user: "UBOT", text: "TACT echo" },
          { ts: "1899999999.700", subtype: "channel_join", text: "noise" },
        ] };
      },
    }, { tactBotUserId: "UBOT" });
    results.push(check("[context channel] bounded preceding human message + trigger, with safe attachment reference", params?.channel === "C1" && params?.latest === "1900000000.000" && params?.limit === SLACK_CHANNEL_CONTEXT_MAX_PRECEDING_MESSAGES && evidence.messages.length === 2 && evidence.messages[0].attachments?.[0]?.sourceRef === "F1" && evidence.messages[0].attachments?.[0]?.kind === "pdf"));
  }
  {
    const evidence = await retrieveSlackConversationContext(trigger, {
      getThreadReplies: async () => ({ ok: true, messages: [] }),
      getChannelHistory: async () => { throw new Error("missing_scope"); },
    });
    results.push(check("[context failure] retrieval failure preserves trigger-only Work intake", evidence.provenance.retrievalMode === "trigger_only" && evidence.metrics.retrievalFailed && evidence.messages.length === 1));
  }
  results.push(check("[context bounds] thread and channel limits are deliberately bounded", SLACK_THREAD_CONTEXT_MAX_MESSAGES === 15 && SLACK_CHANNEL_CONTEXT_MAX_PRECEDING_MESSAGES === 8));
  return summarize("Slack Conversation Context", results);
}
