#!/usr/bin/env node
/**
 * Load the synthetic corpus into the database.
 *   npm run fixtures:load                 # PGlite in ROOTLINE_DATA_DIR
 *   DATABASE_URL=... npm run fixtures:load  # Postgres; the schema must already exist (owned by Deltabase)
 */
import { loadEnv } from '../config.js';
import { ensureWorlds } from '../db/bootstrap.js';
import { openDb } from '../db/client.js';

async function main() {
  const cmd = process.argv[2] ?? 'load';
  if (cmd !== 'load') throw new Error(`unknown command ${cmd}`);
  const env = loadEnv();
  const db = await openDb(env.DATABASE_URL ? { url: env.DATABASE_URL } : { dataDir: env.ROOTLINE_DATA_DIR });
  const t0 = Date.now();
  const r = await ensureWorlds(db, undefined, (m) => console.error(m));
  console.error(`${r.loaded.length} worlds loaded, ${r.skipped.length} already current (${((Date.now() - t0) / 1000).toFixed(1)} s) into ${env.DATABASE_URL ? 'DATABASE_URL' : env.ROOTLINE_DATA_DIR}`);
  await db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
