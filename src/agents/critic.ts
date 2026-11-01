import { CriticOutput, type TaskSpec } from '../contracts/agents.js';
import { checkCitations } from '../engine/citations.js';
import type { RunContext } from '../engine/context.js';
import { latestHypotheses } from '../engine/run-state.js';
import { criticChecks } from './critic-checks.js';
import { systemPrompt } from './prompts.js';
import { renderBudget, renderHypotheses, renderIncident, renderLedger, renderToolFailures } from './render.js';

export type CriticExtras = (ctx: RunContext) => string;

/** Critic: deterministic checks first, then the model's decision. */
export async function runCritic(ctx: RunContext, task: TaskSpec, extras?: CriticExtras): Promise<CriticOutput> {
  const s = ctx.state();
  const hypotheses = latestHypotheses(s);
  const checks = criticChecks(s, hypotheses);
  ctx.log.emit('critic.checks', { round: task.round, checks }, task.id);
  const maxRounds = ctx.config.budgets.maxRounds;
  const lastRound = task.round + 1 >= maxRounds;
  const executed = s.toolResults.map((r) => `- ${r.tool} ${JSON.stringify(r.canonical)} -> ${r.status}${r.evidenceId ? ` (${r.evidenceId})` : ''}`);
  const text = [
    renderIncident(ctx.incident),
    '',
    `Critique round ${task.round + 1} of at most ${maxRounds}.${lastRound ? ' This is the last round: follow-ups will not run, so decide between accept and insufficient_evidence.' : ''} ${renderBudget(ctx)}`,
    '',
    'Current hypotheses:',
    renderHypotheses(hypotheses),
    '',
    'Code checks:',
    ...checks.map((c) => `- ${c.check}: ${c.status.toUpperCase()} — ${c.detail}`),
    ...(extras ? ['', extras(ctx)] : []),
    '',
    'Tool calls that failed:',
    renderToolFailures(s),
    '',
    'Queries already executed (do not repeat them):',
    executed.join('\n') || '(none)',
    '',
    'Evidence ledger:',
    renderLedger(Object.values(s.evidence)),
    '',
    'Decide.',
  ].join('\n');
  const out = await ctx.structured(task.id, 'synthesis', { role: 'critic', system: systemPrompt('critic'), contents: [{ role: 'user', parts: [{ text }] }] }, CriticOutput);
  const objections = out.objections.map((o) => {
    const { valid, invalid } = checkCitations(o.evidenceIds, ctx.ledger);
    for (const id of invalid) ctx.log.emit('citation.invalid', { agent: 'critic', evidenceId: id, context: `objection to ${o.hypothesisId}` }, task.id);
    return { ...o, evidenceIds: valid };
  });
  const decided = { ...out, objections };
  ctx.log.emit('agent.output', { role: 'critic', kind: 'critic', output: decided }, task.id);
  ctx.log.emit('critic.decided', { ...decided, round: task.round }, task.id);
  return decided;
}
