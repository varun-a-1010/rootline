#!/usr/bin/env node
/**
 * Call one tool against one world, exactly as an agent would (same runner, faults and
 * envelope). Used for the evidence-sufficiency review of each scenario.
 *
 *   npm run tool -- --world <key from fixtures/v1/index.json> query_logs '{"services":["market-data-service"],"from":"...","to":"..."}'
 *   npm run tool -- --world <world id> --no-faults --model-view get_changes '{...}'
 */
import { loadEnv } from '../config.js';
import { openDb } from '../db/client.js';
import { ensureWorlds } from '../db/bootstrap.js';
import { readFaults, readIndex } from '../db/fixtures.js';
import { EvidenceLedger } from '../engine/ledger.js';
import { FaultInjector } from '../tools/faults.js';
import { createToolContext } from '../tools/registry.js';
import { DEFAULT_RUNNER_OPTIONS, ToolRunner } from '../tools/runner.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function resolveWorld(ref: string): string {
  if (/^w_[0-9a-f]{8}$/.test(ref)) return ref;
  const entry = readIndex().worlds.find((w) => w.key === ref || w.incidentId === ref);
  if (!entry) throw new Error(`unknown world "${ref}" (use a world id, an incident id, or a key from fixtures/v1/index.json)`);
  return entry.worldId;
}

async function main() {
  const env = loadEnv();
  const worldRef = arg('world');
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--world'));
  const [tool, json] = positional;
  if (!worldRef || !tool) {
    console.error('usage: npm run tool -- --world <id|key> [--no-faults] [--model-view] <tool> \'<json params>\'');
    process.exit(2);
  }
  const worldId = resolveWorld(worldRef);
  const db = await openDb(env.DATABASE_URL ? { url: env.DATABASE_URL } : { dataDir: env.ROOTLINE_DATA_DIR });
  if (!env.DATABASE_URL) await ensureWorlds(db, [worldId], (m) => console.error(m));
  const ctx = await createToolContext(db, worldId);
  const profile = process.argv.includes('--no-faults')
    ? { seed: 'none', latency: { minMs: 0, maxMs: 0 }, transient: [], rules: [] }
    : readFaults(worldId);
  const runner = new ToolRunner(ctx, new FaultInjector(profile), new EvidenceLedger(), DEFAULT_RUNNER_OPTIONS);
  const res = await runner.call(tool, json ? JSON.parse(json) : {}, { taskId: null, agent: 'cli' }, new AbortController().signal);
  const out = process.argv.includes('--model-view') ? res.modelView : { ...res.envelope, attempts: res.attempts.map((a) => `${a.attempt}:${a.status}${a.errorCode ? `(${a.errorCode})` : ''}`) };
  console.log(JSON.stringify(out, null, 2));
  await db.close();
}

if (process.argv[1] && /tool\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
