import type { EvidenceRecord, ToolAttempt } from '../contracts/evidence.js';
import type { ToolEnvelope, ToolError, ToolErrorCode } from '../contracts/tools.js';
import type { EvidenceLedger } from '../engine/ledger.js';
import { canonicalJson, hashUnit, sha256 } from '../util/canonical.js';
import { AbortedError, sleep } from '../util/sleep.js';
import type { FaultInjector } from './faults.js';
import { TOOLS } from './registry.js';
import { ToolInputError, type ToolContext, type ToolDef, type ToolOutput } from './types.js';

export interface RunnerOptions {
  /** Per-attempt deadline. A timeout really elapses, so latency numbers are honest. */
  deadlineMs: number;
  /** Retries for retryable errors (timeout, unavailable, rate_limited). */
  maxRetries: number;
  backoffBaseMs: number;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = { deadlineMs: 1500, maxRetries: 2, backoffBaseMs: 150 };

export interface ToolCallMeta {
  taskId: string | null;
  agent: string | null;
}

export interface ToolRunnerHooks {
  onAttempt?(attempt: ToolAttempt): void;
  onEvidence?(evidence: EvidenceRecord): void;
}

export interface ToolCallResult {
  callId: string;
  tool: string;
  canonical: Record<string, unknown>;
  fingerprint: string;
  envelope: ToolEnvelope;
  /** What the model sees. */
  modelView: Record<string, unknown>;
  evidence: EvidenceRecord | null;
  attempts: ToolAttempt[];
}

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set(['timeout', 'unavailable', 'rate_limited']);
const EXCERPT_CHARS = 2400;

/** Canonical fingerprint of a logical request: the novelty key and the fault-matching key. */
export function fingerprintOf(tool: string, canonical: Record<string, unknown>): string {
  return sha256(`${tool}:${canonicalJson(canonical)}`).slice(0, 16);
}

/**
 * Executes tool calls: validation, canonicalization, fault injection, per-attempt deadline,
 * bounded retries with backoff, attempt records, and evidence minting.
 */
export class ToolRunner {
  private calls = 0;

