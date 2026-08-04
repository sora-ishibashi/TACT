import { supabase } from "./supabase";

export async function createExecution(
  userId: string,
  workflow: string,
  userInput: string
) {
  const { data, error } = await supabase
    .from("executions")
    .insert({
      user_id: userId,
      workflow,
      user_input: userInput,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}