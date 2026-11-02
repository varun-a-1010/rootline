import type { RunEvent } from '../contracts/events.js';
import { fold, type RunState, type TaskState } from '../engine/run-state.js';

/**
 * Agentflow viewer mapping (viewer contract v1.1.0), derived only from recorded events.
 *   root = the run; plan (orchestrator) -> round-0 specialists -> reasoning (parent = one
 *   specialist, alsoFedBy = the rest) -> critic -> follow-up tasks (parent = critic) ->
 *   reasoning v2 -> ... -> report. Rounds are new nodes (the viewer has no cycles).
 *   Arm B adds a candidates node before the plan; arm C has no critic nodes; the baseline is
 *   root -> agent -> report. Arm D's Jev decisions appear as captions on the asking node.
 */
export type FlowStatus = 'active' | 'ok' | 'findings' | 'failed';

export interface FlowNode {
  id: string;
  parentId: string | null;
  alsoFedBy?: string[];
  label: string;
  phase: string;
  status?: FlowStatus;
  caption?: string;
}

export interface TimedFlowNode {
  id: string;
  parentId: string | null;
  alsoFedBy?: string[];
  label: string;
  phase: string;
  spawn: number;
  done: number;
  verdict?: string;
  tone?: FlowStatus;
  captions?: Array<[number, string]>;
}

const PHASE: Record<string, string> = {
  orchestrator: 'plan',
  candidates: 'hypothesize',
  observability: 'investigate',
  dependency: 'investigate',
  reasoning: 'reason',
  critic: 'critique',
  reporting: 'report',
  baseline: 'investigate',
};

/**
 * Node labels are short names. The viewer gives every label a fixed 176 px box but spaces columns
 * at min(208, (width - 300) / depth), so in a deep run a long label runs into the next column on the
 * same row. A task's question stays in the run view (Tasks tab); the incident title is the graph's
 * own heading, so the root is just "Incident".
 */
const ROOT_LABEL = 'Incident';

function label(t: TaskState, s: RunState): string {
  switch (t.role) {
    case 'orchestrator':
      return 'Plan';
    case 'candidates':
      return 'Candidates';
    case 'reasoning':
      return `Reasoning v${s.taskOrder.filter((id) => s.tasks[id]!.role === 'reasoning').indexOf(t.id) + 1}`;
    case 'critic':
      return `Critic round ${t.round + 1}`;
    case 'reporting':
      return 'Report';
    case 'baseline':
      return 'Single agent';
    default:
      return t.role === 'observability' ? 'Logs & metrics' : 'Changes & deps';
  }
}

function status(t: TaskState, s: RunState): FlowStatus {
  if (t.status === 'pending' || t.status === 'running') return 'active';
  if (t.status === 'failed') return 'failed';
  if (t.role === 'critic') {
    const d = s.criticDecisions.find((x) => x.taskId === t.id);
    return d && d.decision !== 'accept' ? 'findings' : 'ok';
  }
  if (t.role === 'reporting' || t.role === 'baseline') return s.report && s.report.outcome !== 'conclusive' ? 'findings' : 'ok';
  return t.hadGaps ? 'findings' : 'ok';
}

/** Parent and co-parents for every task, from the task graph (dependsOn + rounds). */
function structure(s: RunState): Map<string, { parentId: string; alsoFedBy?: string[] }> {
  const out = new Map<string, { parentId: string; alsoFedBy?: string[] }>();
  const tasks = s.taskOrder.map((id) => s.tasks[id]!);
  let lastTerminal = 'run';
  for (const t of tasks) {
    const deps = t.dependsOn.filter((d) => s.tasks[d]);
    if (t.role === 'reporting' || (t.role === 'baseline' && deps.length === 0)) {
      out.set(t.id, { parentId: t.role === 'baseline' ? 'run' : lastTerminal });
    } else if (deps.length === 0) {
      out.set(t.id, { parentId: 'run' });
    } else {
      const [first, ...rest] = deps;
      out.set(t.id, rest.length ? { parentId: first!, alsoFedBy: rest } : { parentId: first! });
    }
    if (t.role !== 'observability' && t.role !== 'dependency') lastTerminal = t.id;
  }
  return out;
}

