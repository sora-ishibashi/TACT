import {
  extractTemporalRequirement,
  mergeTemporalRequirements,
  deriveTemporalRequirementPolicy,
  findMissingTemporalRequirements,
  buildTemporalClarificationQuestion,
  toTemporalRequirementMetadata,
  readTemporalRequirementMetadata,
} from "../../../core/tact-work/temporalRequirements";
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

  results.push(check("[boundary] request facts do not expose TIME-P1a execution state", !("waitUntil" in afterAnswer) && !("nextRetryAt" in afterAnswer)));

  return summarize("work/temporalRequirements", results);
}
