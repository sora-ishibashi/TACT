// =========================
// TACT Referent — Offline Fixture Format (REF-P1a)
// =========================
//
// Slack/Gmail/Composio/Supabase/LLMのいずれにも接続しない、完全に
// 決定論的・network-freeなfixture形式。ReferentFixtureは「ある入力
// (Slack conversation + Work + Gmail candidate群 + search context)に
// 対して、resolverはどう振る舞うべきか」というground truthを表現する
// ——REF-P1a時点ではresolver本体が存在しないため、これらのfixtureは
// 「将来のresolverが満たすべき契約」を先に固定する目的で存在する
// (tests/tact/referent/referentHarness.test.tsが、synthetic/mockな
// resolution結果に対してevaluateReferentFixture()を通し、harness自体の
// 分類ロジックを検証する)。
//
// 既存canonical typeの再利用(重複禁止、このphaseの明示的指示):
//   - ConversationEvidenceMessage: core/tact-conversation/
//     conversationEvidence.ts(既存、再定義しない)
//   - WorkRequestType: core/tact-work/types.ts(既存canonical、
//     "inspect"|"prepare"|"act"|"monitor"|"unknown"。第2のrequest
//     type modelを作らない)
//   - CommunicationCandidate等: core/tact-referent/types.ts
//     (このphaseで新設した型)
//
// 依存方向についての注記: このfileはtest専用であり、
// core/tact-referent/types.ts自体はWorkRequestTypeを一切importしない
// (canonical types.tsの依存面をゼロに保つ、Design Freeze §23の精神)。
// type-onlyのimportであり、ランタイムの循環依存は発生しない。

import type { ConversationEvidenceMessage } from "../../../core/tact-conversation/conversationEvidence";
import type { WorkRequestType } from "../../../core/tact-work/types";
import type {
  CommunicationCandidate,
  EvidenceFamily,
  ReferentResolutionState,
  SearchQueryMode,
} from "../../../core/tact-referent/types";

// =========================
// Ground truth classification
// =========================
//
// WRONG_TARGET_AUTO_RESOLUTIONとUNSAFE_AUTO_RESOLUTIONを区別するために
// 最低限必要な3値(このphaseの明示的指示)。
//
//   correct_auto_resolution: resolverは自動解決してよい。正しい勝者が
//     1つ定まっている。
//   expected_clarification: resolverは自動解決してはならず、
//     ambiguous/conflicting_evidenceとしてclarifyすべき。
//   expected_fail_closed: resolverは自動解決してはならず、
//     insufficient_evidence/unavailable/staleとしてfail closedすべき
//     (clarifyする候補すら安全に提示できない状態)。
export type GroundTruthClassification =
  | "correct_auto_resolution"
  | "expected_clarification"
  | "expected_fail_closed";

export interface ReferentFixtureSearchContext {

  mode: SearchQueryMode;

  resultCount: number;

  ceilingHit?: boolean;

  narrowedBy?: EvidenceFamily;

}

export interface ReferentFixtureExpectation {

  // DiscourseFocus.topicStackの最終的な最優先topic(末尾要素)の
  // entityOrSubject。discourse挙動を検証しないfixtureではundefinedで
  // 良い。
  discourseFocusTop?: string;

  resolutionState: ReferentResolutionState;

  // resolutionState === "resolved"の場合のみ意味を持つ、正解の
  // CommunicationCandidate.messageId。
  winnerMessageId?: string;

  // ambiguous/conflicting_evidenceで提示されるべきcandidate数
  // (Clarificationのcandidate_snapshot件数に相当)。
  clarificationCandidateCount?: number;

  classification: GroundTruthClassification;

  // 「resolverが判定を誤った」のではなく「候補集合自体に正解が
  // 含まれていない」ことを示すfixture固有のground truth
  // (Design Freeze §26 candidate_recall_failureの情報源)。
  // actual/expectedの比較から推測せず、fixture作者が明示的に宣言する
  // ——このphaseではsearch実装が無いため、推測ロジックを持ち込まない。
  candidateRecallFailure?: boolean;

}

export interface ReferentFixture {

  id: string;

  description: string;

  slackMessages: readonly ConversationEvidenceMessage[];

  currentTrigger: string;

  work: { subject: string };

  gmailCandidates: readonly CommunicationCandidate[];

  requestType: WorkRequestType;

  searchContext: ReferentFixtureSearchContext;

  expected: ReferentFixtureExpectation;

}

