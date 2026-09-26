import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error("AI_INTEGRATIONS_OPENAI_BASE_URL must be set");
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY must be set");
}

export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  timeout: 150000,
  maxRetries: 2,
});