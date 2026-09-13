import type { ExecutionPreview, ExecutionPreviewBuilder, ExecutionPreviewField } from "./executionPreview";

// =========================
// TACT Work — Gmail Send Execution Preview Builder (APPROVAL-P2)
// =========================
//
// core/tact-work/gmailReplyProposal.ts/gmailReferentCandidates.tsと
// 同じ理由でこのfileへ置く(Gmail write-flow wiringはcore/tact-work/
// 側に集約する既存precedent)。core/tact-integration/typesの
// GmailSendMessageInputを型としてimportせず、この関数自身が
// Approval.payload.action.metadata.input(既にRecord<string,unknown>
// として抽出済みの値)をruntimeで検証する——理由: Approval core
// (core/tact-work/executionPreview.ts)がProvider固有の型に依存しない
// 一方向性を保つため(このfile自体はGmail専用なので依存してよいが、
// 呼び出し側のexecutionPreview.tsは依然としてGmail型を知らない)。
//
// 絶対条件(SIDE-EFFECT FREE PREVIEW): この関数はGmail APIを一切
// 呼ばない・Composioを一切呼ばない・Connectionを解決しない・OAuthを
// refreshしない——既に検証済みのcanonical input(text)だけを読む
// pure関数。
//
// 絶対条件(NO PROVIDER PAYLOAD): 生のGmail API message・Composio
// tool引数のいずれも参照しない(そもそもこの関数の入力にそれらは
// 存在しない、Approval.payload.action.metadata.inputは既にTACT
// canonical inputへ正規化済み)。

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

export const buildGmailSendPreview: ExecutionPreviewBuilder = (action, context) => {

  const input = action.input;

  const to = input.to;
  const subject = input.subject;
  const bodyText = input.bodyText;

  // 絶対条件(PREVIEW / ACTION MISMATCH、fail closed): 想定した
  // canonical shapeと一致しない場合、推測で埋めずundefinedを返す
  // (呼び出し元が「安全に表示できない」として扱う)。
  if (!isNonEmptyStringArray(to) || to.length === 0 || typeof subject !== "string" || typeof bodyText !== "string") {
    return undefined;
  }

  const cc = isNonEmptyStringArray(input.cc) ? input.cc : undefined;
  const bcc = isNonEmptyStringArray(input.bcc) ? input.bcc : undefined;

  const fields: ExecutionPreviewField[] = [
    { label: "送信先", value: to.join(", ") },
    ...(cc && cc.length > 0 ? [{ label: "CC", value: cc.join(", ") }] : []),
    ...(bcc && bcc.length > 0 ? [{ label: "BCC", value: bcc.join(", ") }] : []),
    { label: "件名", value: subject },
    // EXACT BODY(絶対条件): 要約・truncateせず、frozenなbodyTextを
    // そのまま表示する。Slack block文字数上限への対応は
    // renderer側(core/tact-bot/adapters/slack/slackChannelAdapter.ts)
    // の責務であり、このpreview自体は値を切り詰めない。
    { label: "本文", value: bodyText },
    // Gmail送信は現行canonical input(GmailSendMessageInput)に添付
    // fieldが存在しないため、常に「添付ファイルなし」で確定できる
    // (絶対条件: 存在しないfieldを推測で埋めるのではなく、型契約上
    // 保証されている事実だけを表示する)。
    { label: "添付ファイル", value: "添付ファイルなし" },
  ];

  // SOURCE REFERENT DISPLAY: sourceMessageRef/threadRef等の内部IDは
  // 一切使わず、sender/normalizedSubjectという安全なhuman-readable
  // fieldのみを表示する。sourceReferentが無くてもpreviewは成立する。
  if (context?.sourceReferent) {
    fields.push({
      label: "参照元",
      value: `${context.sourceReferent.sender} / ${context.sourceReferent.normalizedSubject}`,
    });
  }

  const preview: ExecutionPreview = {

    version: 1,

    actionLabel: "メールを1通送信",

    service: action.service,

    operation: action.operation,

    target: { label: to.join(", ") },

    summary: "Gmailでメールを1通送信します。",

    fields,

    // EFFECT SEMANTICS: provider marketingではなくaction本来の意味論。
    effects: {
      externalCommunication: true,
      externalWrite: true,
      notification: true,
      destructive: false,
      // IRREVERSIBILITY: TACTは送信後の外部状態(相手の受信箱)を
      // 自動的に取り消せない、という意味(Gmail自体の取り消し送信
      // 機能の有無を断定するものではない)。
      irreversible: true,
    },

    warnings: ["送信後の取り消しはTACTからはできません。"],

  };

  return preview;

};
