import { PlanOutput, type CandidatesOutput, type FollowUpRequest, type TaskSpec } from '../contracts/agents.js';
import type { RunContext } from '../engine/context.js';
import type { Content } from '../llm/types.js';
import { LlmError } from '../llm/types.js';
import { ROLE_TOOLS } from '../tools/registry.js';
import { systemPrompt } from './prompts.js';
import { renderBudget, renderCatalog, renderDependencies, renderIncident } from './render.js';

const HOUR = 3_600_000;
export const MAX_FOLLOWUPS_PER_ROUND = 4;

/** Hybrid orchestrator: the model plans, code validates (one repair, then a default plan). */
export async function planInvestigation(ctx: RunContext, planTask: TaskSpec, candidates: CandidatesOutput | null, nextId: () => string): Promise<TaskSpec[]> {
  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: [
            renderIncident(ctx.incident),
            '',
            renderBudget(ctx),
            `Each specialist task may make up to ${ctx.config.budgets.specialistToolCalls} tool calls.`,
            ...(candidates
              ? ['', 'Candidate causes to discriminate between (proposed before any evidence):', ...candidates.candidates.map((c) => `- ${c.id}: ${c.cause} [${c.component}, ${c.causeType}] confirm: ${c.wouldConfirm} | rule out: ${c.wouldRuleOut}`)]
              : []),
            '',
            'Service catalog:',
            renderCatalog(ctx.services),
            '',
            'Dependency graph:',
            renderDependencies(ctx.dependencies),
            '',
            'Plan the investigation tasks.',
          ].join('\n'),
        },
      ],
    },
  ];
  let reason = 'the model plan was invalid after one repair';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let out: PlanOutput;
    try {
      out = await ctx.structured(planTask.id, 'synthesis', { role: 'orchestrator', system: systemPrompt('orchestrator'), contents }, PlanOutput);
    } catch (e) {
      // Any model failure (bad output, quota, hung request): the default plan still investigates.
      if (e instanceof LlmError && e.kind !== 'aborted') {
        reason = e.kind === 'invalid_output' ? reason : `the plan call failed (${e.kind})`;
        break;
      }
      throw e;
    }
    ctx.log.emit('plan.proposed', { ...out, attempt }, planTask.id);
    ctx.log.emit('agent.output', { role: 'orchestrator', kind: 'plan', output: out }, planTask.id);
    const { tasks, errors } = validatePlan(ctx, out, planTask, candidates !== null, nextId);
    if (errors.length === 0) {
      ctx.log.emit('plan.validated', { tasks }, planTask.id);
      return tasks;
    }
    ctx.log.emit('plan.rejected', { attempt, errors }, planTask.id);
    contents.push({ role: 'model', parts: [{ text: JSON.stringify(out) }] }, { role: 'user', parts: [{ text: `The plan failed validation:\n- ${errors.join('\n- ')}\nReturn a corrected plan.` }] });
  }
  const tasks = defaultPlan(ctx, planTask, nextId);
  ctx.log.emit('plan.fallback', { reason, tasks }, planTask.id);
  return tasks;
}

export function validatePlan(ctx: RunContext, out: PlanOutput, planTask: TaskSpec, withCandidates: boolean, nextId: () => string): { tasks: TaskSpec[]; errors: string[] } {
  const errors: string[] = [];
  const known = new Set(ctx.services.map((s) => s.id));
  const wFrom = Date.parse(ctx.incident.window.from) - 6 * HOUR;
  const wTo = Date.parse(ctx.incident.window.to) + 6 * HOUR;
  if (out.tasks.length < 2 || out.tasks.length > 6) errors.push(`plan has ${out.tasks.length} tasks; it must have 2 to 6`);
  const tasks: TaskSpec[] = [];
  const seen = new Set<string>();
  out.tasks.forEach((t, i) => {
    const services = [...new Set(t.services)].filter((s) => known.has(s));
    const unknown = t.services.filter((s) => !known.has(s));
    if (unknown.length) errors.push(`task ${i + 1}: unknown services ${unknown.join(', ')}`);
    if (services.length === 0) errors.push(`task ${i + 1}: no known services in scope`);
    const f = Date.parse(t.from);
    const to = Date.parse(t.to);
    if (Number.isNaN(f) || Number.isNaN(to) || !/(Z|[+-]\d{2}:\d{2})$/.test(t.from) || !/(Z|[+-]\d{2}:\d{2})$/.test(t.to)) errors.push(`task ${i + 1}: window must be ISO-8601 with an offset`);
    else if (f >= to) errors.push(`task ${i + 1}: window start must be before its end`);
    else if (f < wFrom || to > wTo) errors.push(`task ${i + 1}: window must lie within the incident window plus or minus 6 hours`);
    const key = `${t.role}|${services.sort().join(',')}|${t.from}|${t.to}|${t.question.trim().toLowerCase()}`;
    if (seen.has(key)) return; // exact duplicate: drop silently
    seen.add(key);
    tasks.push({
      id: '',
      role: t.role,
      question: t.question,
      scope: { services, from: t.from, to: t.to },
      dependsOn: [planTask.id],
      round: 0,
      origin: 'plan',
      rationale: t.rationale,
      discriminates: withCandidates ? t.discriminates : [],
      requestedCall: null,
    });
  });
  if (!tasks.some((t) => t.role === 'observability')) errors.push('plan needs at least one observability task');
  if (!tasks.some((t) => t.role === 'dependency')) errors.push('plan needs at least one dependency task');
  // Ids are assigned only to a plan that will be used, so ids stay dense.
  if (errors.length === 0) for (const t of tasks) t.id = nextId();
  return { tasks, errors };
}

