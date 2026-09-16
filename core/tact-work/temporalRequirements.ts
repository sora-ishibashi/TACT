// TACT Work — TIME-P1b temporal understanding.
// Request constraints here are intentionally separate from TIME-P1a execution
// state (deadline, waitUntil, and nextRetryAt).

export type TemporalDateConstraint =
  | { readonly kind: "relative"; readonly value: "today" | "tomorrow" | "this_week" | "next_week" | "friday" }
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "range"; readonly start: string; readonly end: string };

// TIME-P1c: the minutes-since-local-midnight daily search window a
// candidate-slot request should stay inside (e.g. 9:00-18:00 ->
// {startMinuteOfDay: 540, endMinuteOfDay: 1080}). Mirrors
// core/tact-work/slotEngine.ts's DailyWindow shape field-for-field so no
// mapping is needed between the two; defined separately here (rather than
// imported) so this file stays a dependency-free leaf module, matching its
// existing design.
export interface TemporalDailyWindow {
  readonly startMinuteOfDay: number;
  readonly endMinuteOfDay: number;
}

export interface TemporalRequirement {
  readonly durationMinutes?: number;
  // A delay is distinct from a meeting duration. It is intentionally not
  // mapped to TIME-P1a waitUntil/nextRetryAt in this phase.
  readonly delayMinutes?: number;
  readonly date?: TemporalDateConstraint;
  // Without a reliable account timezone, a date and a clock time must not be
  // combined into an ambiguous timestamp.
  readonly specificTime?: string;
  readonly deadline?: TemporalDateConstraint;
  // TIME-P1c additions below. All optional/additive: extractTemporalRequirement()
  // (this file's own free-text extractor) never sets timezone or dailyWindow —
  // no repository-reliable source for either exists (see
  // core/tact-work/timezone.ts's header), so both are only ever populated
  // from an explicit Clarification answer (see core/tact-work/candidateSchedule.ts's
  // answer parsers). candidateCount is extracted here because, like
  // duration, it is a plain fact statable in the original request text
  // ("3つ出して") with no timezone-like ambiguity.
  readonly timezone?: string;
  readonly dailyWindow?: TemporalDailyWindow;
  readonly candidateCount?: number;
}

// TIME-P1c Final Wiring: "timezone"/"daily_window"を追加する。既存の
// "calendar_availability" policy(下記)専用の必須fieldであり、他の
// policy kindはこの2値を要求しない。
export type TemporalRequiredField = "duration" | "delay" | "date" | "specific_time" | "deadline" | "timezone" | "daily_window";

export interface TemporalRequirementPolicy {
  // TIME-P1c Final Wiring: "calendar_availability"を追加する。既存の
  // "meeting_candidates"(会議の日程候補、Task/Run実行までは配線されて
  // いない)とは意図的に区別する——"calendar_availability"は接続済み
  // Google Calendarの実際の空き時間確認(read)を表し、timezone/
  // dailyWindowという追加の必須fieldを持つ(Section7/8絶対条件:
  // タイムゾーン・検索時間帯を推測しない)。
  readonly kind: "meeting_candidates" | "specific_calendar_action" | "deadline_work" | "retry_request" | "calendar_availability" | "none";
  readonly required: readonly TemporalRequiredField[];
}

export interface TemporalRequirementMetadata {
  readonly version: 1;
  readonly requirement: TemporalRequirement;
  readonly policy: TemporalRequirementPolicy;
  readonly activeClarificationId?: string | null;
}

const DURATION_HOURS = /(\d+)\s*(?:時間|hours?|hrs?)/i;
const DURATION_MINUTES = /(\d+)\s*(?:分|minutes?|mins?)/i;
const CLOCK_TIME = /\b([01]?\d|2[0-3])(?::([0-5]\d))\b|([01]?\d|2[0-3])時(?:([0-5]\d)分?)?/;

// TIME-P1c Final Wiring: 明示的なIANA timezone識別子("Asia/Tokyo"形式、
// "Continent/City")のみを抽出する。都市名単体・略称(JST等)・offset
// (+09:00等)は対象外(Section7絶対条件: タイムゾーンを推測しない、
// core/tact-work/timezone.tsのisKnownTimeZone()と同じ設計思想)。
// 実際の妥当性検証(isKnownTimeZone())はcore/tact-work/temporalRange.ts
// (resolveTemporalDateRange())が既に行う——このfileはdependency-free
// leaf moduleの既存設計方針(このfile冒頭コメント参照)を保つため、
// ここでは形状だけを抽出し、意味的な検証はimportしない。
const TIMEZONE_IDENTIFIER = /\b([A-Z][A-Za-z]+\/[A-Z][A-Za-z_]+)\b/;

