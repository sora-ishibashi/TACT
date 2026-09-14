// TACT Work — TIME-P1b temporal understanding.
// Request constraints here are intentionally separate from TIME-P1a execution
// state (deadline, waitUntil, and nextRetryAt).

export type TemporalDateConstraint =
  | { readonly kind: "relative"; readonly value: "today" | "tomorrow" | "this_week" | "next_week" | "friday" }
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "range"; readonly start: string; readonly end: string };

export interface TemporalRequirement {
  readonly durationMinutes?: number;
  readonly date?: TemporalDateConstraint;
  // Without a reliable account timezone, a date and a clock time must not be
  // combined into an ambiguous timestamp.
  readonly specificTime?: string;
  readonly deadline?: TemporalDateConstraint;
}

export type TemporalRequiredField = "duration" | "date" | "specific_time" | "deadline";

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

export function extractTemporalRequirement(input: string): TemporalRequirement {
  const hours = input.match(DURATION_HOURS);
  const minutes = input.match(DURATION_MINUTES);
  const durationMinutes = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  const date = extractDateConstraint(input);
  const specificTime = extractSpecificTime(input);
  const hasDeadlineLanguage = /(?:締切(?:まで)?|期限(?:まで)?|[月火水木金土日]曜(?:日)?まで|deadline|by\s+(?:friday|\d))/i.test(input);
  return {
    ...(Number.isFinite(durationMinutes) && durationMinutes > 0 && durationMinutes <= 24 * 60 ? { durationMinutes } : {}),
    ...(date ? { date } : {}),
    ...(specificTime ? { specificTime } : {}),
    ...(hasDeadlineLanguage && date ? { deadline: date } : {}),
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
  if (/(?:再試行|retry)/i.test(input)) return { kind: "retry_request", required: ["duration"] };
  return { kind: "none", required: [] };
}

export function findMissingTemporalRequirements(requirement: TemporalRequirement, policy: TemporalRequirementPolicy): TemporalRequiredField[] {
  return policy.required.filter((field) => {
    switch (field) {
      case "duration": return requirement.durationMinutes === undefined;
      case "date": return requirement.date === undefined;
      case "specific_time": return requirement.specificTime === undefined;
      case "deadline": return requirement.deadline === undefined;
    }
  });
}

export function buildTemporalClarificationQuestion(field: TemporalRequiredField): string {
  switch (field) {
    case "duration": return "会議の所要時間を教えてください。";
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
    candidate.required.every((field) => field === "duration" || field === "date" || field === "specific_time" || field === "deadline");
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