export function flowNodes(events: RunEvent[], s: RunState = fold(events)): FlowNode[] {
  const nodes: FlowNode[] = [{ id: 'run', parentId: null, label: ROOT_LABEL, phase: 'run', status: s.status === 'running' ? 'active' : s.status === 'completed' ? 'ok' : 'failed' }];
  const st = structure(s);
  for (const id of s.taskOrder) {
    const t = s.tasks[id]!;
    const p = st.get(id)!;
    const caption = t.captions[t.captions.length - 1]?.[1];
    nodes.push({ id, parentId: p.parentId, ...(p.alsoFedBy ? { alsoFedBy: p.alsoFedBy } : {}), label: label(t, s), phase: PHASE[t.role] ?? t.role, status: status(t, s), ...(caption ? { caption } : {}) });
  }
  const extra = reportNode(s);
  if (extra) nodes.push({ id: extra.id, parentId: extra.parentId, label: 'Report', phase: 'report', status: s.report!.outcome === 'conclusive' ? 'ok' : s.report!.outcome === 'failed' ? 'failed' : 'findings' });
  return nodes;
}

/**
 * The baseline (and a cancelled run) produces its report without a reporting task; show it as
 * a report node under the last task so every run ends in a report node.
 */
function reportNode(s: RunState): { id: string; parentId: string } | null {
  if (!s.report || s.taskOrder.some((id) => s.tasks[id]!.role === 'reporting')) return null;
  const last = s.taskOrder[s.taskOrder.length - 1];
  return { id: 'report', parentId: last ?? 'run' };
}

export interface Replay {
  duration: number;
  /** >1 when a long run was compressed to about 60 s. */
  compression: number;
  realDurationS: number;
  nodes: TimedFlowNode[];
}

/** Replay for a finished run, built only from recorded event timestamps. */
export function flowReplay(events: RunEvent[], s: RunState = fold(events)): Replay {
  // Event timestamps only (not payload fields).
  const t0 = events[0]?.ts ?? 0;
  const end = events.find((e) => e.type === 'run.terminated')?.ts ?? events[events.length - 1]?.ts ?? t0;
  const real = Math.max(0.001, (end - t0) / 1000);
  const compression = real > 90 ? real / 60 : 1;
  const sec = (ts: number) => Math.round(((ts - t0) / 1000 / compression) * 100) / 100;
  const st = structure(s);
  const nodes: TimedFlowNode[] = [{ id: 'run', parentId: null, label: ROOT_LABEL, phase: 'run', spawn: 0, done: sec(end), tone: s.status === 'completed' ? 'ok' : 'failed' }];
  for (const id of s.taskOrder) {
    const t = s.tasks[id]!;
    const p = st.get(id)!;
    const d = t.role === 'critic' ? s.criticDecisions.find((x) => x.taskId === t.id)?.decision : t.role === 'reporting' || t.role === 'baseline' ? s.report?.outcome : undefined;
    nodes.push({
      id,
      parentId: p.parentId,
      ...(p.alsoFedBy ? { alsoFedBy: p.alsoFedBy } : {}),
      label: label(t, s),
      phase: PHASE[t.role] ?? t.role,
      spawn: sec(t.startedAt ?? t.scheduledAt),
      done: sec(t.endedAt ?? end),
      ...(d ? { verdict: d } : {}),
      tone: status(t, s),
      ...(t.captions.length ? { captions: t.captions.map(([ts, c]) => [sec(ts), c] as [number, string]) } : {}),
    });
  }
  const extra = reportNode(s);
  if (extra) {
    const at = events.find((e) => e.type === 'report.ready')?.ts ?? end;
    nodes.push({ id: extra.id, parentId: extra.parentId, label: 'Report', phase: 'report', spawn: sec(at), done: sec(at), verdict: s.report!.outcome, tone: s.report!.outcome === 'conclusive' ? 'ok' : s.report!.outcome === 'failed' ? 'failed' : 'findings' });
  }
  return { duration: sec(end), compression: Math.round(compression * 100) / 100, realDurationS: Math.round(real * 10) / 10, nodes };
}