// TIME-P1c Final Wiring: 「10:00〜18:00」「10:00-18:00」「10時から18時」
// のような、1日のうちの検索時間帯(daily search window)を抽出する。
// Section8絶対条件: これは「イベントの開始時刻〜終了時刻」ではなく
// 「候補を探す時間帯」を表す——extractSpecificTime()がこの部分文字列を
// 誤って単一の時刻として抽出しないよう、下記withoutDailyWindowExpression()
// で先に取り除く。
const TIME_TOKEN_SOURCE = "(?:([01]?\\d|2[0-3]):([0-5]\\d)|([01]?\\d|2[0-3])時(?:([0-5]\\d)分?)?)";
const DAILY_WINDOW_RANGE = new RegExp(`${TIME_TOKEN_SOURCE}\\s*(?:〜|～|-|–|から)\\s*${TIME_TOKEN_SOURCE}`);
const DATE_RANGE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:〜|～|-|–|to)\s*(\d{1,2})(?:\s*\/\s*(\d{1,2}))?/i;
// TIME-P1c FIX (explicit-year date bug, root cause part 1 of 2): the year
// separator class previously only recognized "-", "/", "." (e.g.
// "2026-9-14", "2026/9/14"). It did not include "年", so the most natural
// Japanese phrasing "2026年9月14日" never matched the year group at all —
// the year was silently dropped and the date fell back to a bare "9月14日"
// (month/day only), with no fail-closed signal that a year had been typed.
//
// TIME-P1c HARDENING FIX (Codex delta-fix): the month/day separator class
// previously only recognized "/", ".", "月" — never "-" — so the ISO-like
// "2026-09-14" (year separator "-" consumed, then "09-14" needed to match
// the month/day separator, which "-" was not a member of) silently failed
// to match this regex AT ALL, producing no date rather than a fail-closed
// signal. "-" is now a valid month/day separator too.
const DATE = /(?:\b(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})(?:日)?/;
// TIME-P1c HARDENING FIX (Codex delta-fix, candidateCount context
// hardening v2): the previous design gated a generic "any bare Nつ/件/個"
// match behind a separate isSchedulingCandidateIntent() sentence-level
// check. That was still too brittle in both directions:
//   - "30分の候補を3つ" has no verb (出す/作る/generate) after 候補, so the
//     sentence-level gate rejected it entirely even though "候補を3つ" is
//     unambiguous on its own.
//   - "日程候補を2つ" — "日程候補" wasn't a recognized prefix at all.
//   - A mixed sentence ("資料を3つ確認して、打ち合わせ候補を2つ出して")
//     passed the sentence-level gate (it does mention scheduling) but then
//     extracted the FIRST bare number anywhere in the string — the
//     unrelated "3つ" attached to 資料, not the "2つ" attached to 候補.
//
// This now requires DIRECT syntactic attachment instead: the count must be
// immediately preceded by 候補/候補日/日程候補/打ち合わせ候補-style
// candidate vocabulary (optionally via a "を"/"の" particle), so the
// keyword and the number are matched by ONE regex, not two independent
// checks. This is what correctly resolves the mixed-sentence case — the
// match anchors on "候補を2つ", never on the unrelated "3つ" — without
// reintroducing broad generic numeric extraction (a bare "Nつ" with no
// preceding 候補-family word anywhere still never matches at all).
// TIME-P1c Final Wiring: 既存の「候補」family(候補/候補日/日程候補/
// 打ち合わせ候補)に加え、「空いている時間/空き時間」directly attached
// countも対象に含める(Section9: 「30分空いている時間を3つ探して」の
// ような、候補という語を含まない空き時間確認依頼でも件数を正しく
// 抽出できるようにするため)。既存の「直接構文的に接続している場合
// のみ」という設計方針はそのまま維持する。
const CANDIDATE_COUNT_JA = /(?:候補(?:日)?|空いている時間|空き時間)(?:を|の)?\s*(\d+)\s*(?:つ|件|個)/;
// English "candidate slots/options", supporting the count on either side
// (e.g. "3 candidate slots" / "candidate slots: 3") — kept intentionally
// simple per instruction not to overbuild NLP; not exercised by any
// required test, but consistent with the same attachment principle.
const CANDIDATE_COUNT_EN = /(?:(\d+)\s*candidate\s*(?:slots?|options?)|candidate\s*(?:slots?|options?)\D{0,10}?(\d+))/i;
const MAX_REASONABLE_CANDIDATE_COUNT = 10;