export function defaultPlan(ctx: RunContext, planTask: TaskSpec, nextId: () => string): TaskSpec[] {
  const known = new Set(ctx.services.map((s) => s.id));
  const services = ctx.incident.suspectedServices.filter((s) => known.has(s));
  const scope = { services: services.length ? services : [ctx.services[0]!.id], from: ctx.incident.window.from, to: ctx.incident.window.to };
  return [
    { id: nextId(), role: 'observability', question: 'What do the logs and metrics of the affected services show around the onset?', scope, dependsOn: [planTask.id], round: 0, origin: 'fallback', rationale: 'default plan', discriminates: [], requestedCall: null },
    { id: nextId(), role: 'dependency', question: 'What changed, what do the affected services depend on, and have similar incidents happened?', scope, dependsOn: [planTask.id], round: 0, origin: 'fallback', rationale: 'default plan', discriminates: [], requestedCall: null },
  ];
}

/**
 * Turn the critic's follow-up requests into tasks. Code checks: the tool belongs to the role,
 * the parameters are valid for the tool, the query is new (canonical fingerprint not already
 * executed or requested), the tool budget has room, and at most 4 per round.
 */
export function validateFollowUps(ctx: RunContext, requests: FollowUpRequest[], round: number, criticTaskId: string, nextId: () => string): TaskSpec[] {
  const out: TaskSpec[] = [];
  const pending = new Set<string>();
  for (const f of requests) {
    const reject = (reason: string) => ctx.log.emit('followup.rejected', { followUp: f, reason }, criticTaskId);
    if (out.length >= MAX_FOLLOWUPS_PER_ROUND) {
      reject(`more than ${MAX_FOLLOWUPS_PER_ROUND} follow-ups in one round`);
      continue;
    }
    if (!(ROLE_TOOLS[f.role] as readonly string[]).includes(f.tool)) {
      reject(`role ${f.role} is not authorized to call ${f.tool}`);
      continue;
    }
    let params: unknown;
    try {
      params = JSON.parse(f.params_json);
    } catch {
      reject('params_json is not valid JSON');
      continue;
    }
    const prep = ctx.runner.prepare(f.tool, params);
    if (!prep.ok) {
      reject(`invalid parameters: ${prep.message}`);
      continue;
    }
    if (ctx.executedFingerprints.has(prep.fingerprint) || pending.has(prep.fingerprint)) {
      reject('not novel: this exact query was already executed or requested');
      continue;
    }
    if (ctx.budget.remaining().toolCalls - out.length < 1) {
      ctx.budget.refuseToolCall();
      reject('tool-call budget exhausted');
      continue;
    }
    pending.add(prep.fingerprint);
    const id = nextId();
    const spec: TaskSpec = {
      id,
      role: f.role,
      question: f.purpose,
      scope: null,
      dependsOn: [criticTaskId],
      round,
      origin: 'followup',
      rationale: `critic follow-up; discriminates ${f.discriminates.join(', ') || '(unspecified)'}`,
      discriminates: f.discriminates,
      requestedCall: { tool: f.tool, params: prep.canonical },
    };
    out.push(spec);
    ctx.log.emit('followup.scheduled', { taskId: id, followUp: f, fingerprint: prep.fingerprint }, criticTaskId);
  }
  return out;
}
