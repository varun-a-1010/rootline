import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { ArmId, type RunEvent } from '../contracts/events.js';
import type { Db } from '../db/client.js';
import { readIndex } from '../db/fixtures.js';
import { listIncidents } from '../db/queries.js';
import { fold } from '../engine/run-state.js';
import { listRuns } from '../engine/persistence.js';
import { flowNodes, flowReplay } from '../flow/agentflow.js';
import { orchestrations } from '../orchestrations/registry.js';
import { projectRoot } from '../util/paths.js';
import type { RunLimiter } from './limits.js';
import type { RunManager } from './runs.js';

export interface AppDeps {
  db: Db;
  runs: RunManager;
  limiter: RunLimiter;
  accessCode?: string;
  flowViewerUrl: string;
  /** Root for eval/ (tests can point elsewhere). */
  root?: string;
}

const StartRun = z
  .object({ worldId: z.string().regex(/^w_[0-9a-f]{8}$/).optional(), incidentId: z.string().max(40).optional(), arm: ArmId, accessCode: z.string().max(200).optional() })
  .refine((b) => b.worldId || b.incidentId, 'worldId or incidentId is required');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(d: AppDeps): Hono {
  const root = d.root ?? projectRoot();
  const app = new Hono();
  const evalRunsDir = join(root, 'eval', 'runs');

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/api/config', (c) =>
    c.json({
      accessCodeRequired: !!d.accessCode,
      flowViewerUrl: d.flowViewerUrl,
      arms: orchestrations().map((o) => ({ id: o.id, title: o.title, description: o.description })),
    }),
  );

  app.get('/api/incidents', async (c) => {
    const incidents = await listIncidents(d.db);
    const index = new Map(readIndex().worlds.map((w) => [w.worldId, w]));
    return c.json(
      incidents
        .map((i) => ({ worldId: i.worldId, key: index.get(i.worldId)?.key ?? null, split: index.get(i.worldId)?.split ?? null, incident: i.incident }))
        .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '')),
    );
  });

  app.post('/api/runs', async (c) => {
    const body = StartRun.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'expected { incidentId | worldId, arm, accessCode? }' }, 400);
    if (d.accessCode && !safeEqual(body.data.accessCode ?? '', d.accessCode)) return c.json({ error: 'a valid access code is required to start live runs' }, 403);
    const why = d.runs.canRun(body.data.arm);
    if (why) return c.json({ error: why }, 503);
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';
    const refused = d.limiter.take(ip);
    if (refused) return c.json({ error: refused }, 429);
    let worldId = body.data.worldId;
    if (!worldId) worldId = (await listIncidents(d.db)).find((i) => i.incident.incidentId === body.data.incidentId)?.worldId;
    if (!worldId) return c.json({ error: 'unknown incident' }, 404);
    const runId = d.runs.start(worldId, body.data.arm);
    return c.json({ runId }, 202);
  });

  app.get('/api/runs', async (c) => c.json(await listRuns(d.db, 50)));

  app.get('/api/runs/:id', async (c) => {
    const events = await d.runs.events(c.req.param('id'));
    if (events.length === 0) return c.json({ error: 'run not found' }, 404);
    return c.json({ live: d.runs.isLive(c.req.param('id')), state: fold(events) });
  });

  app.get('/api/runs/:id/flow', async (c) => {
    const events = await d.runs.events(c.req.param('id'));
    if (events.length === 0) return c.json({ error: 'run not found' }, 404);
    const live = d.runs.isLive(c.req.param('id'));
    return c.json(live ? { live, nodes: flowNodes(events) } : { live, nodes: flowNodes(events), replay: flowReplay(events) });
  });

  app.get('/api/runs/:id/events', async (c) => {
    const id = c.req.param('id');
    const after = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = d.runs.subscribe(id, (e) => {
        queue.push(e);
        wake?.();
      });
      let last = after;
      for (const e of await d.runs.events(id, after)) {
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
        last = e.seq;
      }
      if (!unsub) {
        await stream.writeSSE({ event: 'end', data: '{}' });
        return;
      }
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      for (;;) {
        while (queue.length) {
          const e = queue.shift()!;
          if (e.seq === -1) {
            unsub();
            await stream.writeSSE({ event: 'end', data: '{}' });
            return;
          }
          if (e.seq <= last) continue;
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
          last = e.seq;
        }
        if (stream.aborted) return;
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 15_000);
        });
        wake = null;
        if (!queue.length) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    });
  });

  app.post('/api/runs/:id/cancel', (c) => (d.runs.cancel(c.req.param('id')) ? c.json({ cancelled: true }) : c.json({ error: 'run is not live' }, 404)));

  // ---------------------------------------------------------------- recorded evaluation
  app.get('/api/eval/summary', (c) => {
    const p = join(root, 'eval', 'results', 'summary.json');
    if (!existsSync(p)) return c.json({ error: 'no evaluation summary yet' }, 404);
    return c.body(readFileSync(p, 'utf8'), 200, { 'content-type': 'application/json' });
  });

  const listCache = { mtime: 0, rows: [] as unknown[] };
  app.get('/api/eval/runs', (c) => {
    if (!existsSync(evalRunsDir)) return c.json([]);
    const mtime = statSync(evalRunsDir).mtimeMs;
    if (mtime !== listCache.mtime) {
      listCache.rows = readdirSync(evalRunsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
          const r = JSON.parse(readFileSync(join(evalRunsDir, f), 'utf8'));
          return { file: f, job: r.job, status: r.status, promptHash: r.environment?.promptHash, outcome: r.metrics?.outcome ?? null, stopReason: r.metrics?.stopReason ?? null, latencyMs: r.metrics?.latencyMs ?? null, toolCalls: r.metrics?.toolCalls ?? null, costUsd: r.metrics?.costUsd?.total ?? null };
        });
      listCache.mtime = mtime;
    }
    return c.json(listCache.rows);
  });

  const evalFile = (name: string) => {
    if (!/^[\w.-]+\.json$/.test(name)) return null;
    const p = join(evalRunsDir, name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { events: RunEvent[]; [k: string]: unknown }) : null;
  };
  app.get('/api/eval/runs/:file', (c) => {
    const r = evalFile(c.req.param('file'));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json({ ...r, state: fold(r.events) });
  });
  app.get('/api/eval/runs/:file/flow', (c) => {
    const r = evalFile(c.req.param('file'));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json({ live: false, nodes: flowNodes(r.events), replay: flowReplay(r.events) });
  });

  // ---------------------------------------------------------------- downloads and docs
  let zipCache: Uint8Array | null = null;
  app.get('/downloads/fixtures-v1.zip', (c) => {
    zipCache ??= buildFixtureZip(root);
    return c.body(zipCache as unknown as ArrayBuffer, 200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="rootline-fixtures-v1.zip"' });
  });
  app.get('/docs/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[\w-]+\.md$/.test(name)) return c.text('not found', 404);
    const p = join(root, 'docs', name);
    return existsSync(p) ? c.text(readFileSync(p, 'utf8')) : c.text('not found', 404);
  });

  return app;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The synthetic corpus plus evaluator-only labels and fault profiles, clearly separated. */
export function buildFixtureZip(root: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'README.txt': strToU8(
      [
        'Rootline synthetic incident corpus (fixtures v1). Everything here is invented.',
        '',
        'fixtures/v1/            the worlds the agents query (world.json, logs.jsonl.gz, metrics.jsonl.gz)',
        '                        faults.json in each world is read only by the fault-injection layer',
        'evaluator-only/labels/  answer keys. Never loaded into any database or reachable through a tool.',
        '',
        'Separation is an access control on the tool surface, not secrecy: labels ship so results can be audited.',
        'Regenerate byte-for-byte with: npm run fixtures:generate (check with npm run fixtures:check).',
      ].join('\n'),
    ),
  };
  for (const p of walk(join(root, 'fixtures', 'v1'))) files[relative(root, p)] = readFileSync(p);
  const labels = join(root, 'eval', 'labels');
  if (existsSync(labels)) for (const p of walk(labels)) files[`evaluator-only/labels/${relative(labels, p)}`] = readFileSync(p);
  return zipSync(files, { level: 0 });
}