function extractDelayMinutes(input: string): number | undefined {
  const japanese = input.match(/(\d+)\s*(時間|分)後/);
  if (japanese) return Number(japanese[1]) * (japanese[2] === "時間" ? 60 : 1);
  const english = input.match(/(?:in|after)\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)\b/i) ??
    input.match(/(\d+)\s*(hours?|hrs?|minutes?|mins?)\s+later\b/i);
  if (!english) return undefined;
  return Number(english[1]) * (/^h/i.test(english[2]) ? 60 : 1);
}

function withoutDelayExpressions(input: string): string {
  return input
    .replace(/\d+\s*(?:時間|分)後/g, "")
    .replace(/(?:in|after)\s+\d+\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
    .replace(/\d+\s*(?:hours?|hrs?|minutes?|mins?)\s+later\b/gi, "");
}

// TIME-P1c FIX (explicit-year date bug, root cause part 2 of 2): this
// previously concatenated a 4-digit year directly in front of "MM-DD" with
// no separator (e.g. year="2026" -> "202609-14"), producing a string no
// downstream parser could interpret as a date. Now emits a well-formed
// "YYYY-MM-DD" when a year was captured, or the original year-omitted
// "MM-DD" otherwise — core/tact-work/temporalRange.ts's
// resolveExplicitDateToLocalParts() is the sole consumer and parses both
// shapes explicitly (anything else still fails closed there).
function toDate(month: string, day: string, year?: string): string {
  const monthDay = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return year ? `${year}-${monthDay}` : monthDay;
}

// TIME-P1c HARDENING FIX (Codex delta-fix, explicit-date validation):
// replaces the previous crude "day <= 31" bound (which let through
// impossible dates like 2026/2/30 or 4/31) with real calendar-date
// validation — exact days-in-month, including leap years when a year is
// known. Built entirely from pure integer arithmetic, with no dependency on
// any built-in date/time object (this file's own absolute condition,
// enforced by an existing regression test). Exported so core/tact-work/temporalRange.ts's final,
// year-aware validation (once a no-year date has been resolved to a
// concrete year) reuses this exact same logic rather than a second,
// possibly-divergent implementation.
const DAYS_IN_MONTH_NON_LEAP = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// When `year` is omitted (a yearless date like "2/30"), this uses the more
// permissive leap-year day count for February (29) — the concrete year
// isn't known yet at extraction time (core/tact-work/temporalRange.ts
// resolves it later, against the reference instant), so this stage only
// rejects dates that are impossible in ANY year (e.g. day 30 in February,
// day 31 in a 30-day month, day/month out of range). A specific year's
// exact Feb-29 validity is checked again, precisely, once
// resolveExplicitDateToLocalParts() knows the concrete year.
export function isValidCalendarDate(month: number, day: number, year?: number): boolean {

  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const maxDay = month === 2 && (year === undefined || isLeapYear(year)) ? 29 : DAYS_IN_MONTH_NON_LEAP[month - 1];

  return day <= maxDay;

}

function extractDateConstraint(input: string): TemporalDateConstraint | undefined {
  const range = input.match(DATE_RANGE);
  if (range) {
    const [, startMonth, startDay, endPartA, endPartB] = range;
    const [endMonth, endDay] = endPartB ? [endPartA, endPartB] : [startMonth, endPartA];
    if (!isValidCalendarDate(Number(startMonth), Number(startDay)) || !isValidCalendarDate(Number(endMonth), Number(endDay))) {
      return undefined;
    }
    return {
      kind: "range",
      start: toDate(startMonth, startDay),
      end: toDate(endMonth, endDay),
    };
  }
  if (/(?:来週|next week)/i.test(input)) return { kind: "relative", value: "next_week" };
  if (/(?:今週|this week)/i.test(input)) return { kind: "relative", value: "this_week" };
  if (/(?:明日|tomorrow)/i.test(input)) return { kind: "relative", value: "tomorrow" };
  if (/(?:今日|today)/i.test(input)) return { kind: "relative", value: "today" };
  if (/(?:金曜(?:日)?|friday)/i.test(input)) return { kind: "relative", value: "friday" };

  const date = input.match(DATE);
  if (!date) return undefined;
  const [, year, month, day] = date;
  if (!isValidCalendarDate(Number(month), Number(day), year ? Number(year) : undefined)) return undefined;
  return { kind: "date", date: toDate(month, day, year) };
}

function extractSpecificTime(input: string): string | undefined {
  const match = input.match(CLOCK_TIME);
  if (!match) return undefined;
  const hour = match[1] ?? match[3];
  const minute = match[2] ?? match[4] ?? "00";
  return hour ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : undefined;
}

// TIME-P1c Final Wiring: Section8絶対条件により、抽出したdaily window
// の部分文字列はextractSpecificTime()から隠す(「10:00〜18:00の間」を
// イベント開始時刻10:00と誤解釈しない)。
function withoutDailyWindowExpression(input: string): string {
  return input.replace(DAILY_WINDOW_RANGE, " ");
}

function minuteOfDayFromTimeToken(
  colonHour: string | undefined,
  colonMinute: string | undefined,
  kanjiHour: string | undefined,
  kanjiMinute: string | undefined
): number | undefined {
  const hour = colonHour ?? kanjiHour;
  if (hour === undefined) return undefined;
  const minute = colonMinute ?? kanjiMinute ?? "0";
  return Number(hour) * 60 + Number(minute);
}

// TIME-P1c Final Wiring: fail closed(絶対条件、Section8: 「Do not
// overbuild」)。終了が開始以下の場合(例: 入力の誤り)は、overnight
// windowとして無理に解釈せず抽出しない——core/tact-work/candidateSchedule.ts
// のextractDailyWindowAnswer()(Clarification回答専用)とは異なる、
// このfile自身の独立した最小実装(dependency-free leaf moduleの既存
// 設計方針、このfile冒頭コメント参照)。
function extractDailyWindow(input: string): TemporalDailyWindow | undefined {

  const match = input.match(DAILY_WINDOW_RANGE);

  if (!match) return undefined;

  const startMinuteOfDay = minuteOfDayFromTimeToken(match[1], match[2], match[3], match[4]);
  const endMinuteOfDay = minuteOfDayFromTimeToken(match[5], match[6], match[7], match[8]);

  if (startMinuteOfDay === undefined || endMinuteOfDay === undefined || endMinuteOfDay <= startMinuteOfDay) {
    return undefined;
  }

  return { startMinuteOfDay, endMinuteOfDay };

}

// TIME-P1c Final Wiring: 形状だけの抽出(IANA識別子らしい文字列)。
// 実際に既知のtimezoneかどうかの検証はcore/tact-work/temporalRange.ts
// (resolveTemporalDateRange())が既に行う(timezone_unrecognizedとして
// fail closed)——このfileでは重複した検証ロジックを持たない。
function extractTimezone(input: string): string | undefined {
  return input.match(TIMEZONE_IDENTIFIER)?.[1];
}

function isReasonableCandidateCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const count = Number(raw);
  return Number.isFinite(count) && count > 0 && count <= MAX_REASONABLE_CANDIDATE_COUNT ? count : undefined;
}

