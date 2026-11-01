#!/usr/bin/env node
/**
 * Generates the synthetic corpus (fixtures/v1) and the answer keys (eval/labels).
 *
 *   npm run fixtures:generate            regenerate everything
 *   npm run fixtures:generate -- --only s01,s04
 *   npm run fixtures:check               regenerate in memory and compare to manifest.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Label } from '../eval/label-schema.js';
import { Manifest, readManifest } from '../src/db/bootstrap.js';
import { fixturesDir, FIXTURE_VERSION, type FixtureIndex, serializeWorld } from '../src/db/fixtures.js';
import { sha256 } from '../src/util/canonical.js';
import { projectRoot } from '../src/util/paths.js';
import { SCENARIOS } from './index.js';
import type { Variant } from './_lib/scenario.js';
import { GENERATOR } from './_lib/world.js';

export interface GeneratedWorld {
  key: string;
  worldId: string;
  incidentId: string;
  title: string;
  split: 'dev' | 'heldout';
  files: Map<string, { bytes: Buffer; sha256: string }>;
  worldSha: string;
  label: Label;
  stats: { logs: number; metricPoints: number; changes: number; history: number };
}

export function generateWorld(scenarioId: string, variant: Variant): GeneratedWorld {
  const def = SCENARIOS.find((s) => s.id === scenarioId);
  if (!def) throw new Error(`unknown scenario ${scenarioId}`);
  const { builder, label: body } = def.build(variant);
  const { world, faults } = builder.build();
  const key = `${def.id}-${variant}`;
  const split = def.dev && variant === 'A' ? 'dev' : 'heldout';
  const files = serializeWorld(world, faults);
  const worldSha = sha256([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, f]) => `${n}:${f.sha256}`).join('\n'));
  const label = Label.parse({ ...body, scenario: def.id, variant, key, worldId: world.meta.worldId, split, title: world.incident.title });
  return {
    key,
    worldId: world.meta.worldId,
    incidentId: world.incident.incidentId,
    title: world.incident.title,
    split,
    files,
    worldSha,
    label,
    stats: {
      logs: world.logs.length,
      metricPoints: world.metrics.reduce((n, s) => n + s.points.length, 0),
      changes: world.changes.length,
      history: world.history.length,
    },
  };
}

export function generateAll(only?: string[]): GeneratedWorld[] {
  const out: GeneratedWorld[] = [];
  for (const s of SCENARIOS) {
    if (only && !only.includes(s.id)) continue;
    for (const v of ['A', 'B'] as const) out.push(generateWorld(s.id, v));
  }
  return out;
}

export function corpusHash(worlds: Record<string, { sha256: string }>): string {
  return sha256(Object.keys(worlds).sort().map((id) => `${id}:${worlds[id]!.sha256}`).join('\n'));
}

function main() {
  const check = process.argv.includes('--check');
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? process.argv[onlyArg + 1]!.split(',') : undefined;
  const t0 = Date.now();
  const worlds = generateAll(only);
  const dir = fixturesDir();

  if (check) {
    const manifest = readManifest(dir);
    if (!manifest) throw new Error('no manifest to check against');
    let bad = 0;
    for (const w of worlds) {
      const want = manifest.worlds[w.worldId]?.sha256;
      if (want !== w.worldSha) {
        bad++;
        console.error(`MISMATCH ${w.key} ${w.worldId}: manifest ${want ?? '(missing)'} vs generated ${w.worldSha}`);
      }
    }
    if (!only && Object.keys(manifest.worlds).length !== worlds.length) {
      bad++;
      console.error(`world count differs: manifest ${Object.keys(manifest.worlds).length}, generated ${worlds.length}`);
    }
    console.log(bad === 0 ? `ok: ${worlds.length} worlds reproduce byte-for-byte (${Date.now() - t0} ms)` : `${bad} mismatches`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const previous = only ? readManifest(dir) : null;
  if (!only && existsSync(dir)) {
    for (const d of readdirSync(dir)) if (d.startsWith('w_')) rmSync(join(dir, d), { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
  const labelsDir = join(projectRoot(), 'eval', 'labels');
  mkdirSync(labelsDir, { recursive: true });

  const manifestWorlds: Manifest['worlds'] = previous ? { ...previous.worlds } : {};
  const indexEntries = new Map<string, FixtureIndex['worlds'][number]>();
  if (only && existsSync(join(dir, 'index.json'))) {
    for (const e of (JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FixtureIndex).worlds) indexEntries.set(e.key, e);
  }
  for (const w of worlds) {
    // Remove a stale directory for this key if its world id changed.
    const old = indexEntries.get(w.key);
    if (old && old.worldId !== w.worldId) {
      rmSync(join(dir, old.worldId), { recursive: true, force: true });
      delete manifestWorlds[old.worldId];
    }
    const wdir = join(dir, w.worldId);
    mkdirSync(wdir, { recursive: true });
    const fileHashes: Record<string, string> = {};
    for (const [name, f] of w.files) {
      writeFileSync(join(wdir, name), f.bytes);
      fileHashes[name] = f.sha256;
    }
    manifestWorlds[w.worldId] = { sha256: w.worldSha, files: fileHashes };
    indexEntries.set(w.key, { worldId: w.worldId, incidentId: w.incidentId, title: w.title, key: w.key, split: w.split });
    writeFileSync(join(labelsDir, `${w.key}.json`), JSON.stringify(w.label, null, 2) + '\n');
    const size = [...w.files.values()].reduce((n, f) => n + f.bytes.length, 0);
    console.log(
      `${w.key.padEnd(6)} ${w.worldId}  logs=${w.stats.logs}  points=${w.stats.metricPoints}  changes=${w.stats.changes}  history=${w.stats.history}  ${(size / 1024).toFixed(0)} KiB  "${w.title}"`,
    );
  }
  const manifest: Manifest = { version: FIXTURE_VERSION, generator: GENERATOR, corpusSha256: corpusHash(manifestWorlds), worlds: manifestWorlds };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const index: FixtureIndex = { version: FIXTURE_VERSION, worlds: [...indexEntries.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`corpus ${manifest.corpusSha256.slice(0, 16)}…  ${Object.keys(manifestWorlds).length} worlds  (${Date.now() - t0} ms)`);
}

if (process.argv[1] && /generate\.ts$/.test(process.argv[1])) main();
