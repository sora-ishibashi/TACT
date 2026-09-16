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

  // =========================
  // TIME-P1c HARDENING (Codex delta-fix Section 4): explicit-date validation
  // =========================

  const dashDate = extractTemporalRequirement("2026-09-14に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2026-09-14\" (ISO dash format) is now recognized — previously the month/day separator class excluded \"-\"",
    dashDate.date?.kind === "date" && dashDate.date.date === "2026-09-14"
  ));

  const noVerbYearlessDate = extractTemporalRequirement("9月14日に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"9月14日\" (yearless) is unaffected by the dash-separator fix",
    noVerbYearlessDate.date?.kind === "date" && noVerbYearlessDate.date.date === "09-14"
  ));

  const invalidFeb30Slash = extractTemporalRequirement("2026/2/30に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2026/2/30\" is rejected — real calendar-date validation, not JS Date rollover",
    invalidFeb30Slash.date === undefined
  ));

  const invalidFeb30Dash = extractTemporalRequirement("2026-02-30に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2026-02-30\" is rejected",
    invalidFeb30Dash.date === undefined
  ));

  const invalidMonth13 = extractTemporalRequirement("2026/13/01に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2026/13/01\" (month 13) is rejected",
    invalidMonth13.date === undefined
  ));

  const invalidMonth0 = extractTemporalRequirement("2026/00/01に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2026/00/01\" (month 0) is rejected",
    invalidMonth0.date === undefined
  ));

  const nonLeapFeb29 = extractTemporalRequirement("2026-02-29に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2026-02-29\" is rejected — 2026 is not a leap year, validated by real year-aware arithmetic, not a bare day<=31 bound",
    nonLeapFeb29.date === undefined
  ));

  const leapFeb29 = extractTemporalRequirement("2028-02-29に会議");
  results.push(check(
    "[HARDENING Blocker: explicit date] \"2028-02-29\" is accepted — 2028 IS a leap year",
    leapFeb29.date?.kind === "date" && leapFeb29.date.date === "2028-02-29"
  ));

  // =========================
  // TIME-P1c HARDENING (Codex delta-fix Section 5): candidateCount context
  // hardening v2 — direct syntactic attachment to candidate/scheduling
  // vocabulary, replacing the prior sentence-level gate.
  // =========================

  results.push(check(
    "[HARDENING Blocker: candidateCount] \"打ち合わせ候補3件\" (no を/の particle, no verb) sets candidateCount = 3",
    extractTemporalRequirement("打ち合わせ候補3件").candidateCount === 3
  ));

  results.push(check(
    "[HARDENING Blocker: candidateCount] \"日程候補を2つ\" (日程候補 prefix, previously unrecognized) sets candidateCount = 2",
    extractTemporalRequirement("日程候補を2つ").candidateCount === 2
  ));

  results.push(check(
    "[HARDENING Blocker: candidateCount] \"候補日を3つ\" (候補日 compound) sets candidateCount = 3",
    extractTemporalRequirement("候補日を3つ").candidateCount === 3
  ));

  const mixedUnrelatedAndScheduling = extractTemporalRequirement("資料を3つ確認して、打ち合わせ候補を2つ出して");
  results.push(check(
    "[HARDENING Blocker: candidateCount] a mixed sentence with an unrelated count elsewhere selects the SCHEDULING count (2), never the unrelated one (3)",
    mixedUnrelatedAndScheduling.candidateCount === 2
  ));

  // =========================
  // TIME-P1c Final Wiring: Section18 exact production request regression
  // =========================
  //
  // 「2026年9月17日、Asia/Tokyoで、10:00〜18:00の間から30分空いている
  // 時間を3つ探して。Google Calendarの予定を確認して。」から、
  // timezone/dailyWindow/duration/candidateCount/dateがすべて正しく
  // 抽出され、かつpolicyがcalendar_availabilityとしてduration/date/
  // timezone/daily_windowの4つを要求し、この完全なrequestに対しては
  // 何も欠けていないことを確認する。

  const productionRequest =
    "2026年9月17日、Asia/Tokyoで、10:00〜18:00の間から30分空いている時間を3つ探して。Google Calendarの予定を確認して。";

  const productionRequirement = extractTemporalRequirement(productionRequest);
  const productionPolicy = deriveTemporalRequirementPolicy(productionRequest);

  results.push(check(
    "[TIME-P1c-18] the exact production request resolves date=2026-09-17",
    productionRequirement.date?.kind === "date" && productionRequirement.date.date === "2026-09-17"
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request resolves timezone=Asia/Tokyo",
    productionRequirement.timezone === "Asia/Tokyo"
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request resolves dailyWindow=10:00-18:00 (600-1080 minutes)",
    productionRequirement.dailyWindow?.startMinuteOfDay === 600 && productionRequirement.dailyWindow?.endMinuteOfDay === 1080
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request resolves durationMinutes=30",
    productionRequirement.durationMinutes === 30
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request resolves candidateCount=3",
    productionRequirement.candidateCount === 3
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request is NOT misread as a specific event start time (10:00 must not become specificTime)",
    productionRequirement.specificTime === undefined
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request derives policy kind = calendar_availability, requiring duration/date/timezone/daily_window",
    productionPolicy.kind === "calendar_availability" &&
      [...productionPolicy.required].sort().join(",") === ["date", "daily_window", "duration", "timezone"].sort().join(",")
  ));
  results.push(check(
    "[TIME-P1c-18] the exact production request has nothing missing (all 4 required fields already present)",
    findMissingTemporalRequirements(productionRequirement, productionPolicy).length === 0
  ));

  // =========================
  // TIME-P1c Final Wiring: Section19-C/D — missing timezone / missing
  // daily window triggers clarification (via findMissingTemporalRequirements,
  // the exact function core/tact-conversation/orchestration.ts's
  // resolveAndRunWork() gates on before ever calling runWorkTurn()).
  // =========================

  const missingTimezoneRequest = "明日30分空いてるところ探して";
  const missingTimezonePolicy = deriveTemporalRequirementPolicy(missingTimezoneRequest);
  const missingTimezoneRequirement = extractTemporalRequirement(missingTimezoneRequest);
  results.push(check(
    "[TIME-P1c-19C] a calendar availability request missing timezone/daily_window is classified as calendar_availability",
    missingTimezonePolicy.kind === "calendar_availability"
  ));
  results.push(check(
    "[TIME-P1c-19C] missing timezone is reported first (asked before daily_window, in required-field order)",
    findMissingTemporalRequirements(missingTimezoneRequirement, missingTimezonePolicy)[0] === "timezone"
  ));
  results.push(check(
    "[TIME-P1c-19C] the timezone clarification question is coherent",
    buildTemporalClarificationQuestion("timezone").includes("タイムゾーン")
  ));

  const missingWindowRequirement = mergeTemporalRequirements(missingTimezoneRequirement, { timezone: "Asia/Tokyo" });
  results.push(check(
    "[TIME-P1c-19D] once timezone is answered, daily_window is still reported as missing",
    findMissingTemporalRequirements(missingWindowRequirement, missingTimezonePolicy).join(",") === "daily_window"
  ));
  results.push(check(
    "[TIME-P1c-19D] the daily_window clarification question is coherent",
    buildTemporalClarificationQuestion("daily_window").includes("時間帯") || buildTemporalClarificationQuestion("daily_window").includes("何時")
  ));

  const answeredWindowRequirement = mergeTemporalRequirements(missingWindowRequirement, extractTemporalRequirement("10:00〜18:00"));
  results.push(check(
    "[TIME-P1c-19D] answering with \"10:00〜18:00\" completes the requirement (nothing left missing)",
    findMissingTemporalRequirements(answeredWindowRequirement, missingTimezonePolicy).length === 0
  ));

  // =========================
  // TIME-P1c Final Wiring: Section19-B/H — a disguised write request never
  // derives the calendar_availability policy (existing specific_calendar_action
  // policy, unaffected by this phase, still wins).
  // =========================

  results.push(check(
    "[TIME-P1c-19B] \"明日の予定をGoogle Calendarに入れて\" (write, disguised as calendar+time language) is NOT calendar_availability",
    deriveTemporalRequirementPolicy("明日の予定をGoogle Calendarに入れて").kind === "specific_calendar_action"
  ));
  results.push(check(
    "[TIME-P1c-19H] \"会議を登録して\" (write) is NOT calendar_availability",
    deriveTemporalRequirementPolicy("会議を登録して").kind !== "calendar_availability"
  ));

  // =========================
  // TIME-P1c Final Wiring: timezone/daily-window round-trip through
  // TemporalRequirementMetadata persistence (mirrors the existing
  // "[persistence]" check above for the new fields).
  // =========================

  const calendarMetadata = toTemporalRequirementMetadata(productionRequirement, productionPolicy);
  const restoredCalendar = readTemporalRequirementMetadata({ temporalRequirement: calendarMetadata });
  results.push(check(
    "[TIME-P1c-persistence] calendar_availability policy + timezone/dailyWindow round-trip through Work metadata",
    restoredCalendar?.policy.kind === "calendar_availability" &&
      restoredCalendar.requirement.timezone === "Asia/Tokyo" &&
      restoredCalendar.requirement.dailyWindow?.startMinuteOfDay === 600
  ));

  return summarize("work/temporalRequirements", results);
}
