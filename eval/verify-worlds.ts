#!/usr/bin/env node
/**
 * Integrity check: compare every world in a PGlite data directory with the fixture files
 * (row counts and value sums). PGlite is single-process, so this guards against a directory
 * that two processes opened at once.
 *   npx tsx eval/verify-worlds.ts [data-dir]
 */
import { readManifest } from '../src/db/bootstrap.js';
import { openDb } from '../src/db/client.js';
import { readWorld } from '../src/db/fixtures.js';

async function main() {
  const dir = process.argv[2] ?? '.data/pglite';
  const db = await openDb({ dataDir: dir });
  const manifest = readManifest()!;
  let bad = 0;
  let checked = 0;
  for (const id of Object.keys(manifest.worlds).sort()) {
    const row = await db.query<{ fixture_hash: string }>('SELECT fixture_hash FROM worlds WHERE world_id = $1', [id]);
    if (!row[0]) continue; // not loaded here: nothing to verify
    checked++;
    const w = readWorld(id);
    const points = w.metrics.flatMap((s) => s.points);
    const want = {
      hash: manifest.worlds[id]!.sha256,
      logs: w.logs.length,
      points: points.length,
      changes: w.changes.length,
      history: w.history.length,
      sum: Math.round(points.reduce((n, [, v]) => n + v, 0)),
      logChars: w.logs.reduce((n, l) => n + l.message.length, 0),
    };
    const q = async (sql: string) => Number((await db.query<{ n: string }>(sql, [id]))[0]!.n);
    const got = {
      hash: row[0].fixture_hash,
      logs: await q('SELECT count(*) n FROM log_events WHERE world_id = $1'),
      points: await q('SELECT count(*) n FROM metric_points WHERE world_id = $1'),
      changes: await q('SELECT count(*) n FROM change_events WHERE world_id = $1'),
      history: await q('SELECT count(*) n FROM historical_incidents WHERE world_id = $1'),
      sum: Math.round(await q('SELECT coalesce(sum(value),0) n FROM metric_points WHERE world_id = $1')),
      logChars: await q('SELECT coalesce(sum(length(message)),0) n FROM log_events WHERE world_id = $1'),
    };
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      bad++;
      console.log(`MISMATCH ${id}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  }
  console.log(`${checked} worlds checked in ${dir}: ${bad === 0 ? 'all match the fixtures' : `${bad} MISMATCHED`}`);
  await db.close();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