  constructor(
    private readonly ctx: ToolContext,
    private readonly faults: FaultInjector,
    private readonly ledger: EvidenceLedger,
    private readonly opts: RunnerOptions = DEFAULT_RUNNER_OPTIONS,
    private readonly hooks: ToolRunnerHooks = {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Validate and canonicalize without executing (used for novelty checks on follow-ups). */
  prepare(name: string, raw: unknown): { ok: true; tool: ToolDef; canonical: Record<string, unknown>; fingerprint: string } | { ok: false; message: string } {
    const tool = (TOOLS as Record<string, ToolDef>)[name];
    if (!tool) return { ok: false, message: `unknown tool "${name}"` };
    const parsed = tool.input.safeParse(raw ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
      return { ok: false, message: `invalid input: ${msg}` };
    }
    try {
      const canonical = stripUndefined(tool.canonicalize(parsed.data, this.ctx));
      return { ok: true, tool, canonical, fingerprint: fingerprintOf(name, canonical) };
    } catch (e) {
      if (e instanceof ToolInputError) return { ok: false, message: e.message };
      throw e;
    }
  }

  async call(name: string, raw: unknown, meta: ToolCallMeta, signal: AbortSignal): Promise<ToolCallResult> {
    this.calls += 1;
    const callId = `call_${this.calls}`;
    const attempts: ToolAttempt[] = [];
    const record = (a: Omit<ToolAttempt, 'attemptId' | 'callId' | 'taskId' | 'agent'>) => {
      const full: ToolAttempt = { attemptId: `${callId}.${a.attempt}`, callId, taskId: meta.taskId, agent: meta.agent, ...a };
      attempts.push(full);
      this.hooks.onAttempt?.(full);
    };

    const prep = this.prepare(name, raw);
    if (!prep.ok) {
      const canonical = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      record({
        tool: name,
        canonicalParams: canonical,
        fingerprint: fingerprintOf(name, canonical),
        attempt: 1,
        status: 'error',
        errorCode: 'invalid_input',
        latencyMs: 0,
        startedAt: this.now(),
      });
      return this.errorResult(callId, name, canonical, fingerprintOf(name, canonical), attempts, {
        code: 'invalid_input',
        retryable: false,
        message: prep.message,
      });
    }

    const { tool, canonical, fingerprint } = prep;
    const maxAttempts = 1 + this.opts.maxRetries;
    let lastError: ToolError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) throw new AbortedError();
      const decision = this.faults.decide(name, canonical, fingerprint, attempt);
      const started = this.now();
      const base = { tool: name, canonicalParams: canonical, fingerprint, attempt, startedAt: started };
      const effect = decision.effect;

      if (effect?.kind === 'timeout') {
        await sleep(this.opts.deadlineMs, signal);
        lastError = { code: 'timeout', retryable: true, message: `${name} did not respond within ${this.opts.deadlineMs} ms` };
        record({ ...base, status: 'error', errorCode: 'timeout', latencyMs: this.now() - started });
      } else if (effect?.kind === 'error') {
        await sleep(Math.min(decision.latencyMs, this.opts.deadlineMs), signal);
        lastError = {
          code: effect.code,
          retryable: true,
          message: effect.code === 'rate_limited' ? `${tool.source} is rate limiting requests` : `${tool.source} is temporarily unavailable`,
        };
        record({ ...base, status: 'error', errorCode: effect.code, latencyMs: this.now() - started });
      } else {
        const partial = effect?.kind === 'partial' ? effect : null;
        let execParams = canonical;
        if (partial?.truncateWindowFraction !== undefined && typeof canonical.from === 'string' && typeof canonical.to === 'string') {
          const f = Date.parse(canonical.from);
          const t = Date.parse(canonical.to);
          execParams = { ...canonical, to: new Date(f + Math.max(60_000, Math.floor((t - f) * partial.truncateWindowFraction))).toISOString() };
        }
        try {
          const exec = tool.execute(this.ctx, execParams, signal);
          const out = await withDeadline(exec, this.opts.deadlineMs, signal);
          const elapsed = this.now() - started;
          if (decision.latencyMs > elapsed) await sleep(Math.min(decision.latencyMs - elapsed, this.opts.deadlineMs - elapsed), signal);
          const shaped = partial ? this.applyPartial(tool, out, canonical, execParams, fingerprint, partial) : out;
          const status = shaped.completeness === 'partial' ? 'partial' : 'ok';
          record({ ...base, status, errorCode: null, latencyMs: this.now() - started });
          return this.okResult(callId, tool, canonical, fingerprint, attempts, shaped, meta);
        } catch (e) {
          if (e instanceof AbortedError) throw e;
          if (e instanceof ToolInputError) {
            record({ ...base, status: 'error', errorCode: 'invalid_input', latencyMs: this.now() - started });
            return this.errorResult(callId, name, canonical, fingerprint, attempts, { code: 'invalid_input', retryable: false, message: e.message });
          }
          if (e instanceof DeadlineError) {
            lastError = { code: 'timeout', retryable: true, message: `${name} did not respond within ${this.opts.deadlineMs} ms` };
            record({ ...base, status: 'error', errorCode: 'timeout', latencyMs: this.now() - started });
          } else {
            // An unexpected failure inside the tool. Deterministic, so retrying would not help.
            record({ ...base, status: 'error', errorCode: 'unavailable', latencyMs: this.now() - started });
            return this.errorResult(callId, name, canonical, fingerprint, attempts, {
              code: 'unavailable',
              retryable: false,
              message: `${tool.source} failed: ${(e as Error).message}`,
            });
          }
        }
      }
      if (lastError && RETRYABLE.has(lastError.code) && attempt < maxAttempts) {
        await sleep(this.opts.backoffBaseMs * 2 ** (attempt - 1), signal);
        continue;
      }
      break;
    }
    return this.errorResult(callId, name, canonical, fingerprint, attempts, {
      ...lastError!,
      message: `${lastError!.message} (after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'})`,
    });
  }

