#!/usr/bin/env node
/**
 * Freeze prompts and pick arm D's base from the dev runs (rule in eval/results/plan.json):
 * whichever of A and B earns more on the dev scenarios (root-cause credit + correct abstentions);
 * tie -> lower mean estimated cost per run. Writes eval/results/freeze.json.
 *
 *   npx tsx eval/freeze.ts
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptHash } from '../src/agents/prompts.js';
import { readRunFiles, runFileName } from './runner.js';
import { scoreRun } from './score.js';
import { RESULTS_DIR } from './summarize.js';

function main() {
  const out = join(RESULTS_DIR, 'freeze.json');
  if (existsSync(out)) throw new Error('freeze.json already exists; the freeze happens once');
  const hash = promptHash();
  const dev = readRunFiles().filter((f) => f.environment.promptHash === hash);
  const tally = (arm: 'A' | 'B') => {
    const runs = dev.filter((f) => f.job.arm === arm);
    const scores = runs.map((f) => scoreRun(f, runFileName(f.job))).filter((s) => s.split === 'dev');
    const earned = scores.reduce((n, s) => n + (s.rootCauseCredit ?? 0) + (s.correctAbstention ? 1 : 0), 0);
    const cost = runs.reduce((n, f) => n + (f.metrics?.costUsd.total ?? 0), 0) / Math.max(1, runs.length);
    return { arm, runs: scores.length, earned, meanCostUsd: Math.round(cost * 1000) / 1000 };
  };
  const a = tally('A');
  const b = tally('B');
  const base = a.earned > b.earned ? 'A' : b.earned > a.earned ? 'B' : a.meanCostUsd <= b.meanCostUsd ? 'A' : 'B';
  const gitSha = execSync('git rev-parse --short HEAD').toString().trim();
  const freeze = {
    promptHash: hash,
    frozenAt: new Date().toISOString(),
    gitSha,
    armDBase: base,
    devTally: { A: a, B: b },
    note: `Prompts frozen after the dev phase. Arm D base picked by the rule in plan.json: A earned ${a.earned}/${a.runs}, B earned ${b.earned}/${b.runs} on dev scenarios${a.earned === b.earned ? `; tie broken by mean cost ($${a.meanCostUsd} vs $${b.meanCostUsd})` : ''}.`,
  };
  writeFileSync(out, JSON.stringify(freeze, null, 2) + '\n');
  console.error(freeze.note);
}

main();
