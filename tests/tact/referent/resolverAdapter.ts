// =========================
// TACT Referent — Fixture → Resolver Input Adapter (REF-P1c)
// =========================
//
// 絶対条件(このphaseの明示的指示、PART13、critical): ReferentFixture.
// expected(ground truth)は、実resolverへは絶対に渡さない。この
// adapterはfixtureのinput部分だけをResolveReferentInputへ変換する
// (expectedフィールドには一切触れない)。

import { reconstructDiscourseFocus, currentTopicLabel } from "../../../core/tact-referent/discourse";
import { extractReferentSignals } from "../../../core/tact-referent/signals";
import { assessSearchCompleteness } from "../../../core/tact-referent/types";
import type { ResolveReferentInput } from "../../../core/tact-referent/resolve";
import { FIXTURE_REFERENCE_TIME, type ReferentFixture } from "./fixtures";

export function resolverInputFromFixture(fixture: ReferentFixture): ResolveReferentInput {

  const discourseFocus = reconstructDiscourseFocus(fixture.slackMessages, fixture.currentTrigger);

  const signals = extractReferentSignals({
    priorMessages: fixture.slackMessages,
    currentTriggerText: fixture.currentTrigger,
    workSubject: fixture.work.subject,
    requestType: fixture.requestType,
    referenceTime: FIXTURE_REFERENCE_TIME,
  });

  return {
    candidates: fixture.gmailCandidates,
    signals,
    searchCompleteness: assessSearchCompleteness({
      mode: fixture.searchContext.mode,
      resultCount: fixture.searchContext.resultCount,
      ceilingHit: fixture.searchContext.ceilingHit ?? false,
      narrowedBy: fixture.searchContext.narrowedBy,
    }),
    requestType: fixture.requestType,
    workSubject: fixture.work.subject,
    discourseFocusTop: currentTopicLabel(discourseFocus),
    ...(fixture.sourceAvailability ? { sourceAvailability: fixture.sourceAvailability } : {}),
    ...(fixture.staleReferent ? { staleReferent: fixture.staleReferent } : {}),
    ...(fixture.pinnedReferent ? { pinnedReferent: fixture.pinnedReferent } : {}),
    ...(fixture.knownThreadRef ? { knownThreadRef: fixture.knownThreadRef } : {}),
  };

}
