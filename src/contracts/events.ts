import { z } from 'zod';
import { CriticOutput, FollowUpRequest, Findings, Hypothesis, CandidatesOutput, PlanOutput, Report, StopReason, TaskSpec } from './agents.js';
import { EvidenceRecord, ToolAttempt } from './evidence.js';
import { IncidentReport } from './world.js';

/**
 * The run's event log. Every state change is one of these; RunState = fold(events). The same
 * log drives persistence, live SSE, replay, the Agentflow mapping and eval scoring.
 */

const Usage = z.object({ input: z.number().nullable(), output: z.number().nullable(), thinking: z.number().nullable(), cached: z.number().nullable() });

export const ArmId = z.enum(['A', 'B', 'C', 'D', 'E']);
export type ArmId = z.infer<typeof ArmId>;

export const RunConfig = z.object({
  arm: ArmId,
  armBase: z.enum(['A', 'B']).nullable(),
  model: z.string(),
  jevModel: z.string().nullable(),
  thinkingLevel: z.enum(['low', 'medium', 'high']),
  budgets: z.object({
    maxRounds: z.number().int(),
    maxToolCalls: z.number().int(),
    maxLlmCalls: z.number().int(),
    maxTokens: z.number().int(),
    deadlineMs: z.number().int(),
    specialistToolCalls: z.number().int(),
    synthesisReserve: z.number().int(),
    taskConcurrency: z.number().int(),
    toolDeadlineMs: z.number().int(),
    toolRetries: z.number().int(),
  }),
  promptHash: z.string(),
  fixtureHash: z.string().nullable(),
  gitSha: z.string().nullable(),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const EVENT_PAYLOADS = {
  'run.created': z.object({ runId: z.string(), worldId: z.string(), incident: IncidentReport, config: RunConfig, startedAt: z.number() }),
  'candidates.proposed': CandidatesOutput,
  'plan.proposed': PlanOutput.extend({ attempt: z.number().int() }),
  'plan.rejected': z.object({ attempt: z.number().int(), errors: z.array(z.string()) }),
  'plan.validated': z.object({ tasks: z.array(TaskSpec) }),
  'plan.fallback': z.object({ reason: z.string(), tasks: z.array(TaskSpec) }),
  'task.scheduled': TaskSpec,
  'task.started': z.object({ role: z.string(), attempt: z.number().int() }),
  'llm.call': z.object({
    role: z.string(),
    provider: z.string(),
    model: z.string(),
    attempt: z.number().int(),
    status: z.enum(['ok', 'error']),
    httpStatus: z.number().nullable(),
    errorKind: z.string().nullable(),
    latencyMs: z.number(),
    usage: Usage.nullable(),
    modelVersion: z.string().nullable(),
  }),
  'jev.call': z.object({
    role: z.string(),
    attempt: z.number().int(),
    status: z.enum(['ok', 'error']),
    httpStatus: z.number().nullable(),
    latencyMs: z.number(),
    questions: z.number().int(),
    usage: z.object({ input: z.number().nullable(), output: z.number().nullable(), costUsd: z.number().nullable() }).nullable(),
  }),
  'jev.decision': z.object({ kind: z.enum(['screen', 'grid', 'citation_check']), summary: z.string(), details: z.record(z.string(), z.unknown()) }),
  'tool.call': z.object({ callId: z.string(), tool: z.string(), params: z.unknown(), agent: z.string(), requestedBy: z.enum(['model', 'critic']) }),
  'tool.attempt': ToolAttempt,
  'tool.result': z.object({
    callId: z.string(),
    tool: z.string(),
    fingerprint: z.string(),
    canonical: z.record(z.string(), z.unknown()),
    status: z.enum(['ok', 'partial', 'error']),
    evidenceId: z.string().nullable(),
    recordCount: z.number().int(),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
    attempts: z.number().int(),
    caption: z.string(),
  }),
  'evidence.recorded': EvidenceRecord,
  'citation.invalid': z.object({ agent: z.string(), evidenceId: z.string(), context: z.string() }),
  'agent.output': z.object({ role: z.string(), kind: z.enum(['findings', 'reasoning', 'critic', 'report', 'plan', 'candidates']), output: z.unknown() }),
  'task.completed': z.object({ role: z.string(), summary: z.string(), hadGaps: z.boolean() }),
  'task.failed': z.object({ role: z.string(), error: z.string(), gap: z.string() }),
  'hypotheses.updated': z.object({ version: z.number().int(), round: z.number().int(), hypotheses: z.array(Hypothesis), dropped: z.array(z.object({ id: z.string(), reason: z.string() })) }),
  'critic.checks': z.object({ round: z.number().int(), checks: z.array(z.object({ check: z.string(), status: z.enum(['pass', 'flag']), detail: z.string() })) }),
  'critic.decided': CriticOutput.extend({ round: z.number().int() }),
  'followup.scheduled': z.object({ taskId: z.string(), followUp: FollowUpRequest, fingerprint: z.string() }),
  'followup.rejected': z.object({ followUp: FollowUpRequest, reason: z.string() }),
  'budget.exhausted': z.object({ budget: z.enum(['tool_calls', 'llm_calls', 'tokens', 'deadline']), used: z.number(), limit: z.number() }),
  'specialist.findings': z.object({ role: z.string(), findings: Findings }),
  'report.ready': z.object({ report: Report, markdown: z.string() }),
  'run.terminated': z.object({
    status: z.enum(['completed', 'failed', 'cancelled']),
    stopReason: StopReason,
    outcome: z.enum(['conclusive', 'inconclusive', 'failed']),
    endedAt: z.number(),
  }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

export interface RunEvent<T extends EventType = EventType> {
  seq: number;
  ts: number;
  runId: string;
  type: T;
  taskId: string | null;
  payload: EventPayload<T>;
}

export const RunEventEnvelope = z.object({
  seq: z.number().int().min(1),
  ts: z.number(),
  runId: z.string(),
  type: z.string(),
  taskId: z.string().nullable(),
  payload: z.unknown(),
});

/** Validate one event's payload against its type's schema. */
export function parseEvent(raw: unknown): RunEvent {
  const env = RunEventEnvelope.parse(raw);
  const schema = (EVENT_PAYLOADS as Record<string, z.ZodType>)[env.type];
  if (!schema) throw new Error(`unknown event type ${env.type}`);
  return { ...env, type: env.type as EventType, payload: schema.parse(env.payload) } as RunEvent;
}
