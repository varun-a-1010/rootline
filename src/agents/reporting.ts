import { ReportBody, type Report, type StopReason, type TaskSpec } from '../contracts/agents.js';
import { checkCitations } from '../engine/citations.js';
import type { RunContext } from '../engine/context.js';
import type { EvidenceLedger } from '../engine/ledger.js';
import { latestHypotheses, type RunState } from '../engine/run-state.js';
import { prompt } from './prompts.js';
import { istLabel, renderHypotheses, renderSharedContext, renderToolFailures } from './render.js';

const BUDGET_STOPS: StopReason[] = ['budget_tool_calls', 'budget_llm_calls', 'budget_tokens', 'deadline', 'max_rounds', 'no_new_evidence', 'unrecoverable_error'];

export async function runReporting(ctx: RunContext, task: TaskSpec, signal: AbortSignal): Promise<Report> {
  const s = ctx.state();
  const stopReason = ctx.stopReason ?? 'completed';
  const lastCritic = s.criticDecisions[s.criticDecisions.length - 1];
  const text = [
    renderSharedContext(ctx, s),
    '',
    `The investigation stopped: ${stopReason}.${lastCritic ? ` Last critic decision (round ${lastCritic.round}): ${lastCritic.decision} — ${lastCritic.rationale}` : ' No critic reviewed this investigation.'}`,
    ...(lastCritic ? lastCritic.objections.map((o) => `- open objection to ${o.hypothesisId} (${o.type}): ${o.detail}`) : []),
    '',
    'Final hypotheses:',
    renderHypotheses(latestHypotheses(s)),
    '',
    'Tool calls that failed (gaps):',
    renderToolFailures(s),
    '',
    prompt('reporting'),
    '',
    'Write the final report.',
  ].join('\n');
  const body = await ctx.structured(task.id, 'report', { role: 'reporting', system: prompt('objective'), contents: [{ role: 'user', parts: [{ text }] }] }, ReportBody, signal);
  ctx.log.emit('agent.output', { role: 'reporting', kind: 'report', output: body }, task.id);
  const report = finalizeReport(ctx, task.id, s, body, stopReason, 'reporting_agent');
  ctx.log.emit('report.ready', { report, markdown: renderMarkdown(report, s) }, task.id);
  return report;
}

/**
 * Code-enforced report hygiene, shared by every arm and the baseline: citation validation,
 * uncited "facts" moved to assumptions, the honesty rule, tool failures and the stop reason.
 */
