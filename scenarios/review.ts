#!/usr/bin/env node
/**
 * Evidence-sufficiency review: for every world, run each labeled piece of required evidence
 * through the real tool runner, with faults off and with the world's fault profile on (as an
 * agent would meet it), and report what came back. Output: a Markdown table on stdout.
 *
 *   npx tsx scenarios/review.ts > /tmp/review.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Label } from '../eval/label-schema.js';
import { openDb, type Db } from '../src/db/client.js';
import { ensureWorlds } from '../src/db/bootstrap.js';
import { readFaults, readIndex } from '../src/db/fixtures.js';
import { EvidenceLedger } from '../src/engine/ledger.js';
import { CHANGE_RETENTION_MS } from '../src/tools/get-changes.js';
import { FaultInjector } from '../src/tools/faults.js';
import { createToolContext } from '../src/tools/registry.js';
import { ToolRunner, type ToolCallResult } from '../src/tools/runner.js';
import { projectRoot } from '../src/util/paths.js';

export interface ReviewRow {
  key: string;
  evidence: string;
  tool: string;
  off: { status: string; records: number; containsHit: boolean | null };
  on: { status: string; records: number; attempts: number; error: string | null };
}

const DAY = 86_400_000;

export function paramsFor(match: Label['requiredEvidence'][number]['match'], dataFrom: string, dataTo: string): Record<string, unknown> {
  const to = dataTo;
  const from = new Date(Math.max(Date.parse(dataFrom), Date.parse(dataTo) - DAY + 60_000)).toISOString();
  switch (match.tool) {
    case 'query_logs':
      return { services: [match.service], from, to, ...(match.contains ? { contains: match.contains } : {}), limit: 100 };
    case 'query_metrics':
      return { service: match.service, metric: match.metric, from, to };
    case 'get_changes':
      return { services: [match.service], from: new Date(Date.parse(dataTo) - CHANGE_RETENTION_MS + 60_000).toISOString(), to };
    case 'search_incidents':
      return { services: [match.service], text: match.contains };
    default:
      return { service: match.service };
  }
}

function hit(res: ToolCallResult, contains: string | undefined): boolean | null {
  if (!contains) return null;
  return JSON.stringify(res.envelope.records).toLowerCase().includes(contains.toLowerCase());
}

export async function reviewWorlds(db: Db, keys?: string[]): Promise<ReviewRow[]> {
  const index = readIndex();
  const rows: ReviewRow[] = [];
  const entries = index.worlds.filter((w) => !keys || keys.includes(w.key));
  await ensureWorlds(db, entries.map((e) => e.worldId));
  for (const w of entries) {
    const label = Label.parse(JSON.parse(readFileSync(join(projectRoot(), 'eval', 'labels', `${w.key}.json`), 'utf8')));
    const ctx = await createToolContext(db, w.worldId);
    const fast = { deadlineMs: 150, maxRetries: 2, backoffBaseMs: 1 };
    const off = new ToolRunner(ctx, new FaultInjector({ seed: 'off', latency: { minMs: 0, maxMs: 0 }, transient: [], rules: [] }), new EvidenceLedger(), fast);
    const profile = readFaults(w.worldId);
    const on = new ToolRunner(ctx, new FaultInjector({ ...profile, latency: { minMs: 0, maxMs: 0 } }), new EvidenceLedger(), fast);
    // Probe each scripted fault rule with a request it matches, faults on.
    for (const rule of profile.rules) {
      const svc = rule.match.servicesAny?.[0];
      const metric = rule.match.metricsAny?.[0] ?? (svc ? ctx.services.get(svc)?.metrics[0]?.name : undefined);
      const span = { from: new Date(Date.parse(ctx.world.dataTo) - 3 * 3_600_000).toISOString(), to: ctx.world.dataTo };
      const params =
        rule.tool === 'query_metrics'
          ? { service: svc, metric, ...span }
          : rule.tool === 'query_logs'
            ? { services: [svc], ...span, ...(rule.match.textAny ? { contains: rule.match.textAny[0] } : {}) }
            : { ...span };
      const b = await on.call(rule.tool, params, { taskId: null, agent: 'review' }, new AbortController().signal);
      rows.push({
        key: w.key,
        evidence: `scripted fault "${rule.id}"`,
        tool: `${rule.tool}(${svc ?? ''}${rule.tool === 'query_metrics' && metric ? `/${metric}` : ''}${rule.match.textAny ? ` "${rule.match.textAny[0]}"` : ''})`,
        off: { status: '-', records: 0, containsHit: null },
        on: { status: b.envelope.status, records: b.envelope.records.length, attempts: b.attempts.length, error: b.envelope.error?.code ?? null },
      });
    }
    for (const ev of label.requiredEvidence) {
      const params = paramsFor(ev.match, ctx.world.dataFrom, ctx.world.dataTo);
      const meta = { taskId: null, agent: 'review' };
      const signal = new AbortController().signal;
      const a = await off.call(ev.match.tool, params, meta, signal);
      const b = await on.call(ev.match.tool, params, meta, signal);
      rows.push({
        key: w.key,
        evidence: ev.description,
        tool: `${ev.match.tool}(${ev.match.service ?? ''}${ev.match.metric ? `/${ev.match.metric}` : ''}${ev.match.contains ? ` "${ev.match.contains}"` : ''})`,
        off: { status: a.envelope.status, records: a.envelope.records.length, containsHit: hit(a, ev.match.contains) },
        on: { status: b.envelope.status, records: b.envelope.records.length, attempts: b.attempts.length, error: b.envelope.error?.code ?? null },
      });
    }
  }
  return rows;
}

async function main() {
  const db = await openDb();
  const rows = await reviewWorlds(db);
  console.log('| World | Required evidence | Tool call | Faults off | As agents meet it (faults on) |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const off = r.off.status === '-' ? '-' : `${r.off.status}, ${r.off.records} records${r.off.containsHit === null ? '' : r.off.containsHit ? ', match' : ', NO MATCH'}`;
    const on = r.on.error ? `**${r.on.error}** after ${r.on.attempts} attempt(s)` : `${r.on.status}, ${r.on.records} records${r.on.attempts > 1 ? ` (${r.on.attempts} attempts)` : ''}`;
    console.log(`| ${r.key} | ${r.evidence} | \`${r.tool}\` | ${off} | ${on} |`);
  }
  await db.close();
}

if (process.argv[1] && /review\.ts$/.test(process.argv[1])) main();
