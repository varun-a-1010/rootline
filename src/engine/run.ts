import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { Report, StopReason, TaskSpec } from '../contracts/agents.js';
import type { ArmId, RunConfig, RunEvent } from '../contracts/events.js';
import type { FaultProfile } from '../contracts/faults.js';
import type { Db } from '../db/client.js';
import { readFaults } from '../db/fixtures.js';
import { getDependencyEdges, getIncident, getServices, getWorld } from '../db/queries.js';
import { promptHash } from '../agents/prompts.js';
import { buildFallbackReport, renderMarkdown, runReporting } from '../agents/reporting.js';
import type { Env } from '../config.js';
import type { JevClient } from '../llm/jev.js';
import type { LlmProvider } from '../llm/types.js';
import { orchestration } from '../orchestrations/registry.js';
import { FaultInjector } from '../tools/faults.js';
import { createToolContext } from '../tools/registry.js';
import { ToolRunner } from '../tools/runner.js';
import { AbortedError } from '../util/sleep.js';
import { Budget, BudgetExhaustedError, type BudgetLimits } from './budgets.js';
import { RunContext } from './context.js';
import { RunLog, type EventListener } from './events.js';
import { EvidenceLedger } from './ledger.js';
import type { DbRunStore } from './persistence.js';
import type { RunState } from './run-state.js';

export interface EngineSettings {
  maxRounds: number;
  maxToolCalls: number;
  maxLlmCalls: number;
  maxTokens: number;
  deadlineMs: number;
  specialistToolCalls: number;
  synthesisReserve: number;
  taskConcurrency: number;
  toolDeadlineMs: number;
  toolRetries: number;
  thinkingLevel: 'low' | 'medium' | 'high';
}

export function settingsFromEnv(env: Env): EngineSettings {
  return {
    maxRounds: env.ROOTLINE_MAX_ROUNDS,
    maxToolCalls: env.ROOTLINE_MAX_TOOL_CALLS,
    maxLlmCalls: env.ROOTLINE_MAX_LLM_CALLS,
    maxTokens: env.ROOTLINE_MAX_TOKENS,
    deadlineMs: env.ROOTLINE_DEADLINE_MS,
    specialistToolCalls: env.ROOTLINE_SPECIALIST_TOOL_CALLS,
    synthesisReserve: 4,
    taskConcurrency: env.ROOTLINE_TASK_CONCURRENCY,
    toolDeadlineMs: env.ROOTLINE_TOOL_DEADLINE_MS,
    toolRetries: env.ROOTLINE_TOOL_RETRIES,
    thinkingLevel: env.ROOTLINE_THINKING_LEVEL,
  };
}

export interface RunOptions {
  db: Db;
  worldId: string;
  arm: ArmId;
  armBase?: 'A' | 'B';
  llm: LlmProvider;
  jev?: JevClient | null;
  settings: EngineSettings;
  runId?: string;
  signal?: AbortSignal;
  onEvent?: EventListener;
  store?: DbRunStore | null;
  /** Override the world's fault profile (tests). */
  faults?: FaultProfile;
  /** Override tool backoff (tests). */
  toolBackoffMs?: number;
  fixtureHash?: string | null;
  /** Grace period for the final report after a deadline or budget stop. */
  reportGraceMs?: number;
}

export interface RunResult {
  runId: string;
  events: RunEvent[];
  state: RunState;
  report: Report;
}

