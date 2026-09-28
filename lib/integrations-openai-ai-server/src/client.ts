import OpenAI from "openai";

/**
 * The OpenAI client is created lazily, on first use, so the API server can
 * boot and serve non-AI modules (inventory, locations, bus planning) without
 * AI_INTEGRATIONS_OPENAI_* configured. Only AI code paths call getOpenAI().
 */
let client: OpenAI | undefined;

export function isOpenAIConfigured(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  );
}

export function getOpenAI(): OpenAI {
  if (client) return client;
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error("AI_INTEGRATIONS_OPENAI_BASE_URL must be set");
  }
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY must be set");
  }
  client = new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    timeout: 150000,
    maxRetries: 2,
  });
  return client;
}
