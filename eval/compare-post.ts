#!/usr/bin/env node
/**
 * Compare the evaluated code with the post-evaluation runs on the same dev scenarios. Writes
 * eval/results/post-evaluation.{json,md}. Generated, never hand-edited.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../src/util/paths.js';
import { readRunFiles, runFileName, RUNS_DIR, type RunFile } from './runner.js';
import { scoreRun } from './score.js';
import { RESULTS_DIR } from './summarize.js';

const KEYS = ['s01-A', 's04-A', 's12-A', 's13-A'];
const post = (d: string) => join(projectRoot(), 'eval', 'runs-post', d);
const groups: Array<[string, string, string, string]> = [
  ['Evaluated, 3.8 Flash', 'A', RUNS_DIR, 'A'],
  ['Final code, 3.8 Flash', 'A', post('final-code'), 'A'],
  ['Flash-Lite', 'A', post('flash-lite'), 'A'],
  ['Evaluated, 3.8 Flash', 'E', RUNS_DIR, 'E'],
  ['Flash-Lite', 'E', post('flash-lite'), 'E'],
];
const rows = groups.map(([name, label, dir, arm]) => {
  const fs: RunFile[] = readRunFiles(dir).filter((f) => KEYS.includes(f.job.key) && f.job.arm === arm);
  const scores = fs.map((f) => scoreRun(f, runFileName(f.job)));
  const avg = (g: (f: RunFile) => number) => fs.reduce((n, f) => n + g(f), 0) / fs.length;
  const concl = scores.filter((s) => s.expectedOutcome === 'conclusive');
  const input = avg((f) => f.metrics!.tokens.input ?? 0);
  return {
    name,
    arm: label,
    runs: fs.length,
    rootCause: `${concl.reduce((n, s) => n + (s.rootCauseCredit ?? 0), 0)} / ${concl.length}`,
    s12: scores.find((s) => s.key === 's12-A')?.correctAbstention ? 'abstained' : 'diagnosed',
    recall: Math.round((scores.reduce((n, s) => n + (s.requiredEvidence.recall ?? 0), 0) / scores.length) * 100),
    toolCalls: Math.round(avg((f) => f.metrics!.toolCalls) * 10) / 10,
    latencyS: Math.round(avg((f) => (f.metrics!.latencyMs ?? 0) / 1000)),
    inputTokens: Math.round(input),
    cachedPct: Math.round((avg((f) => f.metrics!.tokens.cached ?? 0) / input) * 100),
    costUsd: Math.round(avg((f) => f.metrics!.costUsd.total ?? 0) * 1000) / 1000,
    cases: scores.map((s) => ({ key: s.key, credit: s.rootCauseCredit, outcome: s.outcome, top: s.top })),
  };
});
writeFileSync(join(RESULTS_DIR, 'post-evaluation.json'), JSON.stringify({ scenarios: KEYS, rows }, null, 2) + '\n');
const md = [
  '| Configuration | Arm | Root cause | s12-A | Evidence recall | Tool calls | Latency | Input tokens | Cached | Est. cost per run |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.name} | ${r.arm} | ${r.rootCause} | ${r.s12} | ${r.recall}% | ${r.toolCalls} | ${r.latencyS} s | ${r.inputTokens} | ${r.cachedPct}% | $${r.costUsd} |`),
].join('\n');
writeFileSync(join(RESULTS_DIR, 'post-evaluation.md'), md + '\n');
console.log(md);
