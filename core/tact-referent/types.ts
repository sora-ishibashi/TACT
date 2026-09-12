// =========================
// TACT Referent — Canonical Types (REF-P1a: Referential Intelligence
// Foundation)
// =========================
//
// ARCH-REF-1 Final Design Freeze Audit で確定したReferent Resolution層の
// canonical typeをそのまま型化する。P1aはtype定義とoffline evaluation
// harnessの構築のみを行う——DiscourseFocus再構築・ReferentSignal抽出・
// CommunicationCandidate生成・Evidence評価・Conflict検出・実際の
// resolver本体は、いずれもP1b/P1c以降のscope(このfileは純粋な
// domain type定義のみで、それらのロジックを一切含まない)。
//
// 絶対条件(Design Freeze §23 Module Dependency、frozen):
//   - core/tact-integration配下のprovider adapter(composio等)を
//     一切importしない
//   - core/tact-work/approval.ts・approvalIntegrity.ts・
//     core/tact-integration/execution.ts・core/tact-bot配下のいずれも
//     importしない(Referent ResolutionはApproval/Authorizationの
//     下流であり、逆方向のimportは発生させない)
//   - Supabase/Composio/LLM/Slack APIのいずれにも依存しない、純粋な
//     domain type定義のみ
//
// このfile自体はWork/Approval/Provider実装のいずれにも依存しない
// (完全に自己完結したtype定義)。WorkRequestType(既存canonical、
// core/tact-work/types.ts)の再利用はtest側(tests/tact/referent/
// fixtures.ts)でのみ行い、このcanonical types.ts自体には持ち込まない
// ——このfileの依存面をゼロに保つため。

// =========================
// DiscourseFocus (Design Freeze §4, frozen)
// =========================
//
// 完全にephemeral: turnごとにConversationEvidenceから再構築される
// だけであり、どのtableにも永続化されない(Work/Approval/
// Clarificationのいずれにも書き込まれない)。Workを上書きする権限は
// 無い——topicStackの先頭がWork.subjectと重ならない場合は、
// DiscourseFocus自身が別のWorkへ再割り当てを行うのではなく、
// ReferentConflict(severity: "fatal")として表現される(P1c以降で
// 実装される判定ロジックのための型のみ、ここでは定義しない)。
//
// 絶対条件(Design Freeze §9、frozen): 追加の投機的field
// (participantRoles/commonGround/focusedArtifacts等)は導入しない。

export type DiscourseTopicKind =
  | "introduced"
  | "reactivated"
  | "corrected"
  | "deprioritized";

export interface DiscourseTopic {

  entityOrSubject: string;

  // 発言(prior message)内での出現順序。DiscourseFocusは常に
  // ConversationEvidence.messagesという既存のbounded evidenceから
  // 再構築されるため、この値はそのindexをそのまま使う想定
  // (新しいtimestamp概念を持ち込まない)。
  mentionIndex: number;

  kind: DiscourseTopicKind;

}

export interface DiscourseFocus {

  // 配列の先頭(index 0)が現在最も優先されるtopicという規約にはしない
  // ——「スタック」という設計意図(Design Freeze §4/§12)を型でも
  // 表現するため、消費側は末尾(最後の要素)を現在の最優先topicとして
  // 扱う(配列へのpushで「上に積む」動作を素直に表現できる)。
  readonly topicStack: readonly DiscourseTopic[];

}

// =========================
// ReferentSignalProvenance / ReferentSignal (Design Freeze §5, frozen)
// =========================
//
// 絶対条件: provenanceはmessage本文を一切保持しない
// (messageRef/clarificationId/workId+slotという参照のみ)。opaqueな
// 文字列パース("slack_message_ref:<ref>"のような1本の文字列を後で
// 分解する設計)ではなく、構造化されたdiscriminated unionとして表現
// する(Design Freeze指示: 「安全でクリーンならstructured typeを
// 優先」)。

export type ReferentSignalProvenance =
  | { readonly kind: "current_trigger" }
  | { readonly kind: "slack_message_ref"; readonly messageRef: string }
  | { readonly kind: "work_subject" }
  | { readonly kind: "clarification_selection"; readonly clarificationId: string }
  | { readonly kind: "previous_pinned_referent"; readonly workId: string; readonly slot: string };

export type ReferentSignalKind = "entity" | "subject" | "sender" | "time" | "action";

