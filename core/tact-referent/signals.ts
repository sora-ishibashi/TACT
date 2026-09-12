// =========================
// TACT Referent — ReferentSignal Extraction (REF-P1b)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit §5で確定した、決定論的な
// ReferentSignal抽出を実装する。入力はConversationEvidence相当の
// 正規化済みdomain値(prior messages・現在のtrigger text)・Work
// subject・既存canonical WorkRequestType・注入可能なreferenceTimeの
// みであり、Provider呼び出し・LLM呼び出し・DB/env var読み取りは
// 一切無い純粋関数。
//
// 絶対条件(このphaseの明示的指示、frozen):
//   - signal kindは既存5種(entity/subject/sender/time/action)のみ。
//     新しいcategoryを追加しない。
//   - clarification_selection/previous_pinned_referentのprovenanceは
//     このphaseでは一切生成しない(将来phaseの本番input)。
//   - requestTypeは常に呼び出し元から渡された既存canonical値をそのまま
//     使う——historical messageから独自にrequestTypeを再分類しない
//     (現在のtriggerのみがrequestTypeの権威という既存不変条件を
//     そのまま継承する)。
//   - Date.now()を関数内部で直接呼ばない。referenceTimeを注入する
//     ことでtestを決定論的に保つ。
//
// 依存方向: ConversationEvidenceMessage(core/tact-conversation/)・
// WorkRequestType(core/tact-work/types.ts)を型のみ利用する。
// core/tact-integration・core/tact-bot配下・core/tact-work/approval*.ts・
// execution.tsのいずれもimportしない。

import type { ConversationEvidenceMessage } from "../tact-conversation/conversationEvidence";
import type { WorkRequestType } from "../tact-work/types";
import { ENTITY_NAME_CHAR, extractEntityMentions } from "./discourse";
import type { ReferentSignal, ReferentSignalProvenance } from "./types";

export interface ExtractReferentSignalsInput {

  priorMessages: readonly ConversationEvidenceMessage[];

  currentTriggerText: string;

  // Work.subject(既存canonical、任意)。work_subject signalの元。
  workSubject?: string;

  // 既存canonical WorkRequestType(core/tact-work/types.ts)をそのまま
  // 使う——第2のrequest type modelを作らない(このphaseの明示的指示)。
  requestType: WorkRequestType;

  // 「昨日」「今日」等の相対時間表現をinferred signalへ変換するための
  // 基準時刻。呼び出し元が注入する(決定論性のため、この関数内部で
  // Date.now()を呼ばない)。
  referenceTime: Date;

}

// =========================
// 引用subject抽出
// =========================
//
// core/tact-intent/ruleRouter.tsのSLACK_QUOTED_TEXT_PATTERNと同じ
// 「「」『』"のいずれかで囲まれた部分」という既存の引用抽出慣習を
// 踏襲する(意図的に同一moduleからimportはしない——Slack送信intent
// 解析という別関心事のためのexportされていないpatternであり、
// 「同じ慣習を採用する」ことと「別関心事のmoduleへ依存する」ことは
// 別判断のため)。
const QUOTED_TEXT_PATTERN = /[「『"](.+?)["』」]/gu;

// 引用部分が「メール/件名」等、communicationの文脈で語られている
// 場合のみsubject signalとして扱う(絶対条件:
// 「conversation wording plausibly refers to a communication/document
// subject」の場合のみ発火させる、Work subjectを無条件にsubject signal
// 化しない)。既存core/tact-context-resolution/index.tsの
// mentionsCommunication()と同じ判定語彙を踏襲する(あちらは
// ConversationEvidence全体に対する判定、こちらは1メッセージ単位の
// 判定という違いのみ)。
const COMMUNICATION_CONTEXT_PATTERN = /(?:メール|gmail|e-mail|mail|件名|受信|先方から)/iu;

