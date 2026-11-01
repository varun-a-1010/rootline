import { z } from 'zod';
import { AbortedError, sleep } from '../util/sleep.js';
import { LlmError, type LlmErrorKind } from './types.js';

/**
 * Jev ("System One" decision model, TypeSafe) through OpenRouter's Decisions endpoint:
 *   POST https://openrouter.ai/api/alpha/decisions
 *   { model, state, questions: { <name>: { type, instructions, criteria? } } }
 * Answers come back keyed by question name. Questions in one request are judged independently
 * against the same state, so callers batch them. Every response is validated with zod.
 */

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});
const ScoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  legend: z.record(z.string(), z.string()).optional(),
});
export const JevAnswer = z.discriminatedUnion('type', [NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type JevAnswer = z.infer<typeof JevAnswer>;

const DecisionsResponse = z.object({
  id: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  answers: z.record(z.string(), JevAnswer),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int(), cost: z.number().optional() }),
});

export interface JevUsage {
  input: number | null;
  output: number | null;
  costUsd: number | null;
}

export interface JevAttempt {
  role: string;
  attempt: number;
  status: 'ok' | 'error';
  httpStatus: number | null;
  latencyMs: number;
  usage: JevUsage | null;
  questions: number;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  model: string | null;
  latencyMs: number;
  requests: number;
}

export interface JevClient {
  readonly model: string;
  decide(
    state: unknown,
    questions: Record<string, JevQuestion>,
    opts: { role: string; signal: AbortSignal; onAttempt?: (a: JevAttempt) => void },
  ): Promise<JevResult>;
}

/** Keep each request well inside Jev 1.13's per-request context. */
const MAX_QUESTIONS_PER_REQUEST = 40;
const MAX_REQUEST_CHARS = 120_000;

export class OpenRouterJev implements JevClient {
  constructor(
    private readonly apiKey: string,
    readonly model = 'typesafe/jev-1.13',
    private readonly opts: { maxAttempts?: number; backoffBaseMs?: number; timeoutMs?: number; url?: string } = {},
  ) {}

  async decide(
    state: unknown,
    questions: Record<string, JevQuestion>,
    o: { role: string; signal: AbortSignal; onAttempt?: (a: JevAttempt) => void },
  ): Promise<JevResult> {
    const started = Date.now();
    const names = Object.keys(questions);
    const stateChars = JSON.stringify(state).length;
    const batches: string[][] = [];
    let cur: string[] = [];
    let chars = stateChars;
    for (const n of names) {
      const q = JSON.stringify(questions[n]).length + n.length;
      if (cur.length && (cur.length >= MAX_QUESTIONS_PER_REQUEST || chars + q > MAX_REQUEST_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = stateChars;
      }
      cur.push(n);
      chars += q;
    }
    if (cur.length) batches.push(cur);

    const answers: Record<string, JevAnswer> = {};
    const usage: JevUsage = { input: 0, output: 0, costUsd: 0 };
    let model: string | null = null;
    for (const batch of batches) {
      const qs = Object.fromEntries(batch.map((n) => [n, questions[n]!]));
      const res = await this.request(state, qs, o);
      Object.assign(answers, res.answers);
      model = res.model;
      usage.input = usage.input === null || res.usage.input === null ? null : usage.input + res.usage.input;
      usage.output = usage.output === null || res.usage.output === null ? null : usage.output + res.usage.output;
      usage.costUsd = usage.costUsd === null || res.usage.costUsd === null ? null : usage.costUsd + res.usage.costUsd;
    }
    return { answers, usage, model, latencyMs: Date.now() - started, requests: batches.length };
  }

  private async request(
    state: unknown,
    questions: Record<string, JevQuestion>,
    o: { role: string; signal: AbortSignal; onAttempt?: (a: JevAttempt) => void },
  ): Promise<{ answers: Record<string, JevAnswer>; usage: JevUsage; model: string }> {
    const maxAttempts = this.opts.maxAttempts ?? 3;
    let last: LlmError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (o.signal.aborted) throw new AbortedError();
      const t0 = Date.now();
      const nq = Object.keys(questions).length;
      try {
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        o.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 60_000);
        let res: Response;
        try {
          res = await fetch(this.opts.url ?? 'https://openrouter.ai/api/alpha/decisions', {
            method: 'POST',
            headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-openrouter-title': 'Rootline' },
            body: JSON.stringify({ model: this.model, state, questions }),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
          o.signal.removeEventListener('abort', onAbort);
        }
        if (o.signal.aborted) throw new AbortedError();
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const kind: LlmErrorKind = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server' : res.status === 401 || res.status === 403 ? 'auth' : 'bad_request';
          last = new LlmError(kind, `Jev ${res.status}: ${text.slice(0, 300)}`, res.status, attempt);
          o.onAttempt?.({ role: o.role, attempt, status: 'error', httpStatus: res.status, latencyMs: Date.now() - t0, usage: null, questions: nq });
          if (!last.retryable) throw last;
        } else {
          const parsed = DecisionsResponse.safeParse(await res.json());
          if (!parsed.success) {
            o.onAttempt?.({ role: o.role, attempt, status: 'error', httpStatus: res.status, latencyMs: Date.now() - t0, usage: null, questions: nq });
            throw new LlmError('invalid_output', `Jev response failed validation: ${parsed.error.issues[0]?.message ?? ''}`, res.status, attempt);
          }
          const d = parsed.data;
          const usage: JevUsage = { input: d.usage.input_tokens, output: d.usage.output_tokens, costUsd: d.usage.cost ?? null };
          o.onAttempt?.({ role: o.role, attempt, status: 'ok', httpStatus: res.status, latencyMs: Date.now() - t0, usage, questions: nq });
          const missing = Object.keys(questions).filter((n) => !(n in d.answers));
          if (missing.length) throw new LlmError('invalid_output', `Jev omitted answers for: ${missing.join(', ')}`, res.status, attempt);
          return { answers: d.answers, usage, model: d.model };
        }
      } catch (e) {
        if (e instanceof AbortedError || o.signal.aborted) throw new AbortedError();
        if (e instanceof LlmError) {
          if (!e.retryable) throw e;
          last = e;
        } else {
          last = new LlmError('network', `Jev request failed: ${(e as Error).message}`, null, attempt);
          o.onAttempt?.({ role: o.role, attempt, status: 'error', httpStatus: null, latencyMs: Date.now() - t0, usage: null, questions: nq });
        }
      }
      if (attempt < maxAttempts) await sleep((this.opts.backoffBaseMs ?? 1000) * 2 ** (attempt - 1), o.signal);
    }
    throw new LlmError(last?.kind ?? 'server', `${last?.message ?? 'failed'} (after ${maxAttempts} attempts)`, last?.httpStatus ?? null, maxAttempts);
  }
}