// "direct" = 認証済み現在ユーザー自身のtextに文字通り含まれる値。
// "inferred" = directな値からの決定論的変換(例: 「昨日」directから
// 具体的な日付をinferred)。REF-P1にLLM由来のsignalは存在しないが、
// この区分自体は将来のLLM-assisted抽出(Design Freeze §25、あくまで
// 将来のguardrail)が同じ形へ接続できるよう、現時点から予約しておく。
export type ReferentSignalDirectness = "direct" | "inferred";

export interface ReferentSignal {

  kind: ReferentSignalKind;

  value: string;

  directness: ReferentSignalDirectness;

  provenance: ReferentSignalProvenance;

}

// =========================
// CommunicationCandidate (Design Freeze §6, frozen)
// =========================
//
// 絶対条件(Design Freeze Audit31): REF-P1はGmail専用であり、
// universalなCanonicalReferent抽象は導入しない。将来別Providerが
// 実際に必要になった時点で初めてunion化を検討する(現時点で1メンバー
// だけのunionを先取りして作らない、過剰な抽象化回避)。

export type CommunicationCandidateDirection = "inbound" | "unknown";
// 絶対条件(Design Freeze §17/§18、Audit17): "outbound"を自動的に
// 断定する値は存在しない——connected account自身のaddressを取得する
// 手段が現行repoに無いため(直接確認済み、core/tact-integration/
// types.tsのConnectionにemail/account address相当のfieldは無い)。
// directionを正のWRITE evidenceとして使うことはP1c以降でも禁止
// (この型定義自体は判定ロジックを持たない)。

export interface CommunicationCandidate {

  kind: "gmail_message";

  messageId: string;

  threadId?: string;

  // parseSingleAddress()相当の、angle-bracket抽出済みの単一address
  // のみを想定する(display nameや複数addressの生文字列は含めない)。
  sender?: string;

  // 正規化済みsubjectのみ(Re:/Fwd:等のprefix除去・空白正規化後)。
  normalizedSubject?: string;

  observedAt?: string;

  direction: CommunicationCandidateDirection;

}

// =========================
// SourceReferentSnapshot (Design Freeze §17, frozen)
// =========================
//
// 絶対条件: これはProvider実行inputではなく、TACTのprovenance/
// integrity metadataである。Composio固有ID・生payload・message本文・
// snippet・生のFromヘッダ・正規化前subject・connectionIdのいずれも
// 持たない(connectionIdは既存のApprovalSubject.connectionId
// (core/tact-work/approvalIntegrity.ts)が既に別途保持するため、
// ここでの重複は行わない——Design Freeze §17の明示的結論)。

export interface SourceReferentSnapshot {

  sourceType: "gmail";

  // TACT側で既に正規化済みのcanonical message id
  // (GmailMessageSummary.messageId相当)。Composio内部idそのものでは
  // ない。
  sourceMessageRef: string;

  threadRef?: string;

  sender: string;

  normalizedSubject: string;

  observedAt?: string;

}

// =========================
// Evidence family / tier (Design Freeze §7/§8, frozen)
// =========================
//
// familyは「どのfieldから読んだか(origin field)」を基準に分類する
// ——phrasingのバリエーション(exact/normalized/substring/company/
// topic match等)は同じ1つのfamilyへ収束させる(Design Freeze §18
// Correlated Evidence Protectionの中核。例: 1つのcandidate.subject
// 文字列から5通りの「一致」を検出しても、familyとしては1件のみ)。

export type EvidenceTier = "A" | "B" | "C";

export type EvidenceFamily =
  | "candidate.subject"
  | "candidate.sender"
  | "candidate.thread"
  | "candidate.time"
  | "candidate.direction"
  | "slack.explicit_subject"
  | "slack.explicit_sender"
  | "work.subject"
  | "clarification.selection"
  | "prior_pinned_referent";

export type ReferentEvidenceRole = "supporting" | "conflicting";

export interface ReferentEvidence {

  tier: EvidenceTier;

  family: EvidenceFamily;

  role: ReferentEvidenceRole;

  provenance: ReferentSignalProvenance;

  // P1a時点では機械可読な自由文字列にとどめる(bounded、ただし型として
  // 強制はしない)。具体的なreason code enumはP1c
  // (実際のtier/conflict判定ロジックが確定した時点)で導入する——
  // 判定ロジックが存在しないP1aで先取りして網羅的なenumを列挙しない
  // (過剰taxonomy回避、Design Freeze全体で繰り返された原則)。
  reasonCode: string;

