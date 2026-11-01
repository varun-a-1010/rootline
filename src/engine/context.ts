import type { z } from 'zod';
import type { StopReason, TaskSpec } from '../contracts/agents.js';
import type { RunConfig } from '../contracts/events.js';
import type { DependencyEdge, IncidentReport, ServiceInfo } from '../contracts/world.js';
import type { JevClient, JevQuestion, JevResult } from '../llm/jev.js';
import { generateStructured } from '../llm/structured.js';
import type { GenerateRequest, GenerateResponse, LlmProvider } from '../llm/types.js';
import type { ToolRunner, ToolCallResult } from '../tools/runner.js';
import { Budget, BudgetExhaustedError, type LlmKind } from './budgets.js';
import type { RunLog } from './events.js';
import type { EvidenceLedger } from './ledger.js';
import { fold, type RunState } from './run-state.js';

/** Optional hook (arm D): reshape a tool result's model view before the specialist reads it. */
export type ToolViewHook = (ctx: RunContext, task: TaskSpec, result: ToolCallResult) => Promise<Record<string, unknown>>;

/**
 * Everything an agent may touch during one run. Model calls, tool calls and Jev calls all go
 * through here so that budgets, events and evidence are recorded the same way for every arm.
 */
export class RunContext {
  readonly executedFingerprints = new Set<string>();
  stopReason: StopReason | null = null;
  toolViewHook: ToolViewHook | null = null;
  private stateCache: { seq: number; state: RunState } | null = null;
  private taskSeq = 0;

  constructor(
    readonly runId: string,
    readonly worldId: string,
    readonly incident: IncidentReport,
    readonly services: ServiceInfo[],
    readonly dependencies: DependencyEdge[],
    readonly config: RunConfig,
    readonly log: RunLog,
    readonly ledger: EvidenceLedger,
    readonly runner: ToolRunner,
    readonly budget: Budget,
    readonly llm: LlmProvider,
    readonly jev: JevClient | null,
    /** Run-level signal: cancellation and the deadline. */
    readonly signal: AbortSignal,
  ) {}

  /** Current state (fold of the log so far), cached per sequence number. */
  state(): RunState {
    const seq = this.log.events.length;
    if (!this.stateCache || this.stateCache.seq !== seq) this.stateCache = { seq, state: fold(this.log.events, this.runId) };
    return this.stateCache.state;
  }

  /** Dense task ids for this run: T1, T2, ... */
  nextTaskId(): string {
    this.taskSeq += 1;
    return `T${this.taskSeq}`;
  }

  /** Record the first stop reason (later ones do not overwrite it). */
  stop(reason: StopReason): void {
    this.stopReason ??= reason;
  }

  get thinkingLevel() {
    return this.config.thinkingLevel;
  }

  private onAttempt(taskId: string | null) {
    return (a: Parameters<NonNullable<GenerateRequest['onAttempt']>>[0]) => {
      this.log.emit('llm.call', { role: a.role, provider: a.provider, model: a.model, attempt: a.attempt, status: a.status, httpStatus: a.httpStatus, errorKind: a.errorKind, latencyMs: a.latencyMs, usage: a.usage, modelVersion: a.modelVersion }, taskId);
      if (a.status === 'ok') this.budget.addUsage(a.usage);
    };
  }

  /** One model call (counts against the LLM budget before it is made). */
  async generate(taskId: string | null, kind: LlmKind, req: Omit<GenerateRequest, 'signal' | 'onAttempt' | 'thinkingLevel'>, signal = this.signal): Promise<GenerateResponse> {
    this.budget.takeLlmCall(kind);
    return this.llm.generate({ ...req, thinkingLevel: this.thinkingLevel, signal, onAttempt: this.onAttempt(taskId) });
  }

  /** Structured call with zod re-validation and one repair; each call counts against the budget. */
  async structured<T>(taskId: string | null, kind: LlmKind, req: Omit<GenerateRequest, 'signal' | 'onAttempt' | 'thinkingLevel' | 'responseSchema' | 'tools' | 'toolMode'>, schema: z.ZodType<T>, signal = this.signal): Promise<T> {
    const budget = this.budget;
    const counted: typeof this.llm = {
      name: this.llm.name,
      model: this.llm.model,
      generate: (r) => {
        budget.takeLlmCall(kind);
        return this.llm.generate(r);
      },
    };
    const res = await generateStructured(counted, { ...req, thinkingLevel: this.thinkingLevel, signal, onAttempt: this.onAttempt(taskId) }, schema);
    return res.value;
  }

  /** One tool call on behalf of an agent. */
  async callTool(task: TaskSpec, agent: string, tool: string, params: unknown, requestedBy: 'model' | 'critic' = 'model'): Promise<ToolCallResult> {
    this.budget.takeToolCall();
    const res = await this.runner.call(tool, params, { taskId: task.id, agent }, this.signal);
    this.executedFingerprints.add(res.fingerprint);
    this.log.emit(
      'tool.result',
      {
        callId: res.callId,
        tool,
        fingerprint: res.fingerprint,
        canonical: res.canonical,
        status: res.envelope.status,
        evidenceId: res.evidence?.evidenceId ?? null,
        recordCount: res.envelope.records.length,
        error: res.envelope.error ? { code: res.envelope.error.code, message: res.envelope.error.message, retryable: res.envelope.error.retryable } : null,
        attempts: res.attempts.length,
        caption: captionFor(tool, res.canonical),
      },
      task.id,
    );
    return res;
  }

  async jevDecide(taskId: string | null, role: string, state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult | null> {
    if (!this.jev || Object.keys(questions).length === 0) return null;
    return this.jev.decide(state, questions, {
      role,
      signal: this.signal,
      onAttempt: (a) => this.log.emit('jev.call', { role: a.role, attempt: a.attempt, status: a.status, httpStatus: a.httpStatus, latencyMs: a.latencyMs, questions: a.questions, usage: a.usage }, taskId),
    });
  }
}

export function captionFor(tool: string, c: Record<string, unknown>): string {
  const svcs = Array.isArray(c.services) ? (c.services as string[]).join(',') : typeof c.service === 'string' ? c.service : '';
  const extra = typeof c.metric === 'string' ? ` ${c.metric}` : typeof c.contains === 'string' ? ` "${c.contains}"` : typeof c.count_by === 'string' ? ` by ${c.count_by}` : typeof c.text === 'string' ? ` "${c.text}"` : '';
  return `${tool} ${svcs}${extra}`.trim();
}

export { BudgetExhaustedError };