// =========================
// sender抽出
// =========================
//
// 絶対条件: 企業/entityへの単純な言及("A社の件")だけではsenderに
// ならない——明示的に「から」(送信元を示す助詞)が伴う場合のみsender
// signalとする。
const EMAIL_SENDER_PATTERN = /([^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+)\s*から/u;
// discourse.tsのENTITY_MENTION_PATTERNと同じ理由(ひらがなの助詞を
// entity captureへ巻き込まない)で、氏名部分もひらがな以外
// (漢字/カタカナ/英数字)に限定する——「さんから」自体はひらがなの
// 接尾辞として別途literalで要求するため問題ない。
const NAMED_PERSON_SENDER_PATTERN = new RegExp(
  `([${ENTITY_NAME_CHAR}][${ENTITY_NAME_CHAR}ー]{0,15}さん)から`,
  "u"
);
const ENTITY_SENDER_PATTERN = new RegExp(
  `([${ENTITY_NAME_CHAR}][${ENTITY_NAME_CHAR}ー・.]{0,47}?(?:社|商事|株式会社))から`,
  "u"
);

// =========================
// time抽出
// =========================

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function isoDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

interface RelativeTimeCue {
  direct: string;
  pattern: RegExp;
  daysOffset: number;
}

const RELATIVE_TIME_CUES: readonly RelativeTimeCue[] = [
  { direct: "今日", pattern: /今日/u, daysOffset: 0 },
  { direct: "昨日", pattern: /昨日/u, daysOffset: -1 },
  { direct: "一昨日", pattern: /一昨日/u, daysOffset: -2 },
];

// =========================
// 内部builder
// =========================

function pushEntitySignals(
  signals: ReferentSignal[],
  text: string,
  provenance: ReferentSignalProvenance
): void {
  for (const entity of extractEntityMentions(text)) {
    signals.push({ kind: "entity", value: entity, directness: "direct", provenance });
  }
}

function pushSubjectSignals(
  signals: ReferentSignal[],
  text: string,
  provenance: ReferentSignalProvenance
): void {

  if (!COMMUNICATION_CONTEXT_PATTERN.test(text)) {
    return;
  }

  const seen = new Set<string>();

  for (const match of text.matchAll(QUOTED_TEXT_PATTERN)) {
    const quoted = match[1]?.trim();
    if (!quoted || seen.has(quoted)) continue;
    seen.add(quoted);
    signals.push({ kind: "subject", value: quoted, directness: "direct", provenance });
  }

}

function pushSenderSignals(
  signals: ReferentSignal[],
  text: string,
  provenance: ReferentSignalProvenance
): void {

  const email = text.match(EMAIL_SENDER_PATTERN)?.[1];
  if (email) {
    signals.push({ kind: "sender", value: email.toLowerCase(), directness: "direct", provenance });
    // メール表記が見つかった場合、同じメッセージ内の氏名/entity+から
    // patternは同一送信元を指している可能性が高く、別signalとして
    // 重複させない(絶対条件: 無意味な重複を避ける)。
    return;
  }

  const namedPerson = text.match(NAMED_PERSON_SENDER_PATTERN)?.[1];
  if (namedPerson) {
    signals.push({ kind: "sender", value: namedPerson, directness: "direct", provenance });
    return;
  }

  const entitySender = text.match(ENTITY_SENDER_PATTERN)?.[1];
  if (entitySender) {
    signals.push({ kind: "sender", value: entitySender, directness: "direct", provenance });
  }

}

function pushTimeSignals(
  signals: ReferentSignal[],
  text: string,
  provenance: ReferentSignalProvenance,
  referenceTime: Date
): void {

  for (const cue of RELATIVE_TIME_CUES) {
    if (!cue.pattern.test(text)) continue;
    signals.push({ kind: "time", value: cue.direct, directness: "direct", provenance });
    signals.push({
      kind: "time",
      value: isoDateOnly(addDays(referenceTime, cue.daysOffset)),
      directness: "inferred",
      provenance,
    });
  }

}

function signalDedupeKey(signal: ReferentSignal): string {

  const provenanceKey =
    signal.provenance.kind === "slack_message_ref"
      ? `slack_message_ref:${signal.provenance.messageRef}`
      : signal.provenance.kind === "clarification_selection"
        ? `clarification_selection:${signal.provenance.clarificationId}`
        : signal.provenance.kind === "previous_pinned_referent"
          ? `previous_pinned_referent:${signal.provenance.workId}:${signal.provenance.slot}`
          : signal.provenance.kind;

  return `${signal.kind}:${signal.directness}:${signal.value}:${provenanceKey}`;

}

/**
 * 決定論的・network-freeなReferentSignal抽出。同一inputに対し常に
 * 同じ順序・同じ内容のsignal配列を返す(副作用・I/Oなし)。
 */
export function extractReferentSignals(
  input: ExtractReferentSignalsInput
): readonly ReferentSignal[] {

  const signals: ReferentSignal[] = [];

  for (const message of input.priorMessages) {
    const provenance: ReferentSignalProvenance = { kind: "slack_message_ref", messageRef: message.messageRef };
    pushEntitySignals(signals, message.text, provenance);
    pushSubjectSignals(signals, message.text, provenance);
    pushSenderSignals(signals, message.text, provenance);
    pushTimeSignals(signals, message.text, provenance, input.referenceTime);
  }

  const triggerProvenance: ReferentSignalProvenance = { kind: "current_trigger" };
  pushEntitySignals(signals, input.currentTriggerText, triggerProvenance);
  pushSubjectSignals(signals, input.currentTriggerText, triggerProvenance);
  pushSenderSignals(signals, input.currentTriggerText, triggerProvenance);
  pushTimeSignals(signals, input.currentTriggerText, triggerProvenance, input.referenceTime);

  if (input.workSubject && input.workSubject.trim()) {
    signals.push({
      kind: "subject",
      value: input.workSubject.trim(),
      directness: "direct",
      provenance: { kind: "work_subject" },
    });
  }

  // actionはrequestTypeという既存canonical値からのみ導出する——
  // historical messageやtriggerのtext自体を再解析しない(絶対条件:
  // 現在のtriggerのみがrequestTypeの権威、このphaseはその既存不変
  // 条件を継承するだけで新しい判定ロジックを持たない)。
  signals.push({
    kind: "action",
    value: input.requestType,
    directness: "direct",
    provenance: { kind: "current_trigger" },
  });

  const seen = new Set<string>();
  const deduped: ReferentSignal[] = [];

  for (const signal of signals) {
    const key = signalDedupeKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signal);
  }

  return deduped;

}
