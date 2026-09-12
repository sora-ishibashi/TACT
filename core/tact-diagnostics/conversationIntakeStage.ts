// Server-only correlation for failures that cross the Slack background boundary.
// The original thrown value is deliberately rethrown unchanged: Supabase and
// Slack can both reject with useful non-Error objects.

export type ConversationIntakeStage =
  | "conversation_intake.identity_resolution"
  | "conversation_intake.slack_history"
  | "conversation_intake.slack_thread"
  | "conversation_intake.conversation_link_lookup"
  | "conversation_intake.conversation_lookup"
  | "conversation_intake.conversation_create"
  | "conversation_intake.clarification_lookup"
  | "conversation_intake.message_record"
  | "conversation_intake.conversation_history"
  | "conversation_intake.work_lookup"
  | "conversation_intake.work_create"
  | "conversation_intake.conversation_work_link";

const stagesByThrownObject = new WeakMap<object, ConversationIntakeStage>();

export async function atConversationIntakeStage<T>(
  stage: ConversationIntakeStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Keep the first annotation: it is the innermost (and therefore most
    // useful) awaited boundary as the error bubbles toward Slack logging.
    if (error !== null && typeof error === "object" && !stagesByThrownObject.has(error)) {
      stagesByThrownObject.set(error, stage);
    }
    throw error;
  }
}

export function conversationIntakeStageFor(
  error: unknown,
  fallback: ConversationIntakeStage | "conversation_intake"
): ConversationIntakeStage | "conversation_intake" {
  if (error !== null && typeof error === "object") {
    return stagesByThrownObject.get(error) ?? fallback;
  }
  return fallback;
}
