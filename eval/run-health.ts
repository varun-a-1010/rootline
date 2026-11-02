#!/usr/bin/env node
/**
 * How the evaluation ran, from the recorded runs: reliability by concurrency period, failed runs,
 * where the money went, which calls were cached and how runs on inconclusive scenarios ended.
 * Writes eval/results/run-health.{json,md}. Generated, never hand-edited.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from '../src/llm/types.js';
import { costUsd } from '../src/llm/pricing.js';
import { readRunFiles, runFileName, type RunFile } from './runner.js';
import { scoreRun, type CaseScore } from './score.js';
import { RESULTS_DIR } from './summarize.js';

/** The last 58 runs were launched from this commit, with --concurrency 4; all others with 2. */
const CONCURRENCY_4_COMMIT = 'b2f6623';
const HANG_MS = 85_000;
const ARMS = ['A', 'B', 'C', 'D', 'E'];

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);

interface LlmCall {
  role: string;
  status: string;
  errorKind: string | null;
  latencyMs: number;
  usage: TokenUsage | null;
}

const files = readRunFiles();
const model = files[0]!.environment.model;
const llmCalls = (f: RunFile) => f.events.filter((e) => e.type === 'llm.call').map((e) => e.payload as unknown as LlmCall);
const scores = new Map<RunFile, CaseScore>(files.map((f) => [f, scoreRun(f, runFileName(f.job))]));
const concurrencyOf = (f: RunFile) => (f.environment.gitSha === CONCURRENCY_4_COMMIT ? 4 : 2);
const runName = (f: RunFile) => `${f.job.key}-${f.job.arm}`;

const concurrency = [2, 4].map((level) => {
  const fs = files.filter((f) => concurrencyOf(f) === level);
  const errors = fs.flatMap(llmCalls).filter((c) => c.status === 'error');
  const failed = fs.filter((f) => f.status !== 'completed').length;
  return {
    concurrency: level,
    runs: fs.length,
    arms: ARMS.filter((a) => fs.some((f) => f.job.arm === a)),
    failed,
    failedPct: pct(failed, fs.length),
    rateLimitErrors: errors.filter((c) => c.errorKind === 'rate_limited').length,
    hungRequests: errors.filter((c) => c.errorKind === 'network' && c.latencyMs >= HANG_MS).length,
    otherErrors: errors.filter((c) => c.errorKind !== 'rate_limited' && !(c.errorKind === 'network' && c.latencyMs >= HANG_MS)).length,
  };
});

const failures = files
  .filter((f) => f.status !== 'completed')
  .map((f) => {
    const errors = llmCalls(f).filter((c) => c.status === 'error');
    return {
      run: runName(f),
      arm: f.job.arm,
      concurrency: concurrencyOf(f),
      stopReason: scores.get(f)!.stopReason,
      reportBuiltBy: (f.report as { generatedBy?: string } | null)?.generatedBy ?? null,
      failedTasks: f.events.filter((e) => e.type === 'task.failed').map((e) => (e.payload as { role?: string }).role ?? null),
      errors: errors.map((c) => `${c.role}: ${c.errorKind}`),
      toolCalls: f.metrics!.toolCalls,
    };
  });

const cost = Object.fromEntries(
  ARMS.map((arm) => {
    const fs = files.filter((f) => f.job.arm === arm);
    const mean = (g: (f: RunFile) => number) => fs.reduce((n, f) => n + g(f), 0) / fs.length;
    const zero = { input: 0, output: 0, thinking: 0, cached: 0 };
    const parts = {
      freshInput: mean((f) => costUsd(model, { ...zero, input: (f.metrics!.tokens.input ?? 0) - (f.metrics!.tokens.cached ?? 0) })!),
      cachedInput: mean((f) => costUsd(model, { ...zero, input: f.metrics!.tokens.cached ?? 0, cached: f.metrics!.tokens.cached ?? 0 })!),
      answer: mean((f) => costUsd(model, { ...zero, output: f.metrics!.tokens.output ?? 0 })!),
      thinking: mean((f) => costUsd(model, { ...zero, thinking: f.metrics!.tokens.thinking ?? 0 })!),
      jev: mean((f) => f.metrics!.costUsd.jev ?? 0),
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    const completed = fs.filter((f) => f.status === 'completed');
    const byRole: Record<string, number> = {};
    for (const f of fs) for (const [role, u] of Object.entries(f.metrics!.tokensByRole)) byRole[role] = (byRole[role] ?? 0) + (costUsd(model, u) ?? 0) / fs.length;
    return [
      arm,
      {
        usdPerRun: r3(total),
        usdPerCompletedRun: r3(completed.reduce((n, f) => n + (f.metrics!.costUsd.total ?? 0), 0) / completed.length),
        completedRuns: completed.length,
        parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { usd: r3(v), pct: pct(v, total) }])),
        rolePct: Object.fromEntries(Object.entries(byRole).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v, total)])),
      },
    ];
  }),
);

