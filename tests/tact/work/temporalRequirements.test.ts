import {
  extractTemporalRequirement,
  mergeTemporalRequirements,
  deriveTemporalRequirementPolicy,
  findMissingTemporalRequirements,
  buildTemporalClarificationQuestion,
  toTemporalRequirementMetadata,
  readTemporalRequirementMetadata,
} from "../../../core/tact-work/temporalRequirements";
import { resolveTemporalDateRange } from "../../../core/tact-work/temporalRange";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  const thirtyMinutes = extractTemporalRequirement("30分の会議");
  results.push(check("[extract] 30分 is normalized as durationMinutes", thirtyMinutes.durationMinutes === 30));

  const oneHour = extractTemporalRequirement("1時間の会議");
  results.push(check("[extract] 1時間 is normalized as 60 minutes", oneHour.durationMinutes === 60));

  const nextWeek = extractTemporalRequirement("来週に日程候補を出して");
  results.push(check("[extract] 来週 is represented without inventing a timestamp", nextWeek.date?.kind === "relative" && nextWeek.date.value === "next_week"));

  const concrete = extractTemporalRequirement("来週の14:30に30分の会議");
  results.push(check("[extract] relative range, specific time, and duration coexist", concrete.date?.kind === "relative" && concrete.specificTime === "14:30" && concrete.durationMinutes === 30));

  const deadline = extractTemporalRequirement("金曜までに提出して");
  results.push(check("[extract] deadline-like constraint is recognized", deadline.deadline?.kind === "relative" && deadline.deadline.value === "friday"));

  const candidatePolicy = deriveTemporalRequirementPolicy("来週に会議の日程候補を出して");
  results.push(check("[policy] candidate scheduling needs duration and a broad date constraint only", candidatePolicy.kind === "meeting_candidates" && findMissingTemporalRequirements(nextWeek, candidatePolicy).join(",") === "duration"));
  results.push(check("[clarification] missing duration has one coherent question", buildTemporalClarificationQuestion("duration").includes("所要時間")));

  const completeCandidate = extractTemporalRequirement("来週に30分の会議候補を3つ出して");
  results.push(check("[policy] candidate request with duration does not demand exact start time", findMissingTemporalRequirements(completeCandidate, candidatePolicy).length === 0 && completeCandidate.specificTime === undefined));

  const calendarPolicy = deriveTemporalRequirementPolicy("カレンダーに予定を追加して");
  results.push(check("[policy] a specific calendar-like action missing time asks only for time", calendarPolicy.kind === "specific_calendar_action" && findMissingTemporalRequirements({}, calendarPolicy).join(",") === "specific_time"));

  const deadlinePolicy = deriveTemporalRequirementPolicy("金曜までに資料を提出して");
  results.push(check("[policy] deadline work has no meeting-specific requirements", deadlinePolicy.kind === "deadline_work" && findMissingTemporalRequirements(deadline, deadlinePolicy).length === 0));

  const afterAnswer = mergeTemporalRequirements(nextWeek, extractTemporalRequirement("30分で"));
  results.push(check("[answer] a duration answer completes the same candidate requirement", findMissingTemporalRequirements(afterAnswer, candidatePolicy).length === 0));

  const metadata = toTemporalRequirementMetadata(afterAnswer, candidatePolicy, "clarification-1");
  const restored = readTemporalRequirementMetadata({ temporalRequirement: metadata });
  results.push(check("[persistence] temporal requirement and clarification correlation round-trip through Work metadata", restored?.requirement.durationMinutes === 30 && restored.activeClarificationId === "clarification-1"));

  const malformed = extractTemporalRequirement("99:99に会議、0分");
  results.push(check("[safety] malformed time and zero duration are ignored", malformed.specificTime === undefined && malformed.durationMinutes === undefined));

  const delay = extractTemporalRequirement("1時間後に再試行して");
  const retryPolicy = deriveTemporalRequirementPolicy("1時間後に再試行して");
  results.push(check("[ambiguity] 1時間後 is a delay, never a meeting duration", delay.delayMinutes === 60 && delay.durationMinutes === undefined && findMissingTemporalRequirements(delay, retryPolicy).length === 0));

  const delayedThirtyMinutes = extractTemporalRequirement("30分後に通知して");
  results.push(check("[ambiguity] 30分後 is not blindly treated as a meeting duration", delayedThirtyMinutes.delayMinutes === 30 && delayedThirtyMinutes.durationMinutes === undefined));

  const deadlineAndDuration = extractTemporalRequirement("金曜までに30分の会議を準備して");
  results.push(check("[extract] deadline and meeting duration remain independent facts", deadlineAndDuration.deadline?.kind === "relative" && deadlineAndDuration.durationMinutes === 30));

  const source = readFileSync(join(__dirname, "..", "..", "..", "core", "tact-work", "temporalRequirements.ts"), "utf8");
  results.push(check("[timezone] relative/local expressions are never converted through Date or server timezone", !source.includes("new Date(") && !source.includes("Date.parse(") && !source.includes("getTimezoneOffset")));

  const storeSource = readFileSync(join(__dirname, "..", "..", "..", "core", "tact-work", "store.ts"), "utf8");
  const temporalMetadataWriter = storeSource.slice(
    storeSource.indexOf("export async function updateWorkTemporalRequirementMetadata"),
    storeSource.indexOf("export interface CreateWorkTaskParams")
  );
  results.push(check("[metadata] temporal persistence preserves unrelated metadata and guards concurrent writes", temporalMetadataWriter.includes("...(work.metadata ?? {})") && temporalMetadataWriter.includes("temporalRequirement") && temporalMetadataWriter.includes('.eq("updated_at", work.updatedAt)')));

  results.push(check("[boundary] request facts do not expose TIME-P1a execution state", !("waitUntil" in afterAnswer) && !("nextRetryAt" in afterAnswer)));

  // =========================
  // TIME-P1c FIX (explicit-year date bug)
  // =========================
  //
  // Root cause (two parts, both in this file):
  //  1. The year-separator character class only recognized "-", "/", "."
  //     — not "年" — so "2026年9月14日" never captured a year at all and
  //     silently fell back to a bare "9月14日" (month/day only).
  //  2. toDate() concatenated a captured year directly onto "MM-DD" with no
  //     separator (e.g. "202609-14"), a string no downstream parser could
  //     interpret. It now emits well-formed "YYYY-MM-DD".
  // core/tact-work/temporalRange.ts's resolveExplicitDateToLocalParts()
  // parses both the year-included and year-omitted shapes explicitly.

  const explicitYearKanji = extractTemporalRequirement("2026年9月14日に会議");
  results.push(check(
    "[TIME-P1c FIX explicit-year] 2026年9月14日 captures the explicit year as well-formed YYYY-MM-DD",
    explicitYearKanji.date?.kind === "date" && explicitYearKanji.date.date === "2026-09-14"
  ));

  const explicitYearSlash = extractTemporalRequirement("2026/9/14に会議");
  results.push(check(
    "[TIME-P1c FIX explicit-year] 2026/9/14 captures the explicit year as well-formed YYYY-MM-DD (previously malformed as \"202609-14\")",
    explicitYearSlash.date?.kind === "date" && explicitYearSlash.date.date === "2026-09-14"
  ));

  const noYearDate = extractTemporalRequirement("9月14日に会議");
  results.push(check(
    "[TIME-P1c FIX explicit-year] 9月14日 (year omitted) still extracts as bare MM-DD, unaffected by the fix",
    noYearDate.date?.kind === "date" && noYearDate.date.date === "09-14"
  ));

  const invalidDate = extractTemporalRequirement("2026年13月40日に会議");
  results.push(check(
    "[TIME-P1c FIX explicit-year] an invalid calendar date (13月40日) is rejected at extraction, not passed through",
    invalidDate.date === undefined
  ));

  if (explicitYearKanji.date) {
    const resolvedExplicitYear = resolveTemporalDateRange(explicitYearKanji.date, "2026-09-01T00:00:00.000Z", "Asia/Tokyo");
    results.push(check(
      "[TIME-P1c FIX explicit-year] an explicit-year date resolves to exactly that calendar day, not a \"nearest upcoming\" guess",
      resolvedExplicitYear.success &&
        resolvedExplicitYear.range.startUtc === "2026-09-13T15:00:00.000Z" &&
        resolvedExplicitYear.range.endUtc === "2026-09-14T15:00:00.000Z"
    ));
  } else {
    results.push(check("[TIME-P1c FIX explicit-year] an explicit-year date resolves to exactly that calendar day", false, "extraction itself failed"));
  }

  const legacyMalformedStillFailsClosed = resolveTemporalDateRange(
    { kind: "date", date: "202609-14" }, // the old, pre-fix malformed shape (may still exist in already-persisted Work.metadata)
    "2026-09-01T00:00:00.000Z",
    "Asia/Tokyo"
  );
  results.push(check(
    "[TIME-P1c FIX explicit-year] downstream range resolution still fails closed on the old malformed concatenation, never guesses a date from it",
    !legacyMalformedStillFailsClosed.success && legacyMalformedStillFailsClosed.code === "temporal_requirement_incomplete"
  ));

  // =========================
  // TIME-P1c FIX (candidateCount over-extraction bug)
  // =========================
  //
  // Root cause: extractCandidateCount() matched any bare "Nつ/件/個"
  // anywhere in the input, with no check that N had anything to do with
  // meeting-candidate scheduling ("資料を3つ作って" has nothing to do with
  // it). It now gates on isSchedulingCandidateIntent() — the exact same
  // signal deriveTemporalRequirementPolicy() uses to classify a request as
  // "meeting_candidates" — so there is one source of truth for "is this
  // scheduling-candidate language", not a second, broader heuristic.

  const unrelatedDocuments = extractTemporalRequirement("資料を3つ作って");
  results.push(check(
    "[TIME-P1c FIX candidateCount] \"資料を3つ作って\" (unrelated \"3つ\") does not set candidateCount",
    unrelatedDocuments.candidateCount === undefined
  ));

  const unrelatedImages = extractTemporalRequirement("画像を3つ作って");
  results.push(check(
    "[TIME-P1c FIX candidateCount] \"画像を3つ作って\" (unrelated \"3つ\") does not set candidateCount",
    unrelatedImages.candidateCount === undefined
  ));

  const schedulingCandidateCount = extractTemporalRequirement("候補を3つ出して");
  results.push(check(
    "[TIME-P1c FIX candidateCount] \"候補を3つ出して\" (scheduling-candidate intent) sets candidateCount = 3",
    schedulingCandidateCount.candidateCount === 3
  ));

  const schedulingCandidateCountWithDuration = extractTemporalRequirement("30分の候補を3つ出して");
  results.push(check(
    "[TIME-P1c FIX candidateCount] \"30分の候補を3つ出して\" sets candidateCount = 3 alongside durationMinutes = 30",
    schedulingCandidateCountWithDuration.candidateCount === 3 && schedulingCandidateCountWithDuration.durationMinutes === 30
  ));

  return summarize("work/temporalRequirements", results);
}
