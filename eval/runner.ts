#!/usr/bin/env node
/**
 * Evaluation runner. Resumable: a run whose file already exists is skipped; crashed runs are
 * recorded as crashed and never silently rerun. Concurrency <= ROOTLINE_EVAL_CONCURRENCY.
 * Spending stops before ROOTLINE_EVAL_MAX_USD is exceeded (estimated from recorded usage).
 *
 *   doppler run -p shared -c dev_mac -- npm run eval -- --scenarios s01,s02 --variants A --arms A,E [--reps 1]
 *   ... --phase dev-smoke | --plan eval/results/plan.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import type { ArmId, RunEvent } from '../src/contracts/events.js';
import { loadEnv } from '../src/config.js';
import { ensureWorlds, readManifest } from '../src/db/bootstrap.js';
import { openDb } from '../src/db/client.js';
import { readIndex } from '../src/db/fixtures.js';
import { promptHash } from '../src/agents/prompts.js';
import { runInvestigation, settingsFromEnv } from '../src/engine/run.js';
import { createLiveProviders } from '../src/llm/factory.js';
import '../src/orchestrations/all.js';
import { projectRoot } from '../src/util/paths.js';
import { computeMetrics, type RunMetrics } from './metrics.js';

export const RUNS_DIR = join(projectRoot(), 'eval', 'runs');
/** Runs replaced after an engine bug: kept and counted in spend, never scored. */
export const SUPERSEDED_DIR = join(projectRoot(), 'eval', 'runs-superseded');

export interface Job {
  key: string; // s01-A
  arm: ArmId;
  rep: number;
  armBase?: 'A' | 'B';
}

export interface RunFile {
  schema: 'rootline.eval-run.v1';
  job: Job;
  worldId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'crashed';
  error: string | null;
  startedAt: string;
  endedAt: string;
  environment: {
    model: string;
    jevModel: string | null;
    thinkingLevel: string;
    budgets: Record<string, number>;
    promptHash: string;
    fixtureCorpusSha256: string | null;
    gitSha: string | null;
    node: string;
    machine: string;
  };
  metrics: RunMetrics | null;
  report: unknown;
  events: RunEvent[];
}

function runsDirFromArgs(): string {
  const i = process.argv.indexOf('--runs-dir');
  return i >= 0 ? process.argv[i + 1]! : RUNS_DIR;
}

export function runFileName(j: Job): string {
  return `${j.key}-${j.arm}-r${j.rep}.json`;
}

export function readRunFiles(dir = RUNS_DIR): RunFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunFile);
}

export function spentUsd(files: RunFile[]): number {
  return files.reduce((s, f) => s + (f.metrics?.costUsd.total ?? 0), 0);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function expandJobs(scenarios: string[], variants: string[], arms: ArmId[], reps: number, armBase?: 'A' | 'B'): Job[] {
  const jobs: Job[] = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const s of scenarios)
      for (const v of variants)
        for (const arm of arms) jobs.push({ key: `${s}-${v}`, arm, rep, ...(arm === 'D' ? { armBase: armBase ?? 'A' } : {}) });
  return jobs;
}

