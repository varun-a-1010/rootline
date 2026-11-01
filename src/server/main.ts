#!/usr/bin/env node
/**
 * Production entry: serves the API and the built web app from one Node process.
 * Configured entirely by environment variables (see README).
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadEnv } from '../config.js';
import { ensureWorlds } from '../db/bootstrap.js';
import { openDb } from '../db/client.js';
import { settingsFromEnv } from '../engine/run.js';
import { createLiveProviders } from '../llm/factory.js';
import '../orchestrations/all.js';
import { projectRoot } from '../util/paths.js';
import { createApp } from './app.js';
import { RunLimiter } from './limits.js';
import { RunManager } from './runs.js';

async function main() {
  const env = loadEnv();
  const db = await openDb(env.DATABASE_URL ? { url: env.DATABASE_URL } : { dataDir: env.ROOTLINE_DATA_DIR });
  if (!env.DATABASE_URL) {
    const t0 = Date.now();
    const r = await ensureWorlds(db);
    console.log(`fixtures: ${r.loaded.length} loaded, ${r.skipped.length} current (${Date.now() - t0} ms)`);
  }
  const providers = createLiveProviders(env);
  for (const p of providers.problems) console.warn(`warning: ${p}`);
  const app = createApp({
    db,
    runs: new RunManager(db, providers, settingsFromEnv(env)),
    limiter: new RunLimiter(env.ROOTLINE_RUNS_PER_IP_PER_HOUR, env.ROOTLINE_RUNS_PER_DAY),
    accessCode: env.ROOTLINE_ACCESS_CODE,
    flowViewerUrl: env.ROOTLINE_FLOW_VIEWER_URL,
  });
  const webDist = join(projectRoot(), 'web', 'dist');
  if (existsSync(webDist)) {
    app.use('/assets/*', serveStatic({ root: relativeRoot(webDist) }));
    const index = readFileSync(join(webDist, 'index.html'), 'utf8');
    app.get('*', (c) => c.html(index));
  }
  serve({ fetch: app.fetch, port: env.PORT }, (info) => console.log(`rootline listening on http://localhost:${info.port}`));
}

function relativeRoot(abs: string): string {
  return abs.startsWith(process.cwd()) ? abs.slice(process.cwd().length + 1) || '.' : abs;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
