import type { CandidatesOutput, CriticOutput, Findings, Hypothesis, PlanOutput, Report, StopReason, TaskSpec } from '../contracts/agents.js';
import type { EvidenceRecord, ToolAttempt } from '../contracts/evidence.js';
import type { EventPayload, RunConfig, RunEvent } from '../contracts/events.js';
import type { IncidentReport } from '../contracts/world.js';

export interface TaskState extends TaskSpec {
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  scheduledAt: number;
  startedAt: number | null;
  endedAt: number | null;
  summary: string | null;
  error: string | null;
  hadGaps: boolean;
  /** [ts, text] — latest tool call / Jev decision per task, for viewers. */
  captions: Array<[number, string]>;
  toolCalls: number;
  llmCalls: number;
}

export interface RunState {
  runId: string;
  worldId: string;
  incident: IncidentReport | null;
  config: RunConfig | null;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stopReason: StopReason | null;
  outcome: 'conclusive' | 'inconclusive' | 'failed' | null;
  taskOrder: string[];
  tasks: Record<string, TaskState>;
  candidates: CandidatesOutput | null;
  plan: PlanOutput | null;
  planRejections: string[][];
  planFallback: boolean;
  evidence: Record<string, EvidenceRecord>;
  attempts: ToolAttempt[];
  toolResults: Array<EventPayload<'tool.result'> & { taskId: string | null; ts: number }>;
  llmCalls: Array<EventPayload<'llm.call'> & { taskId: string | null; ts: number }>;
  jevCalls: Array<EventPayload<'jev.call'> & { taskId: string | null; ts: number }>;
  jevDecisions: Array<EventPayload<'jev.decision'> & { taskId: string | null; ts: number }>;
  findings: Record<string, Findings>;
  hypothesisVersions: Array<{ version: number; round: number; hypotheses: Hypothesis[]; dropped: Array<{ id: string; reason: string }>; ts: number }>;
  criticChecks: Array<EventPayload<'critic.checks'> & { ts: number }>;
  criticDecisions: Array<CriticOutput & { round: number; ts: number; taskId: string | null }>;
  followupsScheduled: Array<EventPayload<'followup.scheduled'>>;
  followupsRejected: Array<EventPayload<'followup.rejected'>>;
  citationInvalid: Array<EventPayload<'citation.invalid'> & { taskId: string | null }>;
  budgetExhausted: Array<EventPayload<'budget.exhausted'>>;
  report: Report | null;
  markdown: string | null;
  lastSeq: number;
}

export function emptyState(runId = ''): RunState {
  return {
    runId,
    worldId: '',
    incident: null,
    config: null,
    startedAt: 0,
    endedAt: null,
    status: 'running',
    stopReason: null,
    outcome: null,
    taskOrder: [],
    tasks: {},
    candidates: null,
    plan: null,
    planRejections: [],
    planFallback: false,
    evidence: {},
    attempts: [],
    toolResults: [],
    llmCalls: [],
    jevCalls: [],
    jevDecisions: [],
    findings: {},
    hypothesisVersions: [],
    criticChecks: [],
    criticDecisions: [],
    followupsScheduled: [],
    followupsRejected: [],
    citationInvalid: [],
    budgetExhausted: [],
    report: null,
    markdown: null,
    lastSeq: 0,
  };
}