const roles = new Map<string, { calls: number; callsWithHit: number; input: number; cached: number }>();
for (const c of files.flatMap(llmCalls)) {
  if (c.status !== 'ok' || !c.usage) continue;
  const r = roles.get(c.role) ?? { calls: 0, callsWithHit: 0, input: 0, cached: 0 };
  r.calls += 1;
  r.callsWithHit += (c.usage.cached ?? 0) > 0 ? 1 : 0;
  r.input += c.usage.input ?? 0;
  r.cached += c.usage.cached ?? 0;
  roles.set(c.role, r);
}
const cacheByRole = [...roles].map(([role, r]) => ({ role, ...r, cachedPct: pct(r.cached, r.input) })).sort((a, b) => b.input - a.input);

const inconclusiveRuns = files
  .filter((f) => scores.get(f)!.expectedOutcome === 'inconclusive')
  .map((f) => {
    const s = scores.get(f)!;
    const honesty = (f.report as { honesty?: { downgraded?: boolean; criticAccepted?: boolean | null } } | null)?.honesty;
    return {
      run: runName(f),
      arm: f.job.arm,
      status: s.status,
      outcome: s.outcome,
      stopReason: s.stopReason,
      correctAbstention: s.correctAbstention,
      unsupportedDiagnosis: s.unsupportedDiagnosis,
      downgradedByHonestyRule: honesty?.downgraded ?? false,
      criticAccepted: honesty?.criticAccepted ?? null,
    };
  });

const abstentionByArm = ARMS.map((arm) => {
  const rs = inconclusiveRuns.filter((r) => r.arm === arm);
  return {
    arm,
    runs: rs.length,
    correctAbstentions: rs.filter((r) => r.correctAbstention).length,
    ofWhichForcedByHonestyRule: rs.filter((r) => r.correctAbstention && r.downgradedByHonestyRule).length,
    unsupportedDiagnoses: rs.filter((r) => r.unsupportedDiagnosis).length,
    unsupportedAcceptedByCritic: rs.filter((r) => r.unsupportedDiagnosis && r.criticAccepted === true).length,
  };
});

const out = { runs: files.length, model, costRatesFrom: 'src/llm/pricing.ts (list rates)', concurrency, failures, cost, cacheByRole, abstentionByArm, inconclusiveRuns };
writeFileSync(join(RESULTS_DIR, 'run-health.json'), JSON.stringify(out, null, 2) + '\n');

const table = (head: string[], rows: Array<Array<string | number | null>>) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const md = [
  '# Run health (generated)',
  '',
  'Generated by `eval/run-health.ts` from `eval/runs/`. Do not edit by hand. Costs are at list rates.',
  '',
  '## Reliability by concurrency',
  '',
  table(['Concurrency', 'Arms', 'Runs', 'Failed', '429 errors', 'Hung requests', 'Other errors'], concurrency.map((c) => [c.concurrency, c.arms.join(', '), c.runs, `${c.failed} (${c.failedPct}%)`, c.rateLimitErrors, c.hungRequests, c.otherErrors])),
  '',
  '## Failed runs',
  '',
  table(['Run', 'Concurrency', 'Failed tasks', 'Stop reason', 'Report built by', 'Tool calls'], failures.map((f) => [`\`${f.run}\``, f.concurrency, f.failedTasks.join(', '), f.stopReason, f.reportBuiltBy, f.toolCalls])),
  '',
  '## Where the money went, per run',
  '',
  table(['Arm', 'Total', 'Completed runs only', 'Fresh input', 'Cached input', 'Answer', 'Thinking', 'Jev'], ARMS.map((a) => {
    const c = cost[a] as { usdPerRun: number; usdPerCompletedRun: number; completedRuns: number; parts: Record<string, { usd: number; pct: number }> };
    return [a, `$${c.usdPerRun}`, `$${c.usdPerCompletedRun} (${c.completedRuns} runs)`, ...['freshInput', 'cachedInput', 'answer', 'thinking', 'jev'].map((k) => `$${c.parts[k]!.usd} (${c.parts[k]!.pct}%)`)];
  })),
  '',
  '## Cost share by agent',
  '',
  table(['Arm', 'Share'], ARMS.map((a) => [a, Object.entries((cost[a] as { rolePct: Record<string, number> }).rolePct).map(([k, v]) => `${k} ${v}%`).join(', ')])),
  '',
  '## Implicit caching by agent, all runs',
  '',
  table(['Agent', 'Calls', 'Calls with a hit', 'Input tokens', 'Cached', 'Cached %'], cacheByRole.map((r) => [r.role, r.calls, r.callsWithHit, r.input, r.cached, `${r.cachedPct}%`])),
  '',
  '## Inconclusive scenarios, by arm',
  '',
  table(['Arm', 'Runs', 'Correct abstentions', 'Forced by honesty rule', 'Unsupported diagnoses', 'Of those, accepted by the critic'], abstentionByArm.map((a) => [a.arm, a.runs, a.correctAbstentions, a.ofWhichForcedByHonestyRule, a.unsupportedDiagnoses, a.unsupportedAcceptedByCritic])),
  '',
].join('\n');
writeFileSync(join(RESULTS_DIR, 'run-health.md'), md);
console.log(md);
