import { z } from 'zod';

/** Every setting comes from the environment. Defaults are the documented ones (brief §5, §6, §12). */
const int = (d: number) => z.coerce.number().int().positive().default(d);
const num = (d: number) => z.coerce.number().positive().default(d);

export const EnvSchema = z.object({
  PORT: int(8787),
  DATABASE_URL: z.string().optional(),
  ROOTLINE_DATA_DIR: z.string().default('.data/pglite'),

  // model layer
  VERTEX_PROJECT_ID: z.string().optional(),
  VERTEX_LOCATION: z.string().default('global'),
  VERTEX_SERVICE_ACCOUNT_B64: z.string().optional(),
  ROOTLINE_MODEL: z.string().default('gemini-3.8-flash'),
  ROOTLINE_THINKING_LEVEL: z.enum(['low', 'medium', 'high']).default('medium'),
  OPENROUTER_API_KEY: z.string().optional(),
  ROOTLINE_JEV_MODEL: z.string().default('typesafe/jev-1.13'),

  // engine budgets (identical for every arm and the baseline)
  ROOTLINE_TASK_CONCURRENCY: int(4),
  ROOTLINE_MAX_ROUNDS: int(3),
  ROOTLINE_MAX_TOOL_CALLS: int(40),
  ROOTLINE_MAX_LLM_CALLS: int(30),
  ROOTLINE_MAX_TOKENS: int(2_000_000),
  ROOTLINE_DEADLINE_MS: int(360_000),
  ROOTLINE_SPECIALIST_TOOL_CALLS: int(8),
  ROOTLINE_TOOL_DEADLINE_MS: int(1500),
  ROOTLINE_TOOL_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // evaluation
  ROOTLINE_EVAL_CONCURRENCY: int(2),
  ROOTLINE_EVAL_MAX_USD: num(50),

  // server
  ROOTLINE_ACCESS_CODE: z.string().optional(),
  ROOTLINE_RUNS_PER_IP_PER_HOUR: int(3),
  ROOTLINE_RUNS_PER_DAY: int(40),
  ROOTLINE_FLOW_VIEWER_URL: z.string().url().default('https://flow.slate-app.online'),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Empty strings mean "unset".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  return EnvSchema.parse(cleaned);
}