/** Pure reducer: RunState = fold(events). */
export function reduce(s: RunState, e: RunEvent): RunState {
  const p = e.payload as never;
  const task = e.taskId ? s.tasks[e.taskId] : undefined;
  s.lastSeq = e.seq;
  switch (e.type) {
    case 'run.created': {
      const x = p as EventPayload<'run.created'>;
      s.runId = x.runId;
      s.worldId = x.worldId;
      s.incident = x.incident;
      s.config = x.config;
      s.startedAt = x.startedAt;
      break;
    }
    case 'candidates.proposed':
      s.candidates = p as CandidatesOutput;
      break;
    case 'plan.proposed': {
      const { attempt: _a, ...plan } = p as EventPayload<'plan.proposed'>;
      s.plan = plan;
      break;
    }
    case 'plan.rejected':
      s.planRejections.push((p as EventPayload<'plan.rejected'>).errors);
      break;
    case 'plan.fallback':
      s.planFallback = true;
      break;
    case 'task.scheduled': {
      const spec = p as TaskSpec;
      s.tasks[spec.id] = { ...spec, status: 'pending', attempts: 0, scheduledAt: e.ts, startedAt: null, endedAt: null, summary: null, error: null, hadGaps: false, captions: [], toolCalls: 0, llmCalls: 0 };
      s.taskOrder.push(spec.id);
      break;
    }
    case 'task.started':
      if (task) {
        task.status = 'running';
        task.attempts = (p as EventPayload<'task.started'>).attempt;
        task.startedAt ??= e.ts;
      }
      break;
    case 'task.completed':
      if (task) {
        const x = p as EventPayload<'task.completed'>;
        task.status = 'completed';
        task.endedAt = e.ts;
        task.summary = x.summary;
        task.hadGaps = x.hadGaps;
      }
      break;
    case 'task.failed':
      if (task) {
        const x = p as EventPayload<'task.failed'>;
        task.status = 'failed';
        task.endedAt = e.ts;
        task.error = x.error;
      }
      break;
    case 'llm.call':
      s.llmCalls.push({ ...(p as EventPayload<'llm.call'>), taskId: e.taskId, ts: e.ts });
      if (task && (p as EventPayload<'llm.call'>).attempt === 1) task.llmCalls += 1;
      break;
    case 'jev.call':
      s.jevCalls.push({ ...(p as EventPayload<'jev.call'>), taskId: e.taskId, ts: e.ts });
      break;
    case 'jev.decision': {
      const x = p as EventPayload<'jev.decision'>;
      s.jevDecisions.push({ ...x, taskId: e.taskId, ts: e.ts });
      if (task) task.captions.push([e.ts, `jev: ${x.summary}`]);
      break;
    }
    case 'tool.attempt':
      s.attempts.push(p as ToolAttempt);
      break;
    case 'tool.result': {
      const x = p as EventPayload<'tool.result'>;
      s.toolResults.push({ ...x, taskId: e.taskId, ts: e.ts });
      if (task) {
        task.toolCalls += 1;
        task.captions.push([e.ts, x.caption]);
      }
      break;
    }
    case 'evidence.recorded': {
      const x = p as EvidenceRecord;
      s.evidence[x.evidenceId] = x;
      break;
    }
    case 'citation.invalid':
      s.citationInvalid.push({ ...(p as EventPayload<'citation.invalid'>), taskId: e.taskId });
      break;
    case 'specialist.findings':
      if (e.taskId) s.findings[e.taskId] = (p as EventPayload<'specialist.findings'>).findings;
      break;
    case 'hypotheses.updated': {
      const x = p as EventPayload<'hypotheses.updated'>;
      s.hypothesisVersions.push({ ...x, ts: e.ts });
      break;
    }
    case 'critic.checks':
      s.criticChecks.push({ ...(p as EventPayload<'critic.checks'>), ts: e.ts });
      break;
    case 'critic.decided':
      s.criticDecisions.push({ ...(p as EventPayload<'critic.decided'>), ts: e.ts, taskId: e.taskId });
      break;
    case 'followup.scheduled':
      s.followupsScheduled.push(p as EventPayload<'followup.scheduled'>);
      break;
    case 'followup.rejected':
      s.followupsRejected.push(p as EventPayload<'followup.rejected'>);
      break;
    case 'budget.exhausted':
      s.budgetExhausted.push(p as EventPayload<'budget.exhausted'>);
      break;
    case 'report.ready': {
      const x = p as EventPayload<'report.ready'>;
      s.report = x.report;
      s.markdown = x.markdown;
      break;
    }
    case 'run.terminated': {
      const x = p as EventPayload<'run.terminated'>;
      s.status = x.status;
      s.stopReason = x.stopReason;
      s.outcome = x.outcome;
      s.endedAt = x.endedAt;
      break;
    }
    default:
      break;
  }
  return s;
}

export function fold(events: RunEvent[], runId = ''): RunState {
  return events.reduce(reduce, emptyState(runId));
}

export function latestHypotheses(s: RunState): Hypothesis[] {
  return s.hypothesisVersions[s.hypothesisVersions.length - 1]?.hypotheses ?? [];
}
