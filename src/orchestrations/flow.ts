import type { CandidatesOutput, TaskSpec } from '../contracts/agents.js';
import { runCritic, type CriticExtras } from '../agents/critic.js';
import { planInvestigation, validateFollowUps } from '../agents/orchestrator.js';
import { proposeCandidates, runReasoning, type ReasoningExtras } from '../agents/reasoning.js';
import { runSpecialist } from '../agents/specialists.js';
import { BudgetExhaustedError, type RunContext } from '../engine/context.js';
import { Scheduler, type TaskOutcome } from '../engine/scheduler.js';
import { AbortedError } from '../util/sleep.js';

export interface FlowOptions {
  /** Arm B: the reasoning agent proposes candidate causes before any tool call. */
  candidatesFirst: boolean;
  /** Arm C turns the critic (and therefore follow-up rounds) off. */
  critic: boolean;
  reasoningExtras?: ReasoningExtras;
  criticExtras?: CriticExtras;
  /** Arm D: work between reasoning and the critic (Jev grid and citation check). */
  afterReasoning?: (ctx: RunContext, reasoningTask: TaskSpec) => Promise<void>;
}

const MAX_ATTEMPTS: Partial<Record<TaskSpec['role'], number>> = { reasoning: 2 };

/** Run a task's handler with task events, bounded retries and failure containment. */
export async function execTask(ctx: RunContext, spec: TaskSpec, handler: () => Promise<{ summary: string; hadGaps: boolean }>): Promise<TaskOutcome> {
  const max = MAX_ATTEMPTS[spec.role] ?? 1;
  for (let attempt = 1; attempt <= max; attempt++) {
    ctx.log.emit('task.started', { role: spec.role, attempt }, spec.id);
    try {
      const r = await handler();
      ctx.log.emit('task.completed', { role: spec.role, summary: r.summary.slice(0, 500), hadGaps: r.hadGaps }, spec.id);
      return 'completed';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof BudgetExhaustedError) ctx.stop(e.reason);
      const fatal = e instanceof AbortedError || ctx.signal.aborted || e instanceof BudgetExhaustedError;
      if (!fatal && attempt < max) continue;
      ctx.log.emit('task.failed', { role: spec.role, error: msg.slice(0, 500), gap: `${spec.role} task ${spec.id} failed: ${msg.slice(0, 200)}` }, spec.id);
      return 'failed';
    }
  }
  return 'failed';
}

function schedule(ctx: RunContext, sched: Scheduler, spec: TaskSpec): TaskSpec {
  ctx.log.emit('task.scheduled', spec, spec.id);
  sched.add(spec);
  return spec;
}

function system(ctx: RunContext, role: TaskSpec['role'], question: string, round: number, dependsOn: string[]): TaskSpec {
  return { id: ctx.nextTaskId(), role, question, scope: null, dependsOn, round, origin: 'system', rationale: null, discriminates: [], requestedCall: null };
}

/**
 * The multi-agent flow (arms A-D):
 *   [candidates] -> plan -> specialists (parallel) -> reasoning -> critic
 *   -> [critic says investigate: follow-up specialists (parallel) -> reasoning -> critic]*
 * Termination is decided in code with a typed stop reason. Reporting happens in run.ts.
 */
export async function runFlow(ctx: RunContext, opts: FlowOptions): Promise<void> {
  const handlers = new Map<string, () => Promise<{ summary: string; hadGaps: boolean }>>();
  const sched = new Scheduler(ctx.config.budgets.taskConcurrency, (spec) => execTask(ctx, spec, handlers.get(spec.id)!), ctx.signal);
  const add = (spec: TaskSpec, h: () => Promise<{ summary: string; hadGaps: boolean }>) => {
    handlers.set(spec.id, h);
    return schedule(ctx, sched, spec);
  };

  let candidates: CandidatesOutput | null = null;
  const before: string[] = [];
  if (opts.candidatesFirst) {
    const c = add(system(ctx, 'candidates', 'Propose candidate causes before any evidence', 0, []), async () => {
      candidates = await proposeCandidates(ctx, c);
      return { summary: candidates.candidates.map((x) => `${x.id}: ${x.cause}`).join(' | '), hadGaps: false };
    });
    await sched.runUntilIdle();
    before.push(c.id);
    if (!candidates) {
      if (ctx.signal.aborted || ctx.stopReason) return;
    }
  }

  let specialists: TaskSpec[] = [];
  const plan = add(system(ctx, 'orchestrator', 'Plan the investigation', 0, before), async () => {
    specialists = await planInvestigation(ctx, plan, candidates, () => ctx.nextTaskId());
    return { summary: `${specialists.length} tasks planned`, hadGaps: false };
  });
  await sched.runUntilIdle();
  if (ctx.signal.aborted) return;
  if (sched.outcome(plan.id) !== 'completed') {
    ctx.stop('unrecoverable_error');
    return;
  }

  const maxRounds = ctx.config.budgets.maxRounds;
  for (let round = 0; ; round++) {
    for (const s of specialists) {
      add(s, async () => runSpecialist(ctx, s));
    }
    const reasoning = add(system(ctx, 'reasoning', `Develop and rank hypotheses (round ${round})`, round, specialists.map((s) => s.id)), async () => {
      const hs = await runReasoning(ctx, reasoning, opts.reasoningExtras);
      if (opts.afterReasoning) await opts.afterReasoning(ctx, reasoning);
      return { summary: hs.map((h) => `${h.id} ${h.component}/${h.causeType} ${h.confidence}`).join(' | '), hadGaps: false };
    });
    let critic: TaskSpec | null = null;
    if (opts.critic) {
      critic = add(system(ctx, 'critic', `Challenge the hypotheses (round ${round})`, round, [reasoning.id]), async () => {
        const d = await runCritic(ctx, critic!, opts.criticExtras);
        return { summary: `${d.decision}: ${d.rationale}`, hadGaps: d.decision !== 'accept' };
      });
    }
    await sched.runUntilIdle();
    if (ctx.signal.aborted) return;
    if (sched.outcome(reasoning.id) !== 'completed') {
      ctx.stop(ctx.budget.exhausted ?? 'unrecoverable_error');
      return;
    }
    if (ctx.budget.exhausted) {
      ctx.stop(ctx.budget.exhausted);
      return;
    }
    if (!critic) {
      ctx.stop('completed');
      return;
    }
    if (sched.outcome(critic.id) !== 'completed') {
      ctx.stop(ctx.budget.exhausted ?? 'unrecoverable_error');
      return;
    }
    const s = ctx.state();
    const decision = s.criticDecisions[s.criticDecisions.length - 1]!;
    if (decision.decision === 'accept') return ctx.stop('critic_accepted');
    if (decision.decision === 'insufficient_evidence') return ctx.stop('critic_insufficient_evidence');
    if (round + 1 >= maxRounds) return ctx.stop('max_rounds');
    specialists = validateFollowUps(ctx, decision.followUps, round + 1, critic.id, () => ctx.nextTaskId());
    if (specialists.length === 0) return ctx.stop('no_new_evidence');
  }
}
