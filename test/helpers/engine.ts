import type { ArmId } from '../../src/contracts/events.js';
import type { Db } from '../../src/db/client.js';
import { openDb } from '../../src/db/client.js';
import { loadWorld } from '../../src/db/load.js';
import { DbRunStore } from '../../src/engine/persistence.js';
import { runInvestigation, type EngineSettings, type RunResult } from '../../src/engine/run.js';
import type { JevClient } from '../../src/llm/jev.js';
import type { LlmProvider } from '../../src/llm/types.js';
import '../../src/orchestrations/all.js';
import { buildTestWorld } from './world.js';

export const SETTINGS: EngineSettings = {
  maxRounds: 3,
  maxToolCalls: 40,
  maxLlmCalls: 48,
  maxTokens: 2_000_000,
  deadlineMs: 60_000,
  specialistToolCalls: 6,
  synthesisReserve: 4,
  taskConcurrency: 4,
  toolDeadlineMs: 200,
  toolRetries: 2,
  thinkingLevel: 'medium',
};

let shared: { db: Db; worldId: string } | null = null;

export async function testDb(): Promise<{ db: Db; worldId: string }> {
  if (shared) return shared;
  const { world } = buildTestWorld();
  const db = await openDb();
  await loadWorld(db, world, 'test-hash');
  shared = { db, worldId: world.meta.worldId };
  return shared;
}

export async function run(arm: ArmId, llm: LlmProvider, opts: { settings?: Partial<EngineSettings>; jev?: JevClient | null; signal?: AbortSignal; persist?: boolean; armBase?: 'A' | 'B' } = {}): Promise<RunResult & { store: DbRunStore | null; db: Db }> {
  const { db, worldId } = await testDb();
  const store = opts.persist ? new DbRunStore(db) : null;
  const res = await runInvestigation({
    db,
    worldId,
    arm,
    armBase: opts.armBase,
    llm,
    jev: opts.jev ?? null,
    settings: { ...SETTINGS, ...opts.settings },
    store,
    signal: opts.signal,
    faults: { seed: 'none', latency: { minMs: 0, maxMs: 2 }, transient: [], rules: [] },
    toolBackoffMs: 1,
    reportGraceMs: 5_000,
  });
  return { ...res, store, db };
}

export function types(r: RunResult): string[] {
  return r.events.map((e) => e.type);
}