// =========================
// Seed fixtures
// =========================
//
// 絶対条件(このphaseの明示的指示): 50件の最終blocking fixtureを
// このphaseで全て書かない。P1aはfixture構造自体を確立し、harnessを
// 証明するのに十分な代表seedのみを含む(8〜12件、指示どおり12件)。
// resolver本体が存在しないため、いずれもdata-onlyのcontract fixtureで
// あり、「fixtureを通すためだけの場当たり的なresolution実装」は
// 一切行っていない(このfileはresolverを一切importしない)。

// REF-P1b(discourse.test.ts/signals.test.ts)からも再利用する、
// 最小限のtest-only helper。本番コードには一切影響しない。
export function candidate(
  overrides: Partial<CommunicationCandidate> & Pick<CommunicationCandidate, "messageId">
): CommunicationCandidate {
  return {
    kind: "gmail_message",
    direction: "unknown",
    ...overrides,
  };
}

export function slackMessage(
  overrides: Partial<ConversationEvidenceMessage> & Pick<ConversationEvidenceMessage, "messageRef" | "text">
): ConversationEvidenceMessage {
  return {
    timestamp: "2026-09-01T00:00:00.000Z",
    relationship: "prior_channel_message",
    ...overrides,
  };
}

export const REFERENT_FIXTURES: readonly ReferentFixture[] = [

  // 1. unique exact subject
  {
    id: "WRITE_EXACT_SUBJECT_UNIQUE",
    description:
      "ユーザーが件名を直接引用し、その件名が候補内で一意に1件だけ一致する。narrowed searchでcompletenessも証明されている。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "TACTテスト商事から更新案件の追加確認メール来てる" }),
    ],
    currentTrigger: "「更新案件の追加確認」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({
        messageId: "m1",
        threadId: "t1",
        sender: "tanaka@example.com",
        normalizedSubject: "更新案件の追加確認",
        observedAt: "2026-09-11T02:00:00.000Z",
        direction: "inbound",
      }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m1",
      classification: "correct_auto_resolution",
    },
  },

  // 2. same Work, multiple communications (PREPARE)
  {
    id: "PREPARE_SAME_WORK_MULTIPLE_COMMUNICATIONS",
    description:
      "同じWorkに紐づく複数のメールが存在し、件名/送信者が異なるため下書き内容が候補ごとに実質的に変わる。PREPAREでもcandidate依存の内容差がある限りclarifyが必要(Design Freeze §12 Audit27)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "TACTテスト商事の更新案件、進捗どうなってる" }),
    ],
    currentTrigger: "返信案作って",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "sato@example.com", normalizedSubject: "契約条件の確認", direction: "inbound" }),
    ],
    requestType: "prepare",
    searchContext: { mode: "broad", resultCount: 2, ceilingHit: false },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // 3. same subject + same sender twin
  {
    id: "WRITE_SAME_SUBJECT_SENDER_TWIN",
    description:
      "2件の候補がcandidate.subjectとcandidate.senderの両familyで一致するが、第3の差別化要因(thread/time/prior pin)が無い。Design Freeze §10 WRITEルールの(2)括弧内条件により、この2familyだけでは自動解決できず、Material Conflictとして扱う(§9 Audit3)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "田中さんから契約更新についてまたメール来てる" }),
    ],
    currentTrigger: "これ返しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", threadId: "t1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", observedAt: "2026-06-01T00:00:00.000Z", direction: "inbound" }),
      candidate({ messageId: "m2", threadId: "t2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", observedAt: "2026-09-01T00:00:00.000Z", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_sender" },
    expected: {
      resolutionState: "conflicting_evidence",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // 4. broad-entity-only candidate universe
  {
    id: "WRITE_BROAD_ENTITY_ONLY",
    description:
      "候補は1件のみだが、company/entity名だけによるbroad searchでありnarrowed re-queryを行っていない。IMPORTANT SPEC CLARIFICATION: 結果件数がceiling未満であっても、broad entity-only searchはWRITEのcandidate universe完全性を証明しない——1件しか無いことは自動解決の根拠にならない。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の件メール来てる" }),
    ],
    currentTrigger: "これ対応しといて",
    work: { subject: "A社の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "contact@a-corp.example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 1, ceilingHit: false },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
    },
  },

  // 5. ambiguous WRITE
  {
    id: "WRITE_AMBIGUOUS_TWO_CANDIDATES",
    description:
      "件名・送信者いずれも異なる2つの候補が同程度の弱いevidenceしか持たない、素直なambiguousケース。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の見積の件と、B社の更新の件、両方来てたと思う" }),
    ],
    currentTrigger: "これ対応しといて",
    work: { subject: "A社の見積案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "a@example.com", normalizedSubject: "お見積りについて", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "b@example.com", normalizedSubject: "更新のご案内", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 2, ceilingHit: false },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // 6. ambiguous READ
  {
    id: "READ_MULTIPLE_PLAUSIBLE",
    description:
      "READ(inspect)は複数候補の提示自体を許容するが、resolution stateとしては依然ambiguousである(risk-aware gateがREAD向けにどう見せるかは後続phaseの責務、resolverのstate分類自体は変わらない、Design Freeze §12)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "TACTテスト商事の更新案件について確認して" }),
    ],
    currentTrigger: "このメール確認して",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", direction: "inbound" }),
    ],
    requestType: "inspect",
    searchContext: { mode: "broad", resultCount: 2, ceilingHit: false },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // 7. stale expected outcome
  {
    id: "STALE_EXPIRED_CLARIFICATION_PIN",
    description:
      "以前pinされたClarification候補が、期限切れ(expiresAt経過)または無効化条件により、もはや安全に再利用できない。新しいsearchで黙って再解決してはならない(Design Freeze §13/§20)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "月曜に聞いた件、対応して" }),
    ],
    currentTrigger: "1",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "clarification.selection" },
    expected: {
      resolutionState: "stale",
      classification: "expected_fail_closed",
    },
  },

  // 8. provider unavailable
  {
    id: "UNAVAILABLE_PROVIDER_TIMEOUT",
    description:
      "Gmail検索そのものがtimeout/失敗した。より弱いevidenceへフォールバックしてWRITEしてはならない(Design Freeze Audit5、絶対条件)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の更新案件、返信して" }),
    ],
    currentTrigger: "これ対応しといて",
    work: { subject: "A社の更新案件" },
    gmailCandidates: [],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 0, ceilingHit: false },
    expected: {
      resolutionState: "unavailable",
      classification: "expected_fail_closed",
    },
  },

  // 9. topic interruption + reactivation
  {
    id: "DISCOURSE_REACTIVATION",
    description:
      "A社の話題の後にB社の話題へ割り込まれ、「さっきのA社の件」で明示的にA社へ戻る。DiscourseFocus.topicStackの末尾はA社に戻り、A社候補のみがslack.explicit_subject + work.subjectの2 familyを満たしnarrowed searchで解決できる。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？", relationship: "prior_channel_message" }),
      slackMessage({ messageRef: "s2", text: "B社の見積も来てる", relationship: "prior_channel_message" }),
      slackMessage({ messageRef: "s3", text: "さっきのA社の件だけど", relationship: "prior_channel_message" }),
    ],
    currentTrigger: "これ対応しといて",
    work: { subject: "A社の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
      candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "お見積りについて", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      discourseFocusTop: "A社",
      resolutionState: "resolved",
      winnerMessageId: "m-a",
      classification: "correct_auto_resolution",
    },
  },

  // 10. correction
  {
    id: "DISCOURSE_CORRECTION",
    description:
      "「A社の件… あ、B社だった」という自己訂正。訂正は上書きであり、平均化・両論併記してはならない(Design Freeze §22)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の件なんだけど", relationship: "prior_channel_message" }),
      slackMessage({ messageRef: "s2", text: "あ、B社だった", relationship: "prior_channel_message" }),
    ],
    currentTrigger: "これ確認して",
    work: { subject: "B社の見積案件" },
    gmailCandidates: [
      candidate({ messageId: "m-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
      candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "お見積りについて", direction: "inbound" }),
    ],
    requestType: "inspect",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "work.subject" },
    expected: {
      discourseFocusTop: "B社",
      resolutionState: "resolved",
      winnerMessageId: "m-b",
      classification: "correct_auto_resolution",
    },
  },

  // 11. clarification selection (prior pin, Tier A)
  {
    id: "CLARIFICATION_SELECTION_PINNED",
    description:
      "直前のターンでユーザーがClarificationの候補2を選択済み。その選択はTier-Aとして機能し、同じWork/slotについての後続ターンは即座に解決できる(Design Freeze §8/§15)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "1件目は違う、2件目の方" }),
    ],
    currentTrigger: "それで対応して",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "clarification.selection" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m2",
      classification: "correct_auto_resolution",
    },
  },

  // 12. search ceiling reached
  {
    id: "SEARCH_CEILING_REACHED",
    description:
      "broad searchがmaxResults(20)に到達した——母集団の完全性が証明されないため、件数に関わらずWRITEは自動解決できない(Design Freeze §11 search-completeness precondition)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社関連のメール、対応して" }),
    ],
    currentTrigger: "これ対応して",
    work: { subject: "A社の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 20, ceilingHit: true },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
      candidateRecallFailure: true,
    },
  },

];