let gitShaCache: string | null | undefined;
function gitSha(): string | null {
  if (gitShaCache !== undefined) return gitShaCache;
  try {
    gitShaCache = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    gitShaCache = null;
  }
  return gitShaCache;
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/** The single entry point for every arm (A-D) and the baseline (E). */
export async function runInvestigation(o: RunOptions): Promise<RunResult> {
  const world = await getWorld(o.db, o.worldId);
  const incident = await getIncident(o.db, o.worldId);
  if (!world || !incident) throw new Error(`world ${o.worldId} is not loaded`);
  const services = await getServices(o.db, o.worldId);
  const dependencies = await getDependencyEdges(o.db, o.worldId);
  const runId = o.runId ?? newRunId();
  const log = new RunLog(runId);
  const detachStore = o.store?.attach(log);
  if (o.onEvent) log.on(o.onEvent);

  const s = o.settings;
  const config: RunConfig = {
    arm: o.arm,
    armBase: o.arm === 'D' ? (o.armBase ?? 'A') : null,
    model: o.llm.model,
    jevModel: o.arm === 'D' && o.jev ? o.jev.model : null,
    thinkingLevel: s.thinkingLevel,
    budgets: {
      maxRounds: s.maxRounds,
      maxToolCalls: s.maxToolCalls,
      maxLlmCalls: s.maxLlmCalls,
      maxTokens: s.maxTokens,
      deadlineMs: s.deadlineMs,
      specialistToolCalls: s.specialistToolCalls,
      synthesisReserve: s.synthesisReserve,
      taskConcurrency: s.taskConcurrency,
      toolDeadlineMs: s.toolDeadlineMs,
      toolRetries: s.toolRetries,
    },
    promptHash: promptHash(),
    fixtureHash: o.fixtureHash ?? world.fixtureHash,
    gitSha: gitSha(),
  };

  const ledger = new EvidenceLedger();
  const toolCtx = await createToolContext(o.db, o.worldId);
  const runner = new ToolRunner(
    toolCtx,
    new FaultInjector(o.faults ?? readFaults(o.worldId)),
    ledger,
    { deadlineMs: s.toolDeadlineMs, maxRetries: s.toolRetries, backoffBaseMs: o.toolBackoffMs ?? 150 },
    {
      onAttempt: (a) => log.emit('tool.attempt', a, a.taskId),
      onEvidence: (ev) => log.emit('evidence.recorded', ev, ev.taskId),
    },
  );
  const exhaustedOnce = new Set<string>();
  const limits: BudgetLimits = { maxToolCalls: s.maxToolCalls, maxLlmCalls: s.maxLlmCalls, maxTokens: s.maxTokens, deadlineMs: s.deadlineMs, synthesisReserve: s.synthesisReserve };
  const budget = new Budget(limits, Date.now, (b, used, limit) => {
    if (exhaustedOnce.has(b)) return;
    exhaustedOnce.add(b);
    log.emit('budget.exhausted', { budget: b, used, limit });
  });

  // Run-level abort: external cancellation or the deadline.
  const ac = new AbortController();
  let cancelled = false;
  let deadlineHit = false;
  const onCancel = () => {
    cancelled = true;
    ac.abort();
  };
  if (o.signal?.aborted) onCancel();
  o.signal?.addEventListener('abort', onCancel, { once: true });
  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    budget.noteDeadline();
    if (!exhaustedOnce.has('deadline')) {
      exhaustedOnce.add('deadline');
      log.emit('budget.exhausted', { budget: 'deadline', used: s.deadlineMs, limit: s.deadlineMs });
    }
    ac.abort();
  }, s.deadlineMs);

  const ctx = new RunContext(runId, o.worldId, incident, services, dependencies, config, log, ledger, runner, budget, o.llm, o.jev ?? null, ac.signal);
  log.emit('run.created', { runId, worldId: o.worldId, incident, config, startedAt: Date.now() });

  const orch = orchestration(o.arm);
  let crashed: string | null = null;
  try {
    await orch.run(ctx);
  } catch (e) {
    if (e instanceof BudgetExhaustedError) ctx.stop(e.reason);
    else if (!(e instanceof AbortedError) && !ac.signal.aborted) {
      crashed = e instanceof Error ? e.message : String(e);
      ctx.stop('unrecoverable_error');
    }
  }
  clearTimeout(deadlineTimer);
  o.signal?.removeEventListener('abort', onCancel);
  if (cancelled) ctx.stopReason = 'cancelled';
  else if (deadlineHit) ctx.stop('deadline');
  const stopReason: StopReason = ctx.stopReason ?? 'completed';

  // Final report.
  let report = ctx.state().report;
  if (!report) {
    const reasoningFailed = Object.values(ctx.state().tasks).some((t) => t.role === 'reasoning' && t.status === 'failed');
    if (stopReason === 'cancelled') {
      report = buildFallbackReport(ctx.state(), stopReason, 'the run was cancelled');
      log.emit('report.ready', { report, markdown: renderMarkdown(report, ctx.state()) });
    } else if (orch.writesOwnReport) {
      // The baseline writes its own report; it never borrows the multi-agent reporting agent.
      report = buildFallbackReport(ctx.state(), stopReason, `the baseline agent did not submit a report${crashed ? ` (${crashed.slice(0, 200)})` : ''}`);
      log.emit('report.ready', { report, markdown: renderMarkdown(report, ctx.state()) });
    } else if (stopReason === 'unrecoverable_error' && reasoningFailed) {
      // Brief §6: reasoning failed twice -> outcome failed, partial report built from the ledger by code.
      report = buildFallbackReport(ctx.state(), stopReason, 'the reasoning agent failed twice', true);
      log.emit('report.ready', { report, markdown: renderMarkdown(report, ctx.state()) });
    } else {
      const reportTask: TaskSpec = { id: ctx.nextTaskId(), role: 'reporting', question: 'Write the final investigation report', scope: null, dependsOn: [], round: 0, origin: 'system', rationale: null, discriminates: [], requestedCall: null };
      log.emit('task.scheduled', reportTask, reportTask.id);
      log.emit('task.started', { role: 'reporting', attempt: 1 }, reportTask.id);
      const grace = AbortSignal.timeout(o.reportGraceMs ?? 120_000);
      try {
        report = await runReporting(ctx, reportTask, grace);
        log.emit('task.completed', { role: 'reporting', summary: `${report.outcome}: ${report.rootCauseStatement.slice(0, 300)}`, hadGaps: report.gaps.length > 0 }, reportTask.id);
      } catch (e) {
        const why = `the reporting agent failed (${e instanceof Error ? e.message.slice(0, 200) : String(e)})${crashed ? `; the run had crashed: ${crashed.slice(0, 200)}` : ''}`;
        log.emit('task.failed', { role: 'reporting', error: why, gap: 'no agent-written report' }, reportTask.id);
        report = buildFallbackReport(ctx.state(), stopReason, why);
        log.emit('report.ready', { report, markdown: renderMarkdown(report, ctx.state()) });
      }
    }
  }
  const status = stopReason === 'cancelled' ? 'cancelled' : report.generatedBy === 'code_fallback' || stopReason === 'unrecoverable_error' ? 'failed' : 'completed';
  log.emit('run.terminated', { status, stopReason, outcome: report.outcome, endedAt: Date.now() });
  if (o.store) await o.store.flush();
  detachStore?.();
  return { runId, events: log.events, state: ctx.state(), report };
}
