// =========================
// TACT Referent — Offline Fixture Format (REF-P1a, extended in REF-P1c)
// =========================
//
// Slack/Gmail/Composio/Supabase/LLMのいずれにも接続しない、完全に
// 決定論的・network-freeなfixture形式。ReferentFixtureは「ある入力
// (Slack conversation + Work + Gmail candidate群 + search context)に
// 対して、resolverはどう振る舞うべきか」というground truthを表現する。
//
// REF-P1c追記: pinnedReferent/knownThreadRef/sourceAvailability/
// staleReferentは、Clarification/Approval本体がまだwireされていない
// (P1d/P1e以降のscope)ことに対応する、明示的なresolver precondition
// のfixture表現。実際のresolverはfixtureのexpectedを一切参照しない
// (tests/tact/referent/resolverAdapter.tsが、expectedを含まない
// ResolveReferentInputへ変換してから渡す——PART13の明示的指示: fixture
// ground truthを本番/評価対象resolverへ絶対にleakさせない)。
//
// 既存canonical typeの再利用(重複禁止):
//   - ConversationEvidenceMessage: core/tact-conversation/
//     conversationEvidence.ts
//   - WorkRequestType: core/tact-work/types.ts
//   - CommunicationCandidate等: core/tact-referent/types.ts
//   - PinnedReferentInput/KnownThreadRefInput: core/tact-referent/
//     candidates.ts(P1cで新設)
//   - StaleReferentInput: core/tact-referent/resolve.ts(P1cで新設)

import type { ConversationEvidenceMessage } from "../../../core/tact-conversation/conversationEvidence";
import type { WorkRequestType } from "../../../core/tact-work/types";
import type {
  CommunicationCandidate,
  EvidenceFamily,
  ReferentResolutionState,
  SearchQueryMode,
} from "../../../core/tact-referent/types";
import type { KnownThreadRefInput, PinnedReferentInput } from "../../../core/tact-referent/candidates";
import type { StaleReferentInput } from "../../../core/tact-referent/resolve";

// =========================
// Ground truth classification
// =========================

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
  discourseFocusTop?: string;
  resolutionState: ReferentResolutionState;
  winnerMessageId?: string;
  clarificationCandidateCount?: number;
  classification: GroundTruthClassification;
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

  // REF-P1c: Clarification/Approval本体がまだwireされていないことに
  // 対応する、明示的なresolver precondition(すべてoptional、既存
  // fixtureは指定しない限り従来どおり)。
  pinnedReferent?: PinnedReferentInput;

  knownThreadRef?: KnownThreadRefInput;

  sourceAvailability?: "available" | "unavailable";

  staleReferent?: StaleReferentInput;

  expected: ReferentFixtureExpectation;

}

// =========================
// Test-only helper(REF-P1b/P1cからも再利用)
// =========================

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

// 全fixtureで共有する基準時刻(resolverAdapter.tsのextractReferentSignals()
// 呼び出しで使う、tests/tact/referent/signals.test.tsと同じ値)。
// 「昨日」="2026-09-10"に決定論的に変換される。
export const FIXTURE_REFERENCE_TIME = new Date("2026-09-11T09:00:00.000Z");

// =========================
// Fixtures
// =========================
//
// 絶対条件(REF-P1c指示): 50件を機械的に埋めない。30〜40件の
// 「意味のある」fixtureを目標とする(現在30件)。既存12件(REF-P1a)は、
// 実際のresolver実装によって判明した具体的なmechanism
// (explicit quoted subject / explicit email sender / Work.subject
// exact-or-containment match等)に沿うよう、意図・期待結果を変えずに
// wording/dataのみ修正した(P1a時点ではresolver本体が無く、これらの
// mechanismの詳細が未確定だったため)。修正箇所は各fixtureのcomment内に
// 明記する。

