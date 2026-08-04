export interface Agent {
  id: string;

  name: string;

  provider: "openai" | "gemini" | "claude";

  systemPrompt: string;
}