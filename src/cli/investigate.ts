#!/usr/bin/env node
/**
 * Run one investigation from the command line with a live trace.
 *
 *   doppler run -p shared -c dev_mac -- npm run investigate -- --scenario s01 --arm A
 *   npm run investigate -- --world <world id or incident id> --arm E --out run.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArmId, RunEvent } from '../contracts/events.js';
import { loadEnv } from '../config.js';
import { ensureWorlds } from '../db/bootstrap.js';
import { openDb } from '../db/client.js';
import { DbRunStore } from '../engine/persistence.js';
import { runInvestigation, settingsFromEnv } from '../engine/run.js';
import { createLiveProviders } from '../llm/factory.js';
import { costUsd } from '../llm/pricing.js';
import { addUsage, ZERO_USAGE } from '../llm/types.js';
import '../orchestrations/all.js';
import { projectRoot } from '../util/paths.js';
import { resolveWorld } from './tool.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const t0 = Date.now();
const clock = (ts: number) => `+${((ts - t0) / 1000).toFixed(1).padStart(6)}s`;

export function traceLine(e: RunEvent): string | null {
  const p = e.payload as Record<string, any>;
  const tag = e.taskId ? `[${e.taskId}]` : '';
  switch (e.type) {
    case 'run.created':
      return `run ${p.runId} arm ${p.config.arm} on ${p.incident.incidentId}: ${p.incident.title}`;
    case 'candidates.proposed':
      return `${tag} candidates: ${p.candidates.map((c: any) => `${c.id} ${c.component}/${c.causeType}`).join(' | ')}`;
    case 'plan.validated':
      return `${tag} plan: ${p.tasks.map((t: any) => `${t.id} ${t.role}: ${t.question}`).join('\n          ')}`;
    case 'plan.rejected':
      return `${tag} plan rejected: ${p.errors.join('; ')}`;
    case 'plan.fallback':
      return `${tag} plan fallback: ${p.reason}`;
    case 'task.started':
      return `${tag} start ${p.role}${p.attempt > 1 ? ` (attempt ${p.attempt})` : ''}`;
    case 'task.completed':
      return `${tag} done ${p.role}${p.hadGaps ? ' (with gaps)' : ''}: ${String(p.summary).slice(0, 180)}`;
    case 'task.failed':
      return `${tag} FAILED ${p.role}: ${p.error}`;
    case 'tool.result':
      return `${tag}   ${p.caption} -> ${p.status}${p.evidenceId ? ` ${p.evidenceId}` : ''} (${p.recordCount} rec${p.attempts > 1 ? `, ${p.attempts} attempts` : ''}${p.error ? `, ${p.error.code}` : ''})`;
    case 'citation.invalid':
      return `${tag}   citation invalid (${p.agent}): ${p.evidenceId || '(none)'} — ${p.context}`;
    case 'hypotheses.updated':
      return `${tag} hypotheses v${p.version}: ${p.hypotheses.map((h: any) => `${h.id} ${h.component}/${h.causeType} c=${h.confidence}`).join(' | ')}${p.dropped.length ? ` (dropped ${p.dropped.map((d: any) => d.id).join(',')})` : ''}`;
    case 'critic.checks':
      return `${tag} critic checks: ${p.checks.map((c: any) => `${c.check}=${c.status}`).join(' ')}`;
    case 'critic.decided':
      return `${tag} CRITIC ${p.decision.toUpperCase()}: ${p.rationale.slice(0, 220)}`;
    case 'followup.scheduled':
      return `${tag}   follow-up -> ${p.taskId}: ${p.followUp.role} ${p.followUp.tool} (${p.followUp.purpose.slice(0, 120)})`;
    case 'followup.rejected':
      return `${tag}   follow-up rejected: ${p.followUp.tool} — ${p.reason}`;
    case 'jev.decision':
      return `${tag}   jev ${p.kind}: ${p.summary}`;
    case 'budget.exhausted':
      return `budget exhausted: ${p.budget} (${p.used}/${p.limit})`;
    case 'report.ready':
      return `report: ${p.report.outcome} (${p.report.generatedBy}); top: ${p.report.hypotheses[0] ? `${p.report.hypotheses[0].component}/${p.report.hypotheses[0].causeType}` : 'none'}`;
    case 'run.terminated':
      return `terminated: ${p.status}, stop=${p.stopReason}, outcome=${p.outcome}`;
    default:
      return null;
  }
}

async function main() {
  const env = loadEnv();
  const arm = (arg('arm') ?? 'A') as ArmId;
  const scenario = arg('scenario');
  const ref = arg('world') ?? (scenario ? `${scenario}-${arg('variant') ?? 'A'}` : undefined);
  if (!ref) {
    console.error('usage: npm run investigate -- --scenario <sNN> [--variant A|B] --arm A|B|C|D|E [--out file.json]');
    process.exit(2);
  }
  const worldId = resolveWorld(ref);
  const { llm, jev, problems } = createLiveProviders(env);
  if (!llm) throw new Error(problems.join('; '));
  if (arm === 'D' && !jev) throw new Error('arm D needs Jev: set OPENROUTER_API_KEY');
  const db = await openDb(env.DATABASE_URL ? { url: env.DATABASE_URL } : { dataDir: env.ROOTLINE_DATA_DIR });
  if (!env.DATABASE_URL) await ensureWorlds(db, [worldId], (m) => console.error(m));
  const store = new DbRunStore(db);
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const res = await runInvestigation({
    db,
    worldId,
    arm,
    armBase: (arg('base') as 'A' | 'B' | undefined) ?? 'A',
    llm,
    jev,
    settings: settingsFromEnv(env),
    store,
    signal: ac.signal,
    onEvent: (e) => {
      const line = traceLine(e);
      if (line) console.error(`${clock(e.ts)} ${line}`);
    },
  });
  const usage = res.state.llmCalls.filter((c) => c.status === 'ok').reduce((u, c) => (c.usage ? addUsage(u, c.usage) : u), ZERO_USAGE);
  const cost = costUsd(llm.model, usage);
  console.error(
    `\ntool calls ${res.state.toolResults.length} (attempts ${res.state.attempts.length}), model calls ${res.state.llmCalls.filter((c) => c.attempt === 1).length}, tokens in ${usage.input} out ${usage.output} thinking ${usage.thinking} cached ${usage.cached}, est. $${cost?.toFixed(4) ?? '?'}, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  const out = arg('out') ?? join(projectRoot(), '.data', 'runs', `${res.runId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ runId: res.runId, worldId, arm, report: res.report, events: res.events }, null, 1));
  console.error(`events + report written to ${out}`);
  console.log(res.state.markdown);
  await db.close();
}

if (process.argv[1] && /investigate\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