async function main() {
  const env = loadEnv();
  const maxUsd = Number(arg('max-usd') ?? env.ROOTLINE_EVAL_MAX_USD);
  const concurrency = Number(arg('concurrency') ?? env.ROOTLINE_EVAL_CONCURRENCY);
  let jobs: Job[];
  const planPath = arg('plan');
  if (planPath) {
    jobs = (JSON.parse(readFileSync(planPath, 'utf8')) as { jobs: Job[] }).jobs;
  } else {
    const scenarios = (arg('scenarios') ?? '').split(',').filter(Boolean);
    const variants = (arg('variants') ?? 'A').split(',');
    const arms = (arg('arms') ?? 'A,E').split(',') as ArmId[];
    jobs = expandJobs(scenarios, variants, arms, Number(arg('reps') ?? 1), (arg('base') as 'A' | 'B' | undefined) ?? undefined);
  }
  if (jobs.length === 0) throw new Error('no jobs: pass --scenarios/--variants/--arms or --plan');
  const { llm, jev, problems } = createLiveProviders(env);
  if (!llm) throw new Error(problems.join('; '));
  if (jobs.some((j) => j.arm === 'D') && !jev) throw new Error('arm D needs OPENROUTER_API_KEY');

  const runsDir = runsDirFromArgs();
  mkdirSync(runsDir, { recursive: true });
  const index = readIndex();
  const manifest = readManifest();
  const pending = jobs.filter((j) => !existsSync(join(runsDir, runFileName(j))));
  console.error(`${jobs.length} jobs, ${jobs.length - pending.length} already recorded, ${pending.length} to run; budget $${maxUsd}, concurrency ${concurrency}`);
  const db = await openDb({ dataDir: env.ROOTLINE_DATA_DIR });
  const worldIds = [...new Set(pending.map((j) => index.worlds.find((w) => w.key === j.key)?.worldId))].filter((x): x is string => !!x);
  await ensureWorlds(db, worldIds, (m) => console.error(m));
  const settings = settingsFromEnv(env);
  const machine = `${platform()} ${release()} ${cpus()[0]?.model ?? ''} x${cpus().length}`;

  let spent = spentUsd(readRunFiles()) + spentUsd(readRunFiles(SUPERSEDED_DIR)) + (runsDir === RUNS_DIR ? 0 : spentUsd(readRunFiles(runsDir)));
  let inflight = 0;
  let stopped = false;
  const queue = [...pending];
  const worker = async () => {
    while (queue.length && !stopped) {
      // Reserve an estimate for in-flight runs so concurrency cannot overshoot the cap.
      const perRun = Math.max(0.5, spent / Math.max(1, readRunFiles().filter((f) => f.metrics?.costUsd.total).length));
      if (spent + (inflight + 1) * perRun > maxUsd) {
        stopped = true;
        console.error(`budget: $${spent.toFixed(2)} spent + ${inflight + 1} x ~$${perRun.toFixed(2)} would exceed $${maxUsd}; stopping`);
        break;
      }
      const job = queue.shift()!;
      const entry = index.worlds.find((w) => w.key === job.key);
      if (!entry) throw new Error(`unknown scenario key ${job.key}`);
      inflight++;
      const started = new Date();
      let file: RunFile;
      try {
        const res = await runInvestigation({ db, worldId: entry.worldId, arm: job.arm, armBase: job.armBase, llm, jev, settings });
        const metrics = computeMetrics(res.events, res.state);
        file = {
          schema: 'rootline.eval-run.v1',
          job,
          worldId: entry.worldId,
          status: res.state.status === 'running' ? 'failed' : res.state.status,
          error: null,
          startedAt: started.toISOString(),
          endedAt: new Date().toISOString(),
          environment: env_(res.state.config, manifest?.corpusSha256 ?? null, machine),
          metrics,
          report: res.report,
          events: res.events,
        };
      } catch (e) {
        file = {
          schema: 'rootline.eval-run.v1',
          job,
          worldId: entry.worldId,
          status: 'crashed',
          error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}`.slice(0, 4000) : String(e),
          startedAt: started.toISOString(),
          endedAt: new Date().toISOString(),
          environment: env_(null, manifest?.corpusSha256 ?? null, machine, settings, llm.model),
          metrics: null,
          report: null,
          events: [],
        };
      }
      inflight--;
      writeFileSync(join(runsDir, runFileName(job)), JSON.stringify(file) + '\n');
      spent += file.metrics?.costUsd.total ?? 0;
      const m = file.metrics;
      console.error(
        `${runFileName(job).padEnd(18)} ${file.status.padEnd(9)} ${m ? `${m.outcome}/${m.stopReason} tools=${m.toolCalls} llm=${m.llmCalls} in=${m.tokens.input} out=${m.tokens.output} th=${m.tokens.thinking} $${m.costUsd.total?.toFixed(3)} ${((m.latencyMs ?? 0) / 1000).toFixed(0)}s` : file.error?.split('\n')[0]}  | spent $${spent.toFixed(2)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await db.close();
  console.error(`done. total estimated spend across recorded runs: $${spentUsd(readRunFiles()).toFixed(2)}`);
}

function env_(config: import('../src/contracts/events.js').RunConfig | null, corpus: string | null, machine: string, settings?: import('../src/engine/run.js').EngineSettings, model?: string): RunFile['environment'] {
  return {
    model: config?.model ?? model ?? 'unknown',
    jevModel: config?.jevModel ?? null,
    thinkingLevel: config?.thinkingLevel ?? settings?.thinkingLevel ?? 'unknown',
    budgets: (config?.budgets as unknown as Record<string, number>) ?? (settings as unknown as Record<string, number>) ?? {},
    promptHash: config?.promptHash ?? promptHash(),
    fixtureCorpusSha256: corpus,
    gitSha: config?.gitSha ?? null,
    node: process.version,
    machine,
  };
}

if (process.argv[1] && /runner\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
