import { ReportBody, type TaskSpec } from '../contracts/agents.js';
import { systemPrompt } from '../agents/prompts.js';
import { buildFallbackReport, finalizeReport, renderMarkdown } from '../agents/reporting.js';
import { renderBudget, renderCatalog, renderDependencies, renderIncident } from '../agents/render.js';
import { runToolLoop } from '../agents/specialist-loop.js';
import type { RunContext } from '../engine/context.js';
import type { Orchestration } from '../orchestrations/registry.js';
import { ROLE_TOOLS } from '../tools/registry.js';

/**
 * E. Single-agent baseline: one agent with all five tools, one tool loop, the same objective
 * text, report schema, budgets, tool runner, ledger and fault injection as the multi-agent
 * arms. It is not one-shot: it iterates until it submits or runs out of budget. It runs
 * sequentially (one model turn at a time), unlike the multi-agent arms.
 */
export const singleAgent: Orchestration = {
  id: 'E',
  title: 'Single-agent baseline',
  description: 'One agent with all five tools and the same objective, budgets and report schema; iterates sequentially, then submits the report.',
  writesOwnReport: true,
  async run(ctx: RunContext) {
    const task: TaskSpec = {
      id: ctx.nextTaskId(),
      role: 'baseline',
      question: 'Investigate the incident and submit the final report',
      scope: { services: ctx.incident.suspectedServices, from: ctx.incident.window.from, to: ctx.incident.window.to },
      dependsOn: [],
      round: 0,
      origin: 'system',
      rationale: null,
      discriminates: [],
      requestedCall: null,
    };
    ctx.log.emit('task.scheduled', task, task.id);
    ctx.log.emit('task.started', { role: 'baseline', attempt: 1 }, task.id);
    const userText = [
      renderIncident(ctx.incident),
      '',
      renderBudget(ctx),
      '',
      'Service catalog:',
      renderCatalog(ctx.services),
      '',
      'Dependency graph:',
      renderDependencies(ctx.dependencies),
      '',
      'Investigate, then call submit_report.',
    ].join('\n');
    let res;
    try {
      res = await runToolLoop(ctx, {
        task,
        agent: 'baseline',
        system: systemPrompt('baseline'),
        userText,
        tools: ROLE_TOOLS.baseline,
        terminal: { name: 'submit_report', description: 'Submit the final investigation report (ends the investigation).', schema: ReportBody },
        maxToolCalls: ctx.config.budgets.maxToolCalls,
        kind: 'synthesis',
        finalKind: 'report',
        finalNotice:
          'Your budget or time is used up. Call submit_report now with what you have. List what you could not check as gaps. If you still report conclusive, explain in justification why the evidence suffices.',
        deadlineGraceMs: 120_000,
      });
    } catch (e) {
      ctx.log.emit('task.failed', { role: 'baseline', error: e instanceof Error ? e.message : String(e), gap: 'baseline agent failed' }, task.id);
      throw e;
    }
    const stopReason = ctx.budget.exhausted ?? (res.output ? 'completed' : 'unrecoverable_error');
    ctx.stop(stopReason);
    if (res.output) {
      ctx.log.emit('agent.output', { role: 'baseline', kind: 'report', output: res.output }, task.id);
      const report = finalizeReport(ctx, task.id, ctx.state(), res.output, stopReason, 'baseline_agent');
      ctx.log.emit('report.ready', { report, markdown: renderMarkdown(report, ctx.state()) }, task.id);
      ctx.log.emit('task.completed', { role: 'baseline', summary: `${report.outcome}: ${report.rootCauseStatement.slice(0, 300)}`, hadGaps: report.gaps.length > 0 }, task.id);
    } else {
      ctx.log.emit('task.failed', { role: 'baseline', error: res.failure ?? 'no report', gap: 'no report submitted' }, task.id);
      const report = buildFallbackReport(ctx.state(), stopReason, `the baseline agent did not submit a report (${res.failure ?? 'unknown'})`);
      ctx.log.emit('report.ready', { report, markdown: renderMarkdown(report, ctx.state()) }, task.id);
    }
  },
};