export const REFERENT_FIXTURES: readonly ReferentFixture[] = [

  // =========================
  // SUBJECT
  // =========================

  // 1. unique exact subject (既存、変更なし)
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

  // 2. duplicate exact subject, no sender differentiator
  {
    id: "WRITE_DUPLICATE_EXACT_SUBJECT_NO_SENDER",
    description:
      "2件の候補が同じ件名を持つが、送信者情報は明示されていない。exact match唯一性が崩れるためTier Aにならず、subjectのみのTier B(1 family)では自動解決に不十分。",
    slackMessages: [],
    currentTrigger: "「更新案件について」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "sato@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // 3. normalized Re: prefix
  {
    id: "WRITE_SUBJECT_NORMALIZED_RE_PREFIX",
    description:
      "候補の件名が「Re: Re: 更新案件について」という繰り返しprefix付きで格納されているが、正規化後は引用と完全一致する一意な候補になる。",
    slackMessages: [],
    currentTrigger: "「更新案件について」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "Re: Re: 更新案件について", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m1",
      classification: "correct_auto_resolution",
    },
  },

  // 4. normalized Fwd: prefix
  {
    id: "WRITE_SUBJECT_NORMALIZED_FWD_PREFIX",
    description: "候補の件名が「Fwd: 更新案件について」という転送prefix付きで格納されているが、正規化後は一致する。",
    slackMessages: [],
    currentTrigger: "「更新案件について」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "Fwd: 更新案件について", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m1",
      classification: "correct_auto_resolution",
    },
  },

  // 5. meaningful subject difference preserved
  {
    id: "WRITE_SUBJECT_MEANINGFUL_DIFFERENCE_PRESERVED",
    description:
      "「更新案件について」と「更新案件の追加確認」は意味の異なる件名として区別されたままであり、正規化が両者を誤って同一視しない。引用は後者と一意に一致する。",
    slackMessages: [],
    currentTrigger: "「更新案件の追加確認」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m2",
      classification: "correct_auto_resolution",
    },
  },

  // =========================
  // SENDER
  // =========================

  // 6. sender alone insufficient
  {
    id: "WRITE_SENDER_ALONE_INSUFFICIENT",
    description:
      "明示的なメールアドレスsenderが一意に1候補と一致するが、他に独立したfamilyが無い(frozen rule #4: senderのみではTier Aにならず、Tier Bも1familyのみでは不足)。",
    slackMessages: [],
    currentTrigger: "tanaka@example.comから来てたやつ、これ返しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "ご確認のお願い", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "slack.explicit_sender" },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
    },
  },

  // 7. sender + time = 2 independent Tier B families -> resolved
  {
    id: "WRITE_SENDER_PLUS_TIME_RESOLVES",
    description:
      "明示的なメールアドレスsender(candidate.sender)と明示的な「昨日」time hint(candidate.time)という、互いに独立した2つのTier B familyが同じ候補に揃うため、いずれもTier Aではないが安全に自動解決できる。",
    slackMessages: [],
    currentTrigger: "tanaka@example.comから昨日来てたメール、これ返しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "ご確認のお願い", observedAt: "2026-09-10T03:00:00.000Z", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "sato@example.com", normalizedSubject: "別件のご連絡", observedAt: "2026-09-05T03:00:00.000Z", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_sender" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m1",
      classification: "correct_auto_resolution",
    },
  },

  // 8. same sender, many messages
  {
    id: "WRITE_SAME_SENDER_MANY_MESSAGES",
    description:
      "同じ送信者から複数件のメールがあり、件名等それ以外の差別化要因が無いため、senderのみ(1 family)ではどの候補も自動解決に不十分。",
    slackMessages: [],
    currentTrigger: "tanaka@example.comから来てたやつ、これ対応して",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "ご確認のお願い", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "追加のご連絡", direction: "inbound" }),
      candidate({ messageId: "m3", sender: "tanaka@example.com", normalizedSubject: "最終確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 3, ceilingHit: false, narrowedBy: "slack.explicit_sender" },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 3,
      classification: "expected_clarification",
    },
  },

  // =========================
  // TWIN
  // =========================

  // 9. same subject + same sender, no differentiator (既存、mechanismに
  // 合わせてwordingを修正: 「田中さんから」(人名、比較不能)ではなく
  // 明示的なメールアドレスへ変更し、subjectも引用する)
  {
    id: "WRITE_SAME_SUBJECT_SENDER_TWIN",
    description:
      "2件の候補がcandidate.subjectとcandidate.senderの両familyで一致するが、第3の差別化要因(thread/time/prior pin)が無い。Design Freeze §10 WRITEルールの(2)括弧内条件により、この2familyだけでは自動解決できず、Material Conflictとして扱う(§9 Audit3)。",
    slackMessages: [],
    currentTrigger: "「契約更新について」ってメールがtanaka@example.comから来てたと思う、これ返しといて",
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

  // 10. twin + explicit time differentiator -> resolves
  {
    id: "WRITE_TWIN_WITH_TIME_DIFFERENTIATOR",
    description:
      "subject+senderのtwinだが、ユーザーが「昨日」と明示し、片方の候補のobservedAtのみがその日付と一致する。第3の独立したfamily(candidate.time)により、そのcandidateのみが安全に一意化される。",
    slackMessages: [],
    currentTrigger: "「契約更新について」ってメールがtanaka@example.comから昨日来てたやつ、これ返しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", threadId: "t1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", observedAt: "2026-06-01T00:00:00.000Z", direction: "inbound" }),
      candidate({ messageId: "m2", threadId: "t2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", observedAt: "2026-09-10T03:00:00.000Z", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_sender" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m2",
      classification: "correct_auto_resolution",
    },
  },

  // 11. twin + known thread differentiator -> resolves
  {
    id: "WRITE_TWIN_WITH_THREAD_DIFFERENTIATOR",
    description:
      "subject+senderのtwinだが、過去に承認済みのApprovalが特定のthreadRefへ紐づいていた(prior_pinned_referent由来のknownThreadRef)。そのthreadIdを持つ候補のみが第3のfamily(candidate.thread)により安全に一意化される。",
    slackMessages: [],
    currentTrigger: "「契約更新について」ってメールがtanaka@example.comから来てたやつ、これ返しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", threadId: "t1", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" }),
      candidate({ messageId: "m2", threadId: "t2", sender: "tanaka@example.com", normalizedSubject: "契約更新について", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_sender" },
    knownThreadRef: { threadRef: "t2", provenance: { kind: "previous_pinned_referent", workId: "work-fixture-1", slot: "primary" } },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m2",
      classification: "correct_auto_resolution",
    },
  },

  // =========================
  // WORK
  // =========================

  // 12. Work subject overlap only (READ)
  {
    id: "READ_WORK_SUBJECT_OVERLAP_ONLY",
    description:
      "READ(inspect)では、Work.subjectとの部分一致(Tier C)しか無くても、他に競合候補が無ければ一意に解決してよい(frozen: READ may tolerate uncertainty)。work.subjectはTier Bを超えない(frozen rule #6)ため、この評価はTier Cのみで成立している。",
    slackMessages: [],
    currentTrigger: "この件の状況を確認して",
    work: { subject: "見積のご相談" },
    gmailCandidates: [
      candidate({ messageId: "m-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
      candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "見積のご相談について", direction: "inbound" }),
    ],
    requestType: "inspect",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "work.subject" },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m-b",
      classification: "correct_auto_resolution",
    },
  },

  // 13. Work subject alone insufficient for WRITE
  {
    id: "WRITE_WORK_SUBJECT_ALONE_INSUFFICIENT",
    description:
      "READ_WORK_SUBJECT_OVERLAP_ONLYと同じWork.subject一致だが、requestTypeがactの場合はwork.subjectのみ(1 family、しかもTier C)では自動解決できない。",
    slackMessages: [],
    currentTrigger: "この件、対応しといて",
    work: { subject: "見積のご相談" },
    gmailCandidates: [
      candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "見積のご相談について", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 1, ceilingHit: false, narrowedBy: "work.subject" },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
    },
  },

  // 14. multiple messages, same Work, all weakly related (READ)
  {
    id: "READ_MULTIPLE_MESSAGES_SAME_WORK",
    description:
      "同じWorkに関連しそうな3件の候補が、いずれもWork.subjectとの部分一致(Tier C)のみを持ち、互いを区別する材料が無い。READでも一意化できずambiguousになる。",
    slackMessages: [],
    currentTrigger: "この件、確認して",
    work: { subject: "更新のご相談について" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "a@example.com", normalizedSubject: "更新のご相談", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "b@example.com", normalizedSubject: "ご相談について", direction: "inbound" }),
      candidate({ messageId: "m3", sender: "c@example.com", normalizedSubject: "更新について", direction: "inbound" }),
    ],
    requestType: "inspect",
    searchContext: { mode: "broad", resultCount: 3, ceilingHit: false },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 3,
      classification: "expected_clarification",
    },
  },

  // =========================
  // BROAD-ENTITY-ONLY / SEARCH COMPLETENESS
  // =========================

  // 15. broad entity-only candidate universe (既存、変更なし)
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

  // 16. broad, resultCount below ceiling, otherwise-strong evidence -> still not WRITE-complete
  {
    id: "WRITE_BROAD_STRONG_EVIDENCE_STILL_INCOMPLETE",
    description:
      "候補は一意に引用と完全一致する(Tier A相当の強いevidence)が、searchはbroad modeで行われている。IMPORTANT SPEC CLARIFICATION: evidenceの強さに関わらず、broad modeそのものがWRITEのcandidate universe完全性を証明しない。",
    slackMessages: [],
    currentTrigger: "「更新案件の追加確認」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 1, ceilingHit: false },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
    },
  },

  // 17. broad, resultCount=19 (still below ceiling of 20) -> still not complete
  {
    id: "WRITE_BROAD_19_RESULTS_NOT_COMPLETE",
    description: "broad searchが19件返した(ceiling=20未満)としても、broad mode自体がWRITE完全性を証明しないためresolveできない。",
    slackMessages: [],
    currentTrigger: "「更新案件の追加確認」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 19, ceilingHit: false },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
    },
  },

  // 18. search ceiling reached (既存、trigger修正: 強いevidenceがあっても
  // ceiling到達がblockすることを示す)
  {
    id: "SEARCH_CEILING_REACHED",
    description:
      "候補の件名は一意に引用と一致する強いevidenceを持つが、broad searchがmaxResults(20)に到達した——母集団の完全性が証明されないため、evidenceの強さに関わらずWRITEは自動解決できない(Design Freeze §11 search-completeness precondition)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社関連のメール、対応して" }),
    ],
    currentTrigger: "「更新のご連絡」ってメール、これ対応して",
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

  // 19. narrowed but ceiling hit -> still blocked (mode alone doesn't save it)
  {
    id: "WRITE_NARROWED_CEILING_HIT",
    description:
      "narrowed modeであっても、ceilingに到達していれば母集団の完全性は証明されない——narrowedであることとceiling未到達であることの両方が必要。",
    slackMessages: [],
    currentTrigger: "「更新案件の追加確認」ってメール、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 20, ceilingHit: true, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "insufficient_evidence",
      classification: "expected_fail_closed",
    },
  },

  // =========================
  // ACTION (READ / PREPARE / WRITE)
  // =========================

  // 20. ambiguous WRITE (既存、wordingを2つの引用へ修正しどちらの候補にも
  // 独立した弱いevidenceが付くようにした——目的は変えず、evidenceが
  // 実際に存在する状態でambiguousになることを示す)
  {
    id: "WRITE_AMBIGUOUS_TWO_CANDIDATES",
    description: "件名・送信者いずれも異なる2つの候補が、それぞれ独立した弱い(Tier C)evidenceしか持たない、素直なambiguousケース。",
    slackMessages: [],
    currentTrigger: "「見積」と「更新」のメール、これ対応しといて",
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

  // 21. ambiguous READ (既存、引用「更新案件」を追加し両候補にTier Cを
  // 与えるよう修正)
  {
    id: "READ_MULTIPLE_PLAUSIBLE",
    description:
      "READ(inspect)は複数候補の提示自体を許容するが、resolution stateとしては依然ambiguousである(risk-aware gateがREAD向けにどう見せるかは後続phaseの責務、resolverのstate分類自体は変わらない、Design Freeze §12)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "TACTテスト商事の更新案件について確認して" }),
    ],
    currentTrigger: "「更新案件」のメール確認して",
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

  // 22. PREPARE ambiguity (既存、両候補に別々の引用でTier Cを与えるよう
  // 修正——PREPAREはP1cではWRITEと同じ厳格ルールに従う保守的な選択、
  // Part11参照)
  {
    id: "PREPARE_SAME_WORK_MULTIPLE_COMMUNICATIONS",
    description:
      "同じWorkに紐づく複数のメールが存在し、件名/送信者が異なるため下書き内容が候補ごとに実質的に変わる。PREPAREはP1cではWRITEと同じ厳格な評価ルールに従う保守的な実装のため、Tier Cのみの評価では自動解決せずclarifyする(Design Freeze §12 Audit27、PART11の明示的に許容された保守的選択)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "TACTテスト商事の更新案件、進捗どうなってる" }),
    ],
    currentTrigger: "「更新案件」と「契約条件」のメール、返信案作って",
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

  // =========================
  // DISCOURSE
  // =========================

  // 23. topic interruption + reactivation feeding candidate selection
  // (既存、s3に明示的な件名引用を追加——discourse reactivationが
  // 「どのメッセージが関連するか」という文脈を提供し、実際の候補選択は
  // その中の明示的subject引用というTier A mechanismで行われることを
  // 示す。DiscourseFocusとReferent Resolutionの層分離を保つ、Design
  // Freeze §4/§19の帰結)。
  {
    id: "DISCOURSE_REACTIVATION",
    description:
      "A社の話題の後にB社の話題へ割り込まれ、「さっきのA社の件、『更新のご連絡』ってメールだけど」で明示的にA社へ戻りつつ件名も引用する。DiscourseFocus.topicStackの末尾はA社に戻り、referent resolution自体は引用されたsubjectの一意一致(Tier A)によって解決される。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
      slackMessage({ messageRef: "s2", text: "B社の見積も来てる" }),
      slackMessage({ messageRef: "s3", text: "さっきのA社の件、「更新のご連絡」ってメールだけど" }),
    ],
    currentTrigger: "これ対応しといて",
    work: { subject: "A社の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
      candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "お見積りについて", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      discourseFocusTop: "A社",
      resolutionState: "resolved",
      winnerMessageId: "m-a",
      classification: "correct_auto_resolution",
    },
  },

  // 24. correction feeding candidate selection (既存、Work.subject/
  // candidate m-bのsubjectをwork.subject containsマッチが成立する
  // wordingへ修正——READでの一意解決を、実装済みのcompareSubjects()
  // containment ruleで正しく成立させる)
  {
    id: "DISCOURSE_CORRECTION",
    description: "「A社の件… あ、B社だった」という自己訂正。訂正は上書きであり、平均化・両論併記してはならない(Design Freeze §22)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の件なんだけど" }),
      slackMessage({ messageRef: "s2", text: "あ、B社だった" }),
    ],
    currentTrigger: "これ確認して",
    work: { subject: "見積のご相談" },
    gmailCandidates: [
      candidate({ messageId: "m-a", sender: "a@example.com", normalizedSubject: "更新のご連絡", direction: "inbound" }),
      candidate({ messageId: "m-b", sender: "b@example.com", normalizedSubject: "見積のご相談について", direction: "inbound" }),
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

  // =========================
  // STATE (stale / unavailable / clarification pin)
  // =========================

  // 25. clarification selection (prior pin, Tier A) — 既存、
  // pinnedReferentを付与
  {
    id: "CLARIFICATION_SELECTION_PINNED",
    description:
      "直前のターンでユーザーがClarificationの候補2を選択済み。その選択はTier Aとして機能し、同じWork/slotについての後続ターンは即座に解決できる(Design Freeze §8/§15)。",
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
    pinnedReferent: { candidateRef: "m2", provenance: { kind: "clarification_selection", clarificationId: "clarification-fixture-1" } },
    expected: {
      resolutionState: "resolved",
      winnerMessageId: "m2",
      classification: "correct_auto_resolution",
    },
  },

  // 26. stale expected outcome — 既存、staleReferentを付与
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
    staleReferent: { reasonCode: "clarification_expired" },
    expected: {
      resolutionState: "stale",
      classification: "expected_fail_closed",
    },
  },

  // 27. provider unavailable — 既存、sourceAvailabilityを付与
  {
    id: "UNAVAILABLE_PROVIDER_TIMEOUT",
    description: "Gmail検索そのものがtimeout/失敗した。より弱いevidenceへフォールバックしてWRITEしてはならない(Design Freeze Audit5、絶対条件)。",
    slackMessages: [
      slackMessage({ messageRef: "s1", text: "A社の更新案件、返信して" }),
    ],
    currentTrigger: "これ対応しといて",
    work: { subject: "A社の更新案件" },
    gmailCandidates: [],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 0, ceilingHit: false },
    sourceAvailability: "unavailable",
    expected: {
      resolutionState: "unavailable",
      classification: "expected_fail_closed",
    },
  },

  // =========================
  // SECURITY
  // =========================

  // 28. many Tier-C matches cannot resolve WRITE
  {
    id: "WRITE_MANY_TIER_C_CANNOT_RESOLVE",
    description:
      "5件の候補すべてが、Work.subjectとの部分一致(Tier C)のみを持つ。Tier Cは単独でも複数でもWRITEを解決しない(frozen)。",
    slackMessages: [],
    currentTrigger: "この件、対応して",
    work: { subject: "更新のご相談について" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "a@example.com", normalizedSubject: "更新のご相談", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "b@example.com", normalizedSubject: "ご相談について", direction: "inbound" }),
      candidate({ messageId: "m3", sender: "c@example.com", normalizedSubject: "更新について", direction: "inbound" }),
      candidate({ messageId: "m4", sender: "d@example.com", normalizedSubject: "ご相談の更新", direction: "inbound" }),
      candidate({ messageId: "m5", sender: "e@example.com", normalizedSubject: "更新のご相談の件", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 5, ceilingHit: false },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 5,
      classification: "expected_clarification",
    },
  },

  // 29. no newest-message tiebreak
  {
    id: "WRITE_NO_NEWEST_TIEBREAK",
    description:
      "2件の候補がいずれもTier Cのevidenceしか持たないが、一方が明確に新しい(observedAtが新しい)。新しさだけでは自動解決の根拠にならない(frozen: recencyは単独でWRITEを解決しない、no score/newest fallback)。",
    slackMessages: [],
    currentTrigger: "「更新」のメール、これ対応して",
    work: { subject: "A社の更新のご案内について" },
    gmailCandidates: [
      candidate({ messageId: "m-old", sender: "a@example.com", normalizedSubject: "更新について", observedAt: "2026-01-01T00:00:00.000Z", direction: "inbound" }),
      candidate({ messageId: "m-new", sender: "b@example.com", normalizedSubject: "更新のご案内", observedAt: "2026-09-10T23:00:00.000Z", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "broad", resultCount: 2, ceilingHit: false },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // =========================
  // MULTIPLE INDEPENDENT QUALIFIERS / MATERIAL TIME CONTRADICTION
  // =========================

  // 30. Tier A on one candidate, but a second candidate also
  // independently qualifies (via its own unique quote) -> ambiguous,
  // never a score-tiebreak (condition E of the frozen WRITE rule).
  {
    id: "WRITE_TIER_A_PLUS_SECOND_QUALIFIER",
    description:
      "2つの明示的な引用がそれぞれ別の候補と一意に一致し、両方が独立にTier Aとして自動解決の条件を満たしてしまう。frozen rule: 2件以上が独立に条件を満たす場合はambiguousであり、スコアでの比較・tiebreakは行わない。",
    slackMessages: [],
    currentTrigger: "「更新案件について」と「契約条件の確認」のメール、どちらか対応して",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件について", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "sato@example.com", normalizedSubject: "契約条件の確認", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "ambiguous",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

  // 31. explicit time hint contradicts the otherwise-leading (Tier A)
  // candidate, while another candidate matches the stated date.
  {
    id: "WRITE_TIME_CONTRADICTS_LEADING_CANDIDATE",
    description:
      "引用された件名はm1と一意に一致する(Tier A相当)が、ユーザーは「昨日」と明示しており、実際にその日付と一致するのはm2である。件名evidenceとtime evidenceが矛盾するため、m1を安全に自動解決してはならない(Material Conflict、PART6)。",
    slackMessages: [],
    currentTrigger: "「更新案件の追加確認」ってメール、昨日来てたと思うけど、これ対応しといて",
    work: { subject: "TACTテスト商事の更新案件" },
    gmailCandidates: [
      candidate({ messageId: "m1", sender: "tanaka@example.com", normalizedSubject: "更新案件の追加確認", observedAt: "2026-06-01T00:00:00.000Z", direction: "inbound" }),
      candidate({ messageId: "m2", sender: "tanaka@example.com", normalizedSubject: "別件のご連絡", observedAt: "2026-09-10T03:00:00.000Z", direction: "inbound" }),
    ],
    requestType: "act",
    searchContext: { mode: "narrowed", resultCount: 2, ceilingHit: false, narrowedBy: "slack.explicit_subject" },
    expected: {
      resolutionState: "conflicting_evidence",
      clarificationCandidateCount: 2,
      classification: "expected_clarification",
    },
  },

];
