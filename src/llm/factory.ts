import type { Env } from '../config.js';
import { OpenRouterJev, type JevClient } from './jev.js';
import type { LlmProvider } from './types.js';
import { VertexGeminiProvider } from './vertex-gemini.js';

/** Build the live providers from the environment. Missing credentials -> null (callers decide). */
export function createLiveProviders(env: Env): { llm: LlmProvider | null; jev: JevClient | null; problems: string[] } {
  const problems: string[] = [];
  let llm: LlmProvider | null = null;
  if (env.VERTEX_PROJECT_ID) {
    llm = new VertexGeminiProvider({
      projectId: env.VERTEX_PROJECT_ID,
      location: env.VERTEX_LOCATION,
      model: env.ROOTLINE_MODEL,
      serviceAccountB64: env.VERTEX_SERVICE_ACCOUNT_B64,
    });
  } else {
    problems.push('VERTEX_PROJECT_ID is not set (Gemini on Vertex AI unavailable)');
  }
  const jev = env.OPENROUTER_API_KEY ? new OpenRouterJev(env.OPENROUTER_API_KEY, env.ROOTLINE_JEV_MODEL) : null;
  if (!jev) problems.push('OPENROUTER_API_KEY is not set (Jev unavailable: arm D and the judge need it)');
  return { llm, jev, problems };
}
