import { LLMProvider } from "./types";

export interface ModelInfo {
  provider: LLMProvider;
  name: string;

  quality: number;
  speed: number;
  cost: number;
}

export const MODELS: ModelInfo[] = [
  {
    provider: "openai",
    name: "GPT",

    quality: 10,
    speed: 8,
    cost: 6,
  },

  {
    provider: "claude",
    name: "Claude",

    quality: 10,
    speed: 8,
    cost: 5,
  },

  {
    provider: "gemini",
    name: "Gemini",

    quality: 9,
    speed: 10,
    cost: 3,
  },

  {
    provider: "grok",
    name: "Grok",

    quality: 8,
    speed: 9,
    cost: 4,
  },
];