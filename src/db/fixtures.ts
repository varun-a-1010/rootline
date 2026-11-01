import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { FaultProfile } from '../contracts/faults.js';
import { LogEvent, MetricSeries, WorldFile, type WorldData } from '../contracts/world.js';
import { sha256 } from '../util/canonical.js';
import { projectRoot } from '../util/paths.js';

/**
 * Fixture corpus layout (fixtures/v1):
 *   index.json                     world list for the CLI/UI: worldId, incidentId, title, key
 *   manifest.json                  sha256 per file (over uncompressed bytes) and for the corpus
 *   <worldId>/world.json           meta, incident, services, dependencies, changes, history
 *   <worldId>/logs.jsonl.gz        log events
 *   <worldId>/metrics.jsonl.gz     metric points
 *   <worldId>/faults.json          fault profile — read only by the fault layer
 */

export const FIXTURE_VERSION = 'v1';

export function fixturesDir(): string {
  return join(projectRoot(), 'fixtures', FIXTURE_VERSION);
}

export const IndexEntry = z.object({
  worldId: z.string(),
  incidentId: z.string(),
  title: z.string(),
  /** Evaluator-facing scenario key (scenario number + variant). Agents never see it. */
  key: z.string(),
  split: z.enum(['dev', 'heldout']),
});
export type IndexEntry = z.infer<typeof IndexEntry>;
export const FixtureIndex = z.object({ version: z.string(), worlds: z.array(IndexEntry) });
export type FixtureIndex = z.infer<typeof FixtureIndex>;

export function readIndex(dir = fixturesDir()): FixtureIndex {
  return FixtureIndex.parse(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')));
}

export function readWorld(worldId: string, dir = fixturesDir()): WorldData {
  const wdir = join(dir, worldId);
  const file = WorldFile.parse(JSON.parse(readFileSync(join(wdir, 'world.json'), 'utf8')));
  const logs = readJsonlGz(join(wdir, 'logs.jsonl.gz')).map((l) => LogEvent.parse(l));
  const metrics = readJsonlGz(join(wdir, 'metrics.jsonl.gz')).map((m) => MetricSeries.parse(m));
  return { ...file, logs, metrics };
}

export function readFaults(worldId: string, dir = fixturesDir()): FaultProfile {
  const p = join(dir, worldId, 'faults.json');
  if (!existsSync(p)) return { seed: worldId, latency: { minMs: 50, maxMs: 400 }, transient: [], rules: [] };
  return FaultProfile.parse(JSON.parse(readFileSync(p, 'utf8')));
}

export function listWorldDirs(dir = fixturesDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => d.startsWith('w_')).sort();
}

function readJsonlGz(path: string): unknown[] {
  const text = gunzipSync(readFileSync(path)).toString('utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Serialized files for one world: relative path -> {bytes to write, sha256 over uncompressed}. */
export function serializeWorld(world: WorldData, faults: FaultProfile): Map<string, { bytes: Buffer; sha256: string }> {
  const out = new Map<string, { bytes: Buffer; sha256: string }>();
  const { logs, metrics, ...file } = world;
  const put = (name: string, text: string, gz: boolean) => {
    const raw = Buffer.from(text, 'utf8');
    out.set(name, { bytes: gz ? gzipSync(raw, { level: 9 }) : raw, sha256: sha256(text) });
  };
  put('world.json', JSON.stringify(file, null, 1) + '\n', false);
  put('logs.jsonl.gz', logs.map((l) => JSON.stringify(l)).join('\n') + '\n', true);
  put('metrics.jsonl.gz', metrics.map((m) => JSON.stringify(m)).join('\n') + '\n', true);
  put('faults.json', JSON.stringify(faults, null, 1) + '\n', false);
  return out;
}

/** sha256 of a fixture file's uncompressed content (gzip headers vary by platform). */
export function hashFixtureFile(path: string): string {
  const buf = readFileSync(path);
  return sha256((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}
