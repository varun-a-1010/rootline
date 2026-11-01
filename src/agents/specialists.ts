import { Findings, type Observation, type TaskSpec } from '../contracts/agents.js';
import { checkCitations } from '../engine/citations.js';
import type { RunContext } from '../engine/context.js';
import { ROLE_TOOLS } from '../tools/registry.js';
import { systemPrompt } from './prompts.js';
import { renderBudget, renderCatalog, renderDependencies, renderIncident } from './render.js';
import { runToolLoop } from './specialist-loop.js';

/** Follow-up tasks get a smaller loop: the critic's call is run first, then a few more. */
export const FOLLOWUP_TOOL_CALLS = 3;

/**
 * Run one observability or dependency task: (for follow-ups) execute the critic's requested
 * call, then the role's bounded tool loop ending in submit_findings. Citations are checked
 * against the ledger; unknown ids are reported and removed.
 */
export async function runSpecialist(ctx: RunContext, task: TaskSpec): Promise<{ hadGaps: boolean; summary: string }> {
  const role = task.role as 'observability' | 'dependency';
  let requested = '';
  if (task.requestedCall) {
    const r = await ctx.callTool(task, role, task.requestedCall.tool, task.requestedCall.params, 'critic');
    requested = `\n\nThe critic requested this check, and it has been run for you:\n${task.requestedCall.tool} ${JSON.stringify(r.canonical)}\nResult: ${JSON.stringify(r.modelView)}`;
  }
  const maxToolCalls = task.origin === 'followup' ? FOLLOWUP_TOOL_CALLS : ctx.config.budgets.specialistToolCalls;
  const userText = [
    renderIncident(ctx.incident),
    '',
    `Your task ${task.id} (${role}, round ${task.round}): ${task.question}`,
    task.scope ? `Scope: services ${task.scope.services.join(', ')}; window ${task.scope.from} to ${task.scope.to}.` : '',
    task.rationale ? `Why it matters: ${task.rationale}` : '',
    requested,
    '',
    `You may make up to ${maxToolCalls} tool calls in this task. ${renderBudget(ctx)}`,
    '',
    'Service catalog:',
    renderCatalog(ctx.services),
    ...(role === 'dependency' ? ['', 'Dependency graph:', renderDependencies(ctx.dependencies)] : []),
  ].join('\n');

  const res = await runToolLoop(ctx, {
    task,
    agent: role,
    system: systemPrompt(role),
    userText,
    tools: ROLE_TOOLS[role],
    terminal: { name: 'submit_findings', description: 'Submit your findings for this task (ends the task).', schema: Findings },
    maxToolCalls,
    kind: 'specialist',
    finalKind: 'specialist',
  });

  let findings: Findings;
  if (res.output) {
    findings = sanitizeFindings(ctx, task, res.output);
  } else if (res.outOfBudget) {
    // Honest code-built findings: the evidence is in the ledger; nothing is claimed.
    const evidence = Object.values(ctx.state().evidence).filter((e) => e.taskId === task.id).map((e) => e.evidenceId);
    findings = {
      summary: `No findings submitted: ${res.failure}. Evidence gathered by this task: ${evidence.join(', ') || 'none'}.`,
      observations: [],
      gaps: [{ description: res.failure ?? 'budget exhausted', cause: 'out_of_budget' }],
      suggestedNextQueries: [],
    };
  } else {
    throw new Error(res.failure ?? 'specialist failed');
  }
  ctx.log.emit('specialist.findings', { role, findings }, task.id);
  ctx.log.emit('agent.output', { role, kind: 'findings', output: findings }, task.id);
  const partial = Object.values(ctx.state().evidence).some((e) => e.taskId === task.id && e.completeness !== 'complete');
  return { hadGaps: findings.gaps.length > 0 || partial, summary: findings.summary };
}

function sanitizeFindings(ctx: RunContext, task: TaskSpec, f: Findings): Findings {
  const observations: Observation[] = f.observations.map((o) => {
    const { valid, invalid } = checkCitations(o.evidenceIds, ctx.ledger);
    for (const id of invalid) ctx.log.emit('citation.invalid', { agent: task.role, evidenceId: id, context: `observation: ${o.statement.slice(0, 160)}` }, task.id);
    if (o.kind === 'fact' && valid.length === 0) {
      ctx.log.emit('citation.invalid', { agent: task.role, evidenceId: '', context: `fact without evidence (downgraded to inference): ${o.statement.slice(0, 160)}` }, task.id);
      return { ...o, kind: 'inference', evidenceIds: [] };
    }
    return { ...o, evidenceIds: valid };
  });
  return { ...f, observations };
}
