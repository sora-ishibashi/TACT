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

export type TemporalRequiredField = "duration" | "delay" | "date" | "specific_time" | "deadline";

export interface TemporalRequirementPolicy {
  readonly kind: "meeting_candidates" | "specific_calendar_action" | "deadline_work" | "retry_request" | "none";
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
const DATE_RANGE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:〜|～|-|–|to)\s*(\d{1,2})(?:\s*\/\s*(\d{1,2}))?/i;
const DATE = /(?:\b(20\d{2})[-/.])?(\d{1,2})[\/.月](\d{1,2})(?:日)?/;
// TIME-P1c: how many candidates the user asked for, e.g. "3つ出して" / "3件".
// Deliberately narrow (つ/件/個 only) so it doesn't collide with the
// duration/delay number-extraction regexes above, which require 分/時間.
const CANDIDATE_COUNT = /(\d+)\s*(?:つ|件|個)/;
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

function toDate(month: string, day: string, year?: string): string {
  return `${year ?? ""}${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function extractDateConstraint(input: string): TemporalDateConstraint | undefined {
  const range = input.match(DATE_RANGE);
  if (range) {
    const [, startMonth, startDay, endPartA, endPartB] = range;
    return {
      kind: "range",
      start: toDate(startMonth, startDay),
      end: endPartB ? toDate(endPartA, endPartB) : toDate(startMonth, endPartA),
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
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return undefined;
  return { kind: "date", date: toDate(month, day, year) };
}

function extractSpecificTime(input: string): string | undefined {
  const match = input.match(CLOCK_TIME);
  if (!match) return undefined;
  const hour = match[1] ?? match[3];
  const minute = match[2] ?? match[4] ?? "00";
  return hour ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : undefined;
}

function extractCandidateCount(input: string): number | undefined {
  const match = input.match(CANDIDATE_COUNT);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 && count <= MAX_REASONABLE_CANDIDATE_COUNT ? count : undefined;
}

export function extractTemporalRequirement(input: string): TemporalRequirement {
  const durationInput = withoutDelayExpressions(input);
  const hours = durationInput.match(DURATION_HOURS);
  const minutes = durationInput.match(DURATION_MINUTES);
  const durationMinutes = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  const delayMinutes = extractDelayMinutes(input);
  const date = extractDateConstraint(input);
  const specificTime = extractSpecificTime(input);
  const candidateCount = extractCandidateCount(input);
  const hasDeadlineLanguage = /(?:締切(?:まで)?|期限(?:まで)?|[月火水木金土日]曜(?:日)?まで|deadline|by\s+(?:friday|\d))/i.test(input);
  return {
    ...(Number.isFinite(durationMinutes) && durationMinutes > 0 && durationMinutes <= 24 * 60 ? { durationMinutes } : {}),
    ...(delayMinutes !== undefined && Number.isFinite(delayMinutes) && delayMinutes > 0 && delayMinutes <= 24 * 60 ? { delayMinutes } : {}),
    ...(date ? { date } : {}),
    ...(specificTime ? { specificTime } : {}),
    ...(hasDeadlineLanguage && date ? { deadline: date } : {}),
    ...(candidateCount !== undefined ? { candidateCount } : {}),
  };
}

export function mergeTemporalRequirements(existing: TemporalRequirement | undefined, incoming: TemporalRequirement): TemporalRequirement {
  return { ...(existing ?? {}), ...incoming };
}

export function deriveTemporalRequirementPolicy(input: string): TemporalRequirementPolicy {
  const normalized = input.toLowerCase();
  if (/(?:カレンダー|予定|calendar).{0,20}(?:登録|追加|入れ|create|add)/i.test(input)) {
    return { kind: "specific_calendar_action", required: ["specific_time"] };
  }
  const candidateScheduling =
    /(?:会議|ミーティング|打ち合わせ|meeting|schedule).{0,30}(?:候補|日程調整|調整|schedule|slots?)/i.test(input) ||
    /(?:候補(?:を|の)?.{0,12}(?:出|作|generate)|candidate\s*slots?)/i.test(normalized);
  if (candidateScheduling) return { kind: "meeting_candidates", required: ["duration", "date"] };
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
  }
}

export function toTemporalRequirementMetadata(requirement: TemporalRequirement, policy: TemporalRequirementPolicy, activeClarificationId?: string | null): TemporalRequirementMetadata {
  return { version: 1, requirement, policy, ...(activeClarificationId ? { activeClarificationId } : {}) };
}

function isTemporalRequirementPolicy(value: unknown): value is TemporalRequirementPolicy {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; required?: unknown };
  return (candidate.kind === "meeting_candidates" || candidate.kind === "specific_calendar_action" ||
    candidate.kind === "deadline_work" || candidate.kind === "retry_request" || candidate.kind === "none") &&
    Array.isArray(candidate.required) &&
    candidate.required.every((field) => field === "duration" || field === "delay" || field === "date" || field === "specific_time" || field === "deadline");
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