export function finalizeReport(
  ctx: { ledger: EvidenceLedger; log: RunContext['log'] },
  taskId: string | null,
  s: RunState,
  body: ReportBody,
  stopReason: StopReason,
  generatedBy: Report['generatedBy'],
): Report {
  const ungrounded: string[] = [];
  const clean = (ids: string[], context: string) => {
    const { valid, invalid } = checkCitations(ids, ctx.ledger);
    for (const id of invalid) {
      ungrounded.push(id);
      ctx.log.emit('citation.invalid', { agent: generatedBy === 'baseline_agent' ? 'baseline' : 'reporting', evidenceId: id, context }, taskId);
    }
    return valid;
  };
  const hypotheses = body.hypotheses.map((h) => ({
    ...h,
    supportingEvidence: clean(h.supportingEvidence, `report hypothesis ${h.id}`),
    contradictingEvidence: clean(h.contradictingEvidence, `report hypothesis ${h.id}`),
  }));
  const assumptions = [...body.assumptions];
  const facts: Report['facts'] = [];
  for (const f of body.facts) {
    const valid = clean(f.evidenceIds, `fact: ${f.statement.slice(0, 120)}`);
    if (valid.length === 0) {
      ctx.log.emit('citation.invalid', { agent: generatedBy === 'baseline_agent' ? 'baseline' : 'reporting', evidenceId: '', context: `fact without evidence moved to assumptions: ${f.statement.slice(0, 120)}` }, taskId);
      assumptions.push({ statement: `${f.statement} (stated as a fact without valid evidence)` });
    } else facts.push({ ...f, evidenceIds: valid });
  }
  const inferences = body.inferences.map((x) => ({ ...x, evidenceIds: clean(x.evidenceIds, `inference: ${x.statement.slice(0, 120)}`) }));
  const timeline = body.timeline.map((x) => ({ ...x, evidenceIds: clean(x.evidenceIds, `timeline: ${x.event.slice(0, 120)}`) }));
  const recommendedActions = body.recommendedActions.map((x) => ({ ...x, evidenceIds: clean(x.evidenceIds, `action: ${x.action.slice(0, 120)}`) }));

  // Honesty rule.
  const lastCritic = s.criticDecisions[s.criticDecisions.length - 1];
  const criticAccepted = lastCritic ? lastCritic.decision === 'accept' : null;
  const insufficient = lastCritic?.decision === 'insufficient_evidence';
  const unaccepted = BUDGET_STOPS.includes(stopReason) && criticAccepted !== true;
  let outcome: Report['outcome'] = body.outcome;
  let downgraded = false;
  let inconsistencyFlag = false;
  let note = 'consistent';
  if (body.outcome === 'conclusive' && (insufficient || unaccepted)) {
    if (body.justification.trim().length >= 20) {
      inconsistencyFlag = true;
      note = `reported conclusive although ${insufficient ? 'the critic found the evidence insufficient' : `the run stopped (${stopReason}) without critic acceptance`}; the report gives a justification`;
    } else {
      outcome = 'inconclusive';
      downgraded = true;
      inconsistencyFlag = true;
      note = `downgraded from conclusive to inconclusive: ${insufficient ? 'the critic found the evidence insufficient' : `the run stopped (${stopReason}) without critic acceptance`} and no justification was given`;
    }
  }

  const toolFailures = s.toolResults
    .filter((r) => r.status === 'error')
    .map((r) => ({ tool: r.tool, request: JSON.stringify(r.canonical), error: `${r.error?.code}: ${r.error?.message ?? ''}`, attempts: r.attempts }));
  const cited = new Set<string>();
  for (const list of [...hypotheses.flatMap((h) => [h.supportingEvidence, h.contradictingEvidence]), ...facts.map((f) => f.evidenceIds), ...inferences.map((f) => f.evidenceIds), ...timeline.map((t) => t.evidenceIds), ...recommendedActions.map((a) => a.evidenceIds)]) {
    for (const id of list) cited.add(id);
  }
  return {
    ...body,
    outcome,
    hypotheses,
    facts,
    inferences,
    assumptions,
    timeline,
    recommendedActions,
    stopReason,
    toolFailures,
    citedEvidence: [...cited].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))),
    honesty: { criticAccepted, downgraded, inconsistencyFlag, note },
    ungroundedCitations: ungrounded,
    generatedBy,
  };
}

/** A clearly labeled report built by code from the ledger, when no agent could write one. */
export function buildFallbackReport(s: RunState, stopReason: StopReason, why: string, forceFailed = false): Report {
  const hs = latestHypotheses(s);
  const toolFailures = s.toolResults.filter((r) => r.status === 'error').map((r) => ({ tool: r.tool, request: JSON.stringify(r.canonical), error: `${r.error?.code}: ${r.error?.message ?? ''}`, attempts: r.attempts }));
  return {
    outcome: forceFailed || hs.length === 0 ? 'failed' : 'inconclusive',
    incidentSummary: s.incident ? `${s.incident.title}: ${s.incident.summary}` : 'unknown incident',
    rootCauseStatement: `Not determined. This report was generated by code from the evidence ledger because ${why}.`,
    hypotheses: hs.map((h) => ({ rank: h.rank, id: h.id, cause: h.cause, component: h.component, causeType: h.causeType, confidence: h.confidence, status: 'unresolved' as const, supportingEvidence: h.supportingEvidence, contradictingEvidence: h.contradictingEvidence, rationale: h.confidenceRationale })),
    facts: [],
    inferences: [],
    assumptions: [],
    timeline: [],
    confidence: { overall: 0, rationale: 'No agent-written report; hypotheses (if any) are listed as unresolved.' },
    gaps: [{ description: `Report generation failed: ${why}`, impact: 'Findings are incomplete and unverified.' }],
    recommendedActions: [],
    justification: '',
    stopReason,
    toolFailures,
    citedEvidence: [...new Set(hs.flatMap((h) => [...h.supportingEvidence, ...h.contradictingEvidence]))],
    honesty: { criticAccepted: null, downgraded: false, inconsistencyFlag: false, note: 'code-built fallback report' },
    ungroundedCitations: [],
    generatedBy: 'code_fallback',
  };
}