  private applyPartial(
    tool: ToolDef,
    out: ToolOutput,
    canonical: Record<string, unknown>,
    execParams: Record<string, unknown>,
    fingerprint: string,
    partial: { dropFraction?: number; truncateWindowFraction?: number },
  ): ToolOutput {
    let shaped = out;
    const notes = [...out.notes];
    if (execParams !== canonical) {
      shaped = {
        ...shaped,
        coverage: {
          requested: `${canonical.from}..${canonical.to}`,
          returned: `${execParams.from}..${execParams.to}`,
          fraction: partial.truncateWindowFraction,
        },
      };
      notes.push(`The store returned results only for ${execParams.from}..${execParams.to}; the rest of the requested range is missing.`);
    }
    if (partial.dropFraction) {
      const seed = this.faults.profile.seed;
      const keep = (ref: string) => hashUnit(seed, 'drop', fingerprint, ref) >= partial.dropFraction!;
      if (tool.drop) {
        shaped = tool.drop(shaped, keep);
      } else {
        const idx = shaped.refs.map((r, i) => (keep(r) ? i : -1)).filter((i) => i >= 0);
        shaped = {
          ...shaped,
          records: idx.map((i) => shaped.records[i]),
          modelRecords: idx.map((i) => shaped.modelRecords[i]),
          refs: idx.map((i) => shaped.refs[i]!),
        };
      }
      notes.push('The store returned an incomplete result: some matching records could not be read.');
    }
    return { ...shaped, completeness: 'partial', notes };
  }

  private okResult(
    callId: string,
    tool: ToolDef,
    canonical: Record<string, unknown>,
    fingerprint: string,
    attempts: ToolAttempt[],
    out: ToolOutput,
    meta: ToolCallMeta,
  ): ToolCallResult {
    const status = out.completeness === 'partial' ? 'partial' : 'ok';
    const evidence = this.ledger.mint({
      tool: tool.name,
      callId,
      request: canonical,
      services: out.services,
      window: out.window,
      retrievedAt: this.now(),
      completeness: out.completeness,
      recordCount: out.records.length,
      truncated: out.truncated,
      sourceRefs: out.refs,
      excerpt: excerptOf(out),
      notes: out.notes,
      taskId: meta.taskId,
      agent: meta.agent,
    });
    this.hooks.onEvidence?.(evidence);
    const envelope: ToolEnvelope = {
      status,
      tool: tool.name,
      request: canonical,
      source: tool.source,
      ...(out.window ? { window: out.window } : {}),
      records: out.records,
      completeness: out.completeness,
      ...(out.coverage ? { coverage: out.coverage } : {}),
      truncated: out.truncated,
      ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}),
      evidenceId: evidence.evidenceId,
      ...(out.notes.length ? { notes: out.notes } : {}),
    };
    const modelView: Record<string, unknown> = {
      evidence_id: evidence.evidenceId,
      status,
      completeness: out.completeness,
      record_count: out.records.length,
      ...(out.truncated ? { truncated: true } : {}),
      ...(out.nextCursor ? { next_cursor: out.nextCursor } : {}),
      ...(out.coverage ? { coverage: out.coverage } : {}),
      ...(out.notes.length ? { notes: out.notes } : {}),
      ...(out.summary ? { summary: out.summary } : {}),
      ...(attempts.length > 1 ? { attempts: attempts.length } : {}),
      records: out.modelRecords,
    };
    return { callId, tool: tool.name, canonical, fingerprint, envelope, modelView, evidence, attempts };
  }

  private errorResult(
    callId: string,
    tool: string,
    canonical: Record<string, unknown>,
    fingerprint: string,
    attempts: ToolAttempt[],
    error: ToolError,
  ): ToolCallResult {
    const source = (TOOLS as Record<string, ToolDef>)[tool]?.source ?? 'unknown';
    const envelope: ToolEnvelope = {
      status: 'error',
      tool,
      request: canonical,
      source,
      records: [],
      completeness: 'unknown',
      truncated: false,
      error,
    };
    return {
      callId,
      tool,
      canonical,
      fingerprint,
      envelope,
      modelView: { status: 'error', error, attempts: attempts.length, note: 'No evidence was recorded for this call.' },
      evidence: null,
      attempts,
    };
  }
}

class DeadlineError extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DeadlineError('deadline')), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function excerptOf(out: ToolOutput): string {
  const lines: string[] = [];
  if (out.summary) lines.push(JSON.stringify(out.summary));
  let used = lines.join('\n').length;
  let shown = 0;
  for (const r of out.modelRecords) {
    const s = JSON.stringify(r);
    const line = s.length > 600 ? s.slice(0, 600) + '…' : s;
    if (used + line.length > EXCERPT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < out.modelRecords.length) lines.push(`… (${out.modelRecords.length - shown} more records)`);
  if (out.modelRecords.length === 0) lines.push('(no records)');
  return lines.join('\n');
}
