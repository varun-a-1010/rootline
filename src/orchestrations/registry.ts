import type { ArmId } from '../contracts/events.js';
import type { RunContext } from '../engine/context.js';
import { runFlow } from './flow.js';

export interface Orchestration {
  id: ArmId;
  title: string;
  description: string;
  /** Runs the investigation up to (not including) the final report. */
  run(ctx: RunContext): Promise<void>;
  /** The baseline writes its own report; multi-agent arms use the reporting agent. */
  writesOwnReport?: boolean;
}

export const splitBySource: Orchestration = {
  id: 'A',
  title: 'Split by source, then critique',
  description: 'The orchestrator splits work by data source; specialists run in parallel; reasoning, the critic and follow-up rounds.',
  run: (ctx) => runFlow(ctx, { candidatesFirst: false, critic: true }),
};

export const causesFirst: Orchestration = {
  id: 'B',
  title: 'Causes first',
  description: 'Reasoning proposes candidate causes before any tool call; tasks are planned to confirm or rule each out; then as A.',
  run: (ctx) => runFlow(ctx, { candidatesFirst: true, critic: true }),
};

export const noCritic: Orchestration = {
  id: 'C',
  title: 'A without the critic',
  description: 'One round: plan, specialists, reasoning, report. Shows what the critic is worth.',
  run: (ctx) => runFlow(ctx, { candidatesFirst: false, critic: false }),
};

const REGISTRY = new Map<ArmId, Orchestration>([
  ['A', splitBySource],
  ['B', causesFirst],
  ['C', noCritic],
]);

export function registerOrchestration(o: Orchestration): void {
  REGISTRY.set(o.id, o);
}

export function orchestration(arm: ArmId): Orchestration {
  const o = REGISTRY.get(arm);
  if (!o) throw new Error(`arm ${arm} is not available`);
  return o;
}

export function orchestrations(): Orchestration[] {
  return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}
