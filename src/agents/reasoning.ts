import { CandidatesOutput, ReasoningOutput, type Hypothesis, type TaskSpec } from '../contracts/agents.js';
import { checkCitations } from '../engine/citations.js';
import type { RunContext } from '../engine/context.js';
import { latestHypotheses } from '../engine/run-state.js';
import { prompt, systemPrompt } from './prompts.js';
import { renderBudget, renderCatalog, renderDependencies, renderHypotheses, renderIncident, renderSharedContext, renderToolFailures } from './render.js';

/** Arm B: candidate causes from the report and catalog alone, before any tool call. */
export async function proposeCandidates(ctx: RunContext, task: TaskSpec): Promise<CandidatesOutput> {
  const out = await ctx.structured(
    task.id,
    'synthesis',
    {
      role: 'reasoning',
      system: systemPrompt('candidates'),
      contents: [{ role: 'user', parts: [{ text: [renderIncident(ctx.incident), '', 'Service catalog:', renderCatalog(ctx.services), '', 'Dependency graph:', renderDependencies(ctx.dependencies), '', 'Propose 3 or 4 candidate causes.'].join('\n') }] }],
    },
    CandidatesOutput,
  );
  ctx.log.emit('candidates.proposed', out, task.id);
  ctx.log.emit('agent.output', { role: 'reasoning', kind: 'candidates', output: out }, task.id);
  return out;
}

/** Extra context some arms add (arm D: Jev's evidence-vs-hypothesis grid). */
export type ReasoningExtras = (ctx: RunContext) => string;

export async function runReasoning(ctx: RunContext, task: TaskSpec, extras?: ReasoningExtras): Promise<Hypothesis[]> {
  const s = ctx.state();
  const previous = latestHypotheses(s);
  const lastCritic = s.criticDecisions[s.criticDecisions.length - 1];
  const candidates = s.candidates;
  const text = [
    renderSharedContext(ctx, s),
    '',
    `Reasoning round ${task.round}. ${renderBudget(ctx)}`,
    ...(candidates && previous.length === 0
      ? ['', 'Candidate causes proposed before any evidence (you may drop any or all of them and add new ones):', ...candidates.candidates.map((c) => `- ${c.id}: ${c.cause} [${c.component}, ${c.causeType}]`)]
      : []),
    '',
    'Previous hypotheses:',
    renderHypotheses(previous),
    ...(lastCritic
      ? ['', `Critic (round ${lastCritic.round}) decided ${lastCritic.decision}: ${lastCritic.rationale}`, ...lastCritic.objections.map((o) => `- objection to ${o.hypothesisId} (${o.type}): ${o.detail}`)]
      : []),
    '',
    'Tool calls that failed (gaps, not evidence):',
    renderToolFailures(s),
    ...(extras ? ['', extras(ctx)] : []),
    '',
    prompt('reasoning'),
    '',
    'Produce the ranked hypotheses.',
  ].join('\n');
  const out = await ctx.structured(task.id, 'synthesis', { role: 'reasoning', system: prompt('objective'), contents: [{ role: 'user', parts: [{ text }] }] }, ReasoningOutput);
  if (out.hypotheses.length === 0) throw new Error('reasoning returned no hypotheses');
  const hypotheses = out.hypotheses
    .map((h) => sanitizeHypothesis(ctx, task, h))
    .sort((a, b) => a.rank - b.rank || b.confidence - a.confidence)
    .map((h, i) => ({ ...h, rank: i + 1 }));
  const keyFacts = out.keyFacts.map((f) => {
    const { valid, invalid } = checkCitations(f.evidenceIds, ctx.ledger);
    for (const id of invalid) ctx.log.emit('citation.invalid', { agent: 'reasoning', evidenceId: id, context: `key fact: ${f.statement.slice(0, 160)}` }, task.id);
    return { ...f, evidenceIds: valid };
  });
  ctx.log.emit('agent.output', { role: 'reasoning', kind: 'reasoning', output: { ...out, hypotheses, keyFacts } }, task.id);
  ctx.log.emit('hypotheses.updated', { version: s.hypothesisVersions.length + 1, round: task.round, hypotheses, dropped: out.dropped }, task.id);
  return hypotheses;
}

function sanitizeHypothesis(ctx: RunContext, task: TaskSpec, h: Hypothesis): Hypothesis {
  const sup = checkCitations(h.supportingEvidence, ctx.ledger);
  const con = checkCitations(h.contradictingEvidence, ctx.ledger);
  for (const id of [...sup.invalid, ...con.invalid]) ctx.log.emit('citation.invalid', { agent: 'reasoning', evidenceId: id, context: `hypothesis ${h.id}: ${h.cause.slice(0, 120)}` }, task.id);
  return { ...h, supportingEvidence: sup.valid, contradictingEvidence: con.valid.filter((x) => !sup.valid.includes(x)) };
}
