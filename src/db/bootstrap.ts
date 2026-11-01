import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from './client.js';
import { fixturesDir, readWorld } from './fixtures.js';
import { loadedWorlds, loadWorld } from './load.js';

export const Manifest = z.object({
  version: z.string(),
  generator: z.string(),
  corpusSha256: z.string(),
  worlds: z.record(z.string(), z.object({ sha256: z.string(), files: z.record(z.string(), z.string()) })),
});
export type Manifest = z.infer<typeof Manifest>;

export function readManifest(dir = fixturesDir()): Manifest | null {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) return null;
  return Manifest.parse(JSON.parse(readFileSync(p, 'utf8')));
}

/**
 * Make sure the requested worlds (default: all in the manifest) are loaded and current.
 * A world is (re)loaded when it is missing or its fixture hash changed.
 */
export async function ensureWorlds(
  db: Db,
  worldIds?: string[],
  log: (msg: string) => void = () => {},
  dir = fixturesDir(),
): Promise<{ loaded: string[]; skipped: string[] }> {
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`no fixture manifest in ${dir}; run npm run fixtures:generate`);
  const want = worldIds ?? Object.keys(manifest.worlds).sort();
  const have = new Map((await loadedWorlds(db)).map((w) => [w.worldId, w.fixtureHash]));
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const id of want) {
    const entry = manifest.worlds[id];
    if (!entry) throw new Error(`world ${id} is not in the fixture manifest`);
    if (have.get(id) === entry.sha256) {
      skipped.push(id);
      continue;
    }
    const t0 = Date.now();
    await loadWorld(db, readWorld(id, dir), entry.sha256);
    log(`loaded ${id} in ${Date.now() - t0} ms`);
    loaded.push(id);
  }
  return { loaded, skipped };
}