// TIME-P1c FIX (candidateCount over-extraction bug) + HARDENING FIX
// (Codex delta-fix v2, see CANDIDATE_COUNT_JA/EN above): a bare "Nつ/件/個"
// is not, by itself, evidence that N is a meeting-candidate count —
// "資料を3つ作って" / "画像を3つ作って" have nothing to do with scheduling.
// Rather than a separate sentence-level "is this scheduling-shaped at all"
// gate, the count must be directly, syntactically attached to
// candidate/scheduling vocabulary (候補/候補日/日程候補/打ち合わせ候補,
// or "candidate slots/options") in the SAME regex match — this is what
// correctly resolves a mixed sentence containing an unrelated count
// elsewhere, and never falls back to broad generic numeric extraction (no
// 候補-family word anywhere in the input means no match, full stop).
function extractCandidateCount(input: string): number | undefined {

  const jaMatch = input.match(CANDIDATE_COUNT_JA);
  const jaCount = isReasonableCandidateCount(jaMatch?.[1]);
  if (jaCount !== undefined) return jaCount;

  const enMatch = input.match(CANDIDATE_COUNT_EN);
  return isReasonableCandidateCount(enMatch?.[1] ?? enMatch?.[2]);
}

export function extractTemporalRequirement(input: string): TemporalRequirement {
  const durationInput = withoutDelayExpressions(input);
  const hours = durationInput.match(DURATION_HOURS);
  const minutes = durationInput.match(DURATION_MINUTES);
  const durationMinutes = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  const delayMinutes = extractDelayMinutes(input);
  const date = extractDateConstraint(input);
  const dailyWindow = extractDailyWindow(input);
  // TIME-P1c Final Wiring (Section8): a daily search window ("10:00〜
  // 18:00の間") must never be misread as a single specific event time —
  // strip the matched window text before looking for a bare clock time.
  const specificTime = extractSpecificTime(withoutDailyWindowExpression(input));
  const timezone = extractTimezone(input);
  const candidateCount = extractCandidateCount(input);
  const hasDeadlineLanguage = /(?:締切(?:まで)?|期限(?:まで)?|[月火水木金土日]曜(?:日)?まで|deadline|by\s+(?:friday|\d))/i.test(input);
  return {
    ...(Number.isFinite(durationMinutes) && durationMinutes > 0 && durationMinutes <= 24 * 60 ? { durationMinutes } : {}),
    ...(delayMinutes !== undefined && Number.isFinite(delayMinutes) && delayMinutes > 0 && delayMinutes <= 24 * 60 ? { delayMinutes } : {}),
    ...(date ? { date } : {}),
    ...(specificTime ? { specificTime } : {}),
    ...(hasDeadlineLanguage && date ? { deadline: date } : {}),
    ...(candidateCount !== undefined ? { candidateCount } : {}),
    ...(timezone ? { timezone } : {}),
    ...(dailyWindow ? { dailyWindow } : {}),
  };
}

