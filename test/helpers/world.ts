import type { FaultProfile, FaultRule } from '../../src/contracts/faults.js';
import type { WorldData } from '../../src/contracts/world.js';
import { openDb, type Db } from '../../src/db/client.js';
import { loadWorld } from '../../src/db/load.js';
import { EvidenceLedger } from '../../src/engine/ledger.js';
import { FaultInjector } from '../../src/tools/faults.js';
import { createToolContext } from '../../src/tools/registry.js';
import { ToolRunner, type RunnerOptions, type ToolRunnerHooks } from '../../src/tools/runner.js';
import { WorldBuilder } from '../../scenarios/_lib/world.js';
import { addMin, ist } from '../../scenarios/_lib/time.js';

export const TEST_DAY = '2026-10-14'; // a Wednesday

/** A small seeded world with a few services and a scripted signal, for deterministic tests. */
export function buildTestWorld(extraRules: FaultRule[] = []): { world: WorldData; faults: FaultProfile } {
  const from = ist(TEST_DAY, '09:00');
  const to = ist(TEST_DAY, '10:30');
  const b = new WorldBuilder({
    key: 'test-world',
    seed: 'test-seed-1',
    window: { from, to },
    preHours: 1,
    services: ['api-gateway', 'order-service', 'broker-connector', 'broker-api', 'database', 'job-scheduler', 'portfolio-service', 'market-data-service', 'cache'],
    historyCount: 6,
  });
  const deployAt = addMin(from, 12);
  b.change({ at: deployAt, service: 'order-service', type: 'deploy', versionTo: '5.5.0', summary: 'release: new order validation', author: 'a.menon' });
  b.logStream({
    service: 'broker-connector',
    from: ist(TEST_DAY, '09:15'),
    to: ist(TEST_DAY, '09:40'),
    perMin: 6,
    sev: 'ERROR',
    msg: () => 'POST /orders -> 429 Too Many Requests',
    fields: (r) => ({ provider: 'broker-api', endpoint: 'orders', status: 429, trace_id: r.hex(16) }),
  });
  b.effect({ service: 'broker-connector', metric: 'rate_limited_count', label: 'orders', from: ist(TEST_DAY, '09:15'), to: ist(TEST_DAY, '09:40'), op: 'set', value: 300, noise: 0.1 });
  b.addHistory({
    openedAt: ist('2026-09-20', '09:16').toISOString(),
    resolvedAt: ist('2026-09-20', '10:05').toISOString(),
    title: 'Orders failing at market open',
    severity: 'SEV1',
    services: ['order-service', 'broker-connector', 'broker-api'],
    symptoms: 'Order placement errors spiked at 09:15 IST.',
    rootCause: 'Broker API outage.',
    resolution: 'Broker recovered.',
    tags: ['orders', 'market-open', 'broker'],
  });
  for (const r of extraRules) b.faultRule(r);
  b.setTransient([]);
  b.setIncident({
    title: 'Orders failing at market open',
    reportedAt: ist(TEST_DAY, '09:35').toISOString(),
    reportedBy: 'On-call SRE',
    severity: 'SEV2',
    summary: 'Order placement failing for many users since about 09:15 IST.',
    symptoms: ['order placement errors'],
    userImpact: 'Users cannot place stock orders.',
    affectedSurface: 'Orders',
    suspectedServices: ['order-service'],
    approxStart: ist(TEST_DAY, '09:15').toISOString(),
  });
  return b.build();
}

export interface TestRig {
  db: Db;
  world: WorldData;
  faults: FaultProfile;
  ledger: EvidenceLedger;
  runner: ToolRunner;
  signal: AbortSignal;
}

export const FAST: RunnerOptions = { deadlineMs: 120, maxRetries: 2, backoffBaseMs: 5 };

export async function makeRig(rules: FaultRule[] = [], opts: RunnerOptions = FAST, hooks: ToolRunnerHooks = {}): Promise<TestRig> {
  const { world, faults } = buildTestWorld(rules);
  const db = await openDb();
  await loadWorld(db, world, 'test-hash');
  const ctx = await createToolContext(db, world.meta.worldId);
  const ledger = new EvidenceLedger();
  const fastFaults = { ...faults, latency: { minMs: 0, maxMs: 5 } };
  const runner = new ToolRunner(ctx, new FaultInjector(fastFaults), ledger, opts, hooks);
  return { db, world, faults: fastFaults, ledger, runner, signal: new AbortController().signal };
}
