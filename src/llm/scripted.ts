import { AbortedError, sleep } from '../util/sleep.js';
import type { JevAnswer, JevAttempt, JevClient, JevQuestion, JevResult } from './jev.js';
import { LlmError, type Content, type GenerateRequest, type GenerateResponse, type LlmProvider, type TokenUsage } from './types.js';

/**
 * Deterministic test doubles. A script decides each response from the request (role, contents,
 * tools), so the whole engine runs offline in tests with canned function calls and JSON.
 */
export interface ScriptStep {
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  json?: unknown;
  text?: string;
  usage?: Partial<TokenUsage>;
  delayMs?: number;
  error?: LlmError;
}

export type Script = (req: GenerateRequest, n: number) => ScriptStep | Promise<ScriptStep>;

export interface ScriptedCall {
  role: string;
  n: number;
  req: GenerateRequest;
  startedAt: number;
  endedAt: number;
}

const DEFAULT_USAGE: TokenUsage = { input: 1000, output: 100, thinking: 50, cached: 0 };

export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-flash';
  readonly calls: ScriptedCall[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly scripts: Record<string, Script | ScriptStep[]>) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    if (req.signal.aborted) throw new AbortedError();
    const n = this.counts.get(req.role) ?? 0;
    this.counts.set(req.role, n + 1);
    const script = this.scripts[req.role] ?? this.scripts['*'];
    if (!script) throw new Error(`ScriptedProvider: no script for role "${req.role}"`);
    const started = Date.now();
    const step = Array.isArray(script) ? script[Math.min(n, script.length - 1)]! : await script(req, n);
    if (step.delayMs) await sleep(step.delayMs, req.signal);
    const usage: TokenUsage = { ...DEFAULT_USAGE, ...step.usage };
    if (step.error) {
      req.onAttempt?.({ provider: this.name, model: this.model, role: req.role, attempt: 1, status: 'error', httpStatus: step.error.httpStatus, errorKind: step.error.kind, latencyMs: Date.now() - started, usage: null, modelVersion: null });
      this.calls.push({ role: req.role, n, req, startedAt: started, endedAt: Date.now() });
      throw step.error;
    }
    const parts: Content['parts'] = [];
    if (step.functionCalls) {
      step.functionCalls.forEach((fc, i) => parts.push({ functionCall: { id: `fc_${req.role}_${n}_${i}`, name: fc.name, args: fc.args }, ...(i === 0 ? { thoughtSignature: 'sig' } : {}) }));
    }
    const text = step.json !== undefined ? JSON.stringify(step.json) : (step.text ?? '');
    if (text) parts.push({ text });
    req.onAttempt?.({ provider: this.name, model: this.model, role: req.role, attempt: 1, status: 'ok', httpStatus: 200, errorKind: null, latencyMs: Date.now() - started, usage, modelVersion: 'scripted-1' });
    this.calls.push({ role: req.role, n, req, startedAt: started, endedAt: Date.now() });
    return {
      content: { role: 'model', parts },
      text,
      functionCalls: parts.filter((p) => p.functionCall).map((p) => p.functionCall!),
      usage,
      modelVersion: 'scripted-1',
      finishReason: 'STOP',
      latencyMs: Date.now() - started,
      attempts: 1,
    };
  }
}

export type JevScript = (state: unknown, questions: Record<string, JevQuestion>, role: string) => Record<string, JevAnswer>;

export class ScriptedJev implements JevClient {
  readonly model = 'scripted-jev';
  readonly calls: Array<{ role: string; questions: Record<string, JevQuestion>; state: unknown }> = [];
  constructor(private readonly script: JevScript) {}

  async decide(state: unknown, questions: Record<string, JevQuestion>, o: { role: string; signal: AbortSignal; onAttempt?: (a: JevAttempt) => void }): Promise<JevResult> {
    if (o.signal.aborted) throw new AbortedError();
    this.calls.push({ role: o.role, questions, state });
    const answers = this.script(state, questions, o.role);
    const usage = { input: 200 * Object.keys(questions).length, output: 10, costUsd: 0 };
    o.onAttempt?.({ role: o.role, attempt: 1, status: 'ok', httpStatus: 200, latencyMs: 1, usage, questions: Object.keys(questions).length });
    return { answers, usage, model: this.model, latencyMs: 1, requests: 1 };
  }
}

/** A Jev double that answers every question the same neutral way. */
export function neutralJev(p = 0.5): ScriptedJev {
  return new ScriptedJev((_s, qs) =>
    Object.fromEntries(
      Object.entries(qs).map(([k, q]) => {
        if (q.type === 'noul') return [k, { type: 'noul', noul: p } as JevAnswer];
        if (q.type === 'choice') {
          const opts = Object.keys(q.criteria);
          return [k, { type: 'choice', choice: opts[0]!, confidence: 0.5, probabilities: Object.fromEntries(opts.map((o) => [o, 1 / opts.length])) } as JevAnswer];
        }
        return [k, { type: 'score', score: (q.criteria.length - 1) / 2 } as JevAnswer];
      }),
    ),
  );
}