export function mergeTemporalRequirements(existing: TemporalRequirement | undefined, incoming: TemporalRequirement): TemporalRequirement {
  return { ...(existing ?? {}), ...incoming };
}

// TIME-P1c FIX (candidateCount over-extraction bug, shared root cause fix):
// this is the exact same "is this actually meeting-candidate-scheduling
// language" signal deriveTemporalRequirementPolicy() below uses to classify
// a request as "meeting_candidates" — extracted here so extractCandidateCount()
// (further down) can gate on the identical condition instead of maintaining
// a second, divergent heuristic for the same question. Behavior of
// deriveTemporalRequirementPolicy() itself is unchanged by this extraction.
function isSchedulingCandidateIntent(input: string): boolean {
  const normalized = input.toLowerCase();
  return (
    /(?:会議|ミーティング|打ち合わせ|meeting|schedule).{0,30}(?:候補|日程調整|調整|schedule|slots?)/i.test(input) ||
    /(?:候補(?:を|の)?.{0,12}(?:出|作|generate)|candidate\s*slots?)/i.test(normalized)
  );
}

// TIME-P1c Final Wiring: core/tact-intent/ruleRouter.tsの
// looksLikeCalendarAvailabilityRequest()と同じ趣旨(空き時間確認の
// natural language検出)を、このfile自身のdependency-free leaf module
// 設計方針(このfile冒頭コメント参照)を保つため独立に再実装する
// (isSchedulingCandidateIntent()と同じ、意図的な重複)。
// TIME-P1c Final Blocker Fix (Section10): core/tact-intent/ruleRouter.ts
// のCALENDAR_WRITE_VERB_PATTERNと同じ趣旨——read+writeが混在する依頼
// (「空いている時間を探して、そのまま予定を作って」)を
// calendar_availability policyへ倒さない(意図的な重複、このfile自身の
// leaf module設計方針)。
function isCalendarAvailabilityRequest(input: string): boolean {

  if (/(作っ|登録し|追加し|変更し|移動し|削除し|招待し)(て|てください|てほしい|てもらえる)/.test(input)) {
    return false;
  }

  return (
    /(?:空いて(?:い)?る?(?:時間|とき|ところ)|空き時間)[^。]{0,15}?(?:探し|見つけ|出し|教え)(?:て|てください|てほしい|てもらえる)/.test(input) ||
    /(?:カレンダー|calendar)[^。]{0,20}?候補[^。]{0,10}?(?:出し|探し|教え)(?:て|てください|てほしい|てもらえる)/i.test(input)
  );
}