export function renderMarkdown(r: Report, s: RunState): string {
  const cite = (ids: string[]) => (ids.length ? ` [${ids.join(', ')}]` : '');
  const lines: string[] = [];
  lines.push(`# Investigation report: ${s.incident?.title ?? ''}`);
  lines.push('');
  lines.push(`**Outcome:** ${r.outcome} · **Stop reason:** ${r.stopReason} · **Confidence:** ${r.confidence.overall.toFixed(2)} · **Written by:** ${r.generatedBy.replace('_', ' ')}`);
  if (r.honesty.inconsistencyFlag || r.honesty.downgraded) lines.push(`> Honesty check: ${r.honesty.note}`);
  lines.push('', '## Summary', r.incidentSummary, '', `**Root cause:** ${r.rootCauseStatement}`);
  lines.push('', '## Hypotheses');
  for (const h of r.hypotheses) {
    lines.push(`${h.rank}. **${h.cause}** — \`${h.component}\`, ${h.causeType}, confidence ${h.confidence.toFixed(2)}, ${h.status}`);
    lines.push(`   - Supporting:${cite(h.supportingEvidence) || ' none'} · Contradicting:${cite(h.contradictingEvidence) || ' none'}`);
    lines.push(`   - ${h.rationale}`);
  }
  if (r.facts.length) lines.push('', '## Facts', ...r.facts.map((f) => `- ${f.statement}${cite(f.evidenceIds)}`));
  if (r.inferences.length) lines.push('', '## Inferences', ...r.inferences.map((f) => `- ${f.statement}${cite(f.evidenceIds)}`));
  if (r.assumptions.length) lines.push('', '## Assumptions', ...r.assumptions.map((f) => `- ${f.statement}`));
  if (r.timeline.length) lines.push('', '## Timeline', ...r.timeline.map((t) => `- **${t.time}** ${t.event}${cite(t.evidenceIds)}`));
  lines.push('', '## Confidence', `${r.confidence.overall.toFixed(2)}: ${r.confidence.rationale}`);
  if (r.gaps.length) lines.push('', '## Gaps', ...r.gaps.map((g) => `- ${g.description} (impact: ${g.impact})`));
  if (r.toolFailures.length) lines.push('', '## Tool failures', ...r.toolFailures.map((t) => `- ${t.tool} ${t.request}: ${t.error} (${t.attempts} attempts)`));
  if (r.recommendedActions.length) {
    lines.push('', '## Recommended actions (not executed)');
    for (const a of r.recommendedActions) lines.push(`- **[${a.priority}]** ${a.action}${cite(a.evidenceIds)}`, `  - Why: ${a.rationale}`, `  - Verify: ${a.verification}`);
  }
  if (r.justification) lines.push('', '## Justification', r.justification);
  lines.push('', `Cited evidence: ${r.citedEvidence.join(', ') || 'none'}`);
  if (s.incident) lines.push(`Investigation window: ${istLabel(s.incident.window.from)} to ${istLabel(s.incident.window.to)}`);
  return lines.join('\n');
}