  // このevidenceがどのcandidateを裏付ける/対立するかの参照
  // (CommunicationCandidate.messageId)。work.subjectのようにcandidate
  // 非依存のevidenceの場合はundefined。
  candidateRef?: string;

}

// =========================
// Conflict (Design Freeze §9, frozen)
// =========================

export type ConflictSeverity = "fatal" | "material" | "weak";

export interface ReferentConflict {

  severity: ConflictSeverity;

  reasonCode: string;

  candidateRefs: readonly string[];

  evidenceFamilies?: readonly EvidenceFamily[];

}

// =========================
// Search completeness (Design Freeze §11 + IMPORTANT SPEC
// CLARIFICATION、frozen)
// =========================
//
// 絶対条件(このphaseで明示的に修正された点): broad entity-only
// searchは、結果件数がceiling未満であっても、WRITEにとって
// candidate universeの完全性を証明しない。frozen worked exampleの
// 記述(broad searchで1件だけ返ったので即resolvedとした例)は
// illustrativeに過ぎず、Search Completeness Ruleの方が authoritative
// である(このphaseの指示に明記された優先順位)。
//
// provenは呼び出し元が自由に立てられるbooleanではなく、常に
// isWriteSearchComplete()の出力である——fixture/将来のresolverの
// いずれも、broad×ceiling未満のケースでproven: trueを自己申告できない
// ようにするため、値の計算をこの1箇所に閉じ込める。

export type SearchQueryMode = "broad" | "narrowed";

export interface SearchCompletenessInput {

  mode: SearchQueryMode;

  resultCount: number;

  ceilingHit: boolean;

  // mode === "narrowed"の場合、その絞り込みに使われたevidence family
  // (§11: 絞り込みに使えるのは明示的なTier-A/B signalのみという
  // frozen ruleの追跡用)。
  narrowedBy?: EvidenceFamily;

}

export interface SearchCompletenessAssessment extends SearchCompletenessInput {

  proven: boolean;

}

export function isWriteSearchComplete(input: SearchCompletenessInput): boolean {

  if (input.ceilingHit) {
    // ceiling到達 = 完全性が証明されていない(母集団に何件残っているか
    // 不明)。件数の質に関わらず即falseとする。
    return false;
  }

  if (input.mode === "broad") {
    // 絶対条件(IMPORTANT SPEC CLARIFICATION): broad entity-only search
    // は結果件数がどれだけ少なくても、それ単独ではWRITEのcandidate
    // universe完全性を証明しない。
    return false;
  }

  return true;

}

export function assessSearchCompleteness(
  input: SearchCompletenessInput
): SearchCompletenessAssessment {

  return { ...input, proven: isWriteSearchComplete(input) };

}

// =========================
// Resolution state machine (Design Freeze §20/§21/§26, frozen)
// =========================
//
// 絶対条件: candidate universeの不完全性は7つ目のstateとして追加
// しない——insufficient_evidence/ambiguous等、既存stateのreasonCode
// (自由文字列、上記と同じ理由でP1aでは網羅的enum化しない)経由で
// 表現する。

export type ReferentResolutionState =
  | "resolved"
  | "ambiguous"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "stale"
  | "unavailable";

export type ReferentResolution =
  | {
      state: "resolved";
      winner: CommunicationCandidate;
      evidence: readonly ReferentEvidence[];
      conflicts: readonly ReferentConflict[];
      searchCompleteness: SearchCompletenessAssessment;
    }
  | {
      state: "ambiguous";
      candidates: readonly CommunicationCandidate[];
      evidence: readonly ReferentEvidence[];
      conflicts: readonly ReferentConflict[];
    }
  | {
      state: "insufficient_evidence";
      candidateCount: number;
      reasonCode: string;
    }
  | {
      state: "conflicting_evidence";
      candidates: readonly CommunicationCandidate[];
      conflicts: readonly ReferentConflict[];
    }
  | {
      state: "stale";
      reasonCode: string;
      // stale判定の対象となった、以前pinされていたreferent(あれば)。
      priorReferent?: SourceReferentSnapshot;
    }
  | {
      state: "unavailable";
      reasonCode: string;
    };