export function deriveTemporalRequirementPolicy(input: string): TemporalRequirementPolicy {
  if (/(?:カレンダー|予定|calendar).{0,20}(?:登録|追加|入れ|create|add)/i.test(input)) {
    return { kind: "specific_calendar_action", required: ["specific_time"] };
  }
  // TIME-P1c Final Wiring: specific_calendar_action(書き込み)の後、
  // meeting_candidates(会議候補、Task/Run実行までは配線されていない
  // 既存policy)より前に判定する。既存のmeeting_candidatesとは意図的に
  // 別のkindとして扱う(Section7/8: timezone/dailyWindowという追加の
  // 必須fieldを持つため)。
  if (isCalendarAvailabilityRequest(input)) {
    return { kind: "calendar_availability", required: ["duration", "date", "timezone", "daily_window"] };
  }
  if (isSchedulingCandidateIntent(input)) return { kind: "meeting_candidates", required: ["duration", "date"] };
  if (/(?:締切(?:まで)?|期限(?:まで)?|[月火水木金土日]曜(?:日)?まで|deadline|by\s+(?:friday|\d))/i.test(input)) {
    return { kind: "deadline_work", required: ["deadline"] };
  }
  if (/(?:再試行|retry)/i.test(input)) return { kind: "retry_request", required: ["delay"] };
  return { kind: "none", required: [] };
}

export function findMissingTemporalRequirements(requirement: TemporalRequirement, policy: TemporalRequirementPolicy): TemporalRequiredField[] {
  return policy.required.filter((field) => {
    switch (field) {
      case "duration": return requirement.durationMinutes === undefined;
      case "delay": return requirement.delayMinutes === undefined;
      case "date": return requirement.date === undefined;
      case "specific_time": return requirement.specificTime === undefined;
      case "deadline": return requirement.deadline === undefined;
      case "timezone": return requirement.timezone === undefined;
      case "daily_window": return requirement.dailyWindow === undefined;
    }
  });
}

export function buildTemporalClarificationQuestion(field: TemporalRequiredField): string {
  switch (field) {
    case "duration": return "会議の所要時間を教えてください。";
    case "delay": return "再試行までの待ち時間を教えてください。";
    case "date": return "候補を探す日程の範囲を教えてください。";
    case "specific_time": return "予定する時刻を教えてください。";
    case "deadline": return "締切を教えてください。";
    case "timezone": return "タイムゾーンを教えてください(例: Asia/Tokyo)。";
    case "daily_window": return "何時から何時までの間で探しますか?(例: 10:00〜18:00)。";
  }
}

export function toTemporalRequirementMetadata(requirement: TemporalRequirement, policy: TemporalRequirementPolicy, activeClarificationId?: string | null): TemporalRequirementMetadata {
  return { version: 1, requirement, policy, ...(activeClarificationId ? { activeClarificationId } : {}) };
}

function isTemporalRequirementPolicy(value: unknown): value is TemporalRequirementPolicy {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; required?: unknown };
  return (candidate.kind === "meeting_candidates" || candidate.kind === "specific_calendar_action" ||
    candidate.kind === "deadline_work" || candidate.kind === "retry_request" ||
    candidate.kind === "calendar_availability" || candidate.kind === "none") &&
    Array.isArray(candidate.required) &&
    candidate.required.every((field) => field === "duration" || field === "delay" || field === "date" || field === "specific_time" || field === "deadline" || field === "timezone" || field === "daily_window");
}

export function readTemporalRequirementMetadata(metadata: Record<string, unknown> | null | undefined): TemporalRequirementMetadata | undefined {
  const value = metadata?.temporalRequirement;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { version?: unknown; requirement?: unknown; policy?: unknown; activeClarificationId?: unknown };
  if (candidate.version !== 1 || !candidate.requirement || typeof candidate.requirement !== "object" || !isTemporalRequirementPolicy(candidate.policy)) return undefined;
  return {
    version: 1,
    requirement: candidate.requirement as TemporalRequirement,
    policy: candidate.policy,
    ...(typeof candidate.activeClarificationId === "string" ? { activeClarificationId: candidate.activeClarificationId } : {}),
  };
}
