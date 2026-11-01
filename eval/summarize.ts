#!/usr/bin/env node
/**
 * Summarize recorded evaluation runs into eval/results/summary.json and summary.md.
 * Only runs made with the frozen prompt hash (eval/results/freeze.json) are included; earlier
 * runs are listed as excluded. Generated, never hand-edited.
 *
 *   npx tsx eval/summarize.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../src/util/paths.js';
import type { RunMetrics } from './metrics.js';
import { readRunFiles, RUNS_DIR, runFileName, spentUsd, SUPERSEDED_DIR, type RunFile } from './runner.js';
import { scoreRun, type CaseScore } from './score.js';

export const RESULTS_DIR = join(projectRoot(), 'eval', 'results');

export interface Freeze {
  promptHash: string;
  frozenAt: string;
  gitSha: string;
  armDBase: 'A' | 'B';
  note: string;
}

export function readFreeze(): Freeze | null {
  const p = join(RESULTS_DIR, 'freeze.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Freeze) : null;
}

interface Row extends CaseScore {
  metrics: Pick<RunMetrics, 'toolCalls' | 'toolAttempts' | 'toolRetries' | 'toolFailures' | 'toolPartials' | 'llmCalls' | 'latencyMs' | 'tokens' | 'tokensUnknownCalls' | 'costUsd' | 'criticRounds' | 'followUpsScheduled' | 'jev'> | null;
  promptHash: string;
  gitSha: string | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

export function aggregate(rows: Row[]) {
  const conclusive = rows.filter((r) => r.expectedOutcome === 'conclusive');
  const inconclusive = rows.filter((r) => r.expectedOutcome === 'inconclusive');
  const withM = rows.filter((r) => r.metrics);
  const nums = (f: (r: Row) => number | null | undefined) => withM.map(f).filter((x): x is number => typeof x === 'number');
  const valid = rows.reduce((n, r) => n + r.citations.valid, 0);
  const invalid = rows.reduce((n, r) => n + r.citations.invalid, 0);
  const stopReasons: Record<string, number> = {};
  for (const r of rows) stopReasons[r.stopReason ?? r.status] = (stopReasons[r.stopReason ?? r.status] ?? 0) + 1;
  const tokenField = (k: 'input' | 'output' | 'thinking' | 'cached') => {
    const xs = withM.map((r) => r.metrics!.tokens[k]);
    return { mean: xs.some((x) => x === null) ? null : r3(mean(xs as number[])), unknownRuns: xs.filter((x) => x === null).length };
  };
  const credit = conclusive.reduce((n, r) => n + (r.rootCauseCredit ?? 0), 0);
  return {
    runs: rows.length,
    crashed: rows.filter((r) => r.status === 'crashed').length,
    rootCause: {
      conclusiveCases: conclusive.length,
      credit: r3(credit),
      accuracy: conclusive.length ? r3(credit / conclusive.length) : null,
      topHypothesisMatches: conclusive.filter((r) => r.topMatches).length,
      top2Hits: conclusive.filter((r) => r.top2Hit).length,
      falseAbstentions: conclusive.filter((r) => r.falseAbstention).length,
    },
    inconclusiveHandling: {
      inconclusiveCases: inconclusive.length,
      correctAbstentions: inconclusive.filter((r) => r.correctAbstention).length,
      unsupportedDiagnoses: inconclusive.filter((r) => r.unsupportedDiagnosis).length,
      other: inconclusive.filter((r) => !r.correctAbstention && !r.unsupportedDiagnosis).length,
    },
    grounding: {
      citationsValid: valid,
      citationsInvalid: invalid,
      fabricatedCitationRate: valid + invalid ? r3(invalid / (valid + invalid)) : null,
      factsWithoutEvidence: rows.reduce((n, r) => n + r.citations.factsWithoutEvidence, 0),
      requiredEvidenceRecall: r3(mean(rows.map((r) => r.requiredEvidence.recall).filter((x): x is number => x !== null))),
    },
    toolCalls: { mean: r3(mean(nums((r) => r.metrics!.toolCalls))), min: Math.min(...nums((r) => r.metrics!.toolCalls)), max: Math.max(...nums((r) => r.metrics!.toolCalls)), total: nums((r) => r.metrics!.toolCalls).reduce((a, b) => a + b, 0) },
    toolAttempts: r3(mean(nums((r) => r.metrics!.toolAttempts))),
    toolRetries: r3(mean(nums((r) => r.metrics!.toolRetries))),
    toolFailures: r3(mean(nums((r) => r.metrics!.toolFailures))),
    toolPartials: r3(mean(nums((r) => r.metrics!.toolPartials))),
    llmCalls: r3(mean(nums((r) => r.metrics!.llmCalls))),
    latencyS: {
      mean: r3((mean(nums((r) => r.metrics!.latencyMs)) ?? 0) / 1000),
      median: r3((median(nums((r) => r.metrics!.latencyMs)) ?? 0) / 1000),
      min: r3(Math.min(...nums((r) => r.metrics!.latencyMs)) / 1000),
      max: r3(Math.max(...nums((r) => r.metrics!.latencyMs)) / 1000),
    },
    tokensPerRun: { input: tokenField('input'), output: tokenField('output'), thinking: tokenField('thinking'), cached: tokenField('cached') },
    tokensUnknownCalls: nums((r) => r.metrics!.tokensUnknownCalls).reduce((a, b) => a + b, 0),
    jevPerRun: { calls: r3(mean(nums((r) => r.metrics!.jev.calls))), questions: r3(mean(nums((r) => r.metrics!.jev.questions))) },
    costUsd: { mean: r3(mean(nums((r) => r.metrics!.costUsd.total))), total: r3(nums((r) => r.metrics!.costUsd.total).reduce((a, b) => a + b, 0)) },
    criticRounds: r3(mean(nums((r) => r.metrics!.criticRounds))),
    followUps: r3(mean(nums((r) => r.metrics!.followUpsScheduled))),
    stopReasons,
  };
}

function cell(rs: Row[]): string {
  if (rs.length === 0) return '–';
  return rs
    .map((r) => {
      if (r.status === 'crashed') return 'crash';
      if (r.expectedOutcome === 'inconclusive') return r.correctAbstention ? '✓ abstain' : r.unsupportedDiagnosis ? '✗ diagnosed' : `✗ ${r.outcome}`;
      const c = r.rootCauseCredit ?? 0;
      const mark = c === 1 ? '✓' : c > 0 ? `½(${c})` : '✗';
      return r.outcome === 'conclusive' ? mark : `${mark} ${r.outcome}`;
    })
    .join(' / ');
}

function main() {
  const freeze = readFreeze();
  const files = readRunFiles();
  const names = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
  const rows: Row[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  for (const f of files) {
    const name = runFileName(f.job);
    const ph = f.environment.promptHash;
    if (freeze && ph !== freeze.promptHash) {
      excluded.push({ file: name, reason: `prompt hash ${ph} != frozen ${freeze.promptHash}` });
      continue;
    }
    const score = scoreRun(f as RunFile, name);
    const m = f.metrics;
    rows.push({
      ...score,
      promptHash: ph,
      gitSha: f.environment.gitSha,
      metrics: m
        ? { toolCalls: m.toolCalls, toolAttempts: m.toolAttempts, toolRetries: m.toolRetries, toolFailures: m.toolFailures, toolPartials: m.toolPartials, llmCalls: m.llmCalls, latencyMs: m.latencyMs, tokens: m.tokens, tokensUnknownCalls: m.tokensUnknownCalls, costUsd: m.costUsd, criticRounds: m.criticRounds, followUpsScheduled: m.followUpsScheduled, jev: m.jev }
        : null,
    });
  }
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  const byArm = Object.fromEntries(arms.map((a) => [a, aggregate(rows.filter((r) => r.arm === a))]));
  const byArmSplit = Object.fromEntries(arms.map((a) => [a, { dev: aggregate(rows.filter((r) => r.arm === a && r.split === 'dev')), heldout: aggregate(rows.filter((r) => r.arm === a && r.split === 'heldout')) }]));
  // Paired comparison on cases every listed arm ran (same scenario-variant set).
  const keysFor = (a: string) => new Set(rows.filter((r) => r.arm === a).map((r) => r.key));
  const common = arms.length ? [...keysFor(arms[0]!)].filter((k) => arms.every((a) => keysFor(a).has(k))) : [];
  const byArmCommon = Object.fromEntries(arms.map((a) => [a, aggregate(rows.filter((r) => r.arm === a && common.includes(r.key)))]));
  const devSpend = spentUsd(readRunFiles(join(projectRoot(), 'eval', 'runs-dev')));
  const superseded = readRunFiles(SUPERSEDED_DIR);
  const spend = spentUsd(files) + devSpend + spentUsd(superseded);
  const env = files.find((f) => f.environment.promptHash === freeze?.promptHash)?.environment ?? files[0]?.environment ?? null;
  const plan = existsSync(join(RESULTS_DIR, 'plan.json')) ? JSON.parse(readFileSync(join(RESULTS_DIR, 'plan.json'), 'utf8')) : null;
  const judge = existsSync(join(RESULTS_DIR, 'judge.json')) ? JSON.parse(readFileSync(join(RESULTS_DIR, 'judge.json'), 'utf8')) : null;
  const summary = {
    schema: 'rootline.eval-summary.v1',
    generatedAt: new Date().toISOString(),
    freeze,
    environment: env,
    plan,
    runs: { files: names.length, included: rows.length, excluded, crashed: rows.filter((r) => r.status === 'crashed').length, superseded: superseded.map((f) => runFileName(f.job)) },
    spendUsdAllRecordedRuns: r3(spend),
    spendBreakdownUsd: { scored: r3(spentUsd(files)), dev: r3(devSpend), superseded: r3(spentUsd(superseded)) },
    byArm,
    byArmSplit,
    commonCases: common.sort(),
    byArmCommonCases: byArmCommon,
    judge: judge ? judge.summary ?? null : null,
    cases: rows,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(RESULTS_DIR, 'summary.md'), renderMd(summary, rows, arms, common));
  console.error(`summary: ${rows.length} runs included, ${excluded.length} excluded; arms ${arms.join(', ')}; est. spend $${spend.toFixed(2)}`);
}

function pct(n: number | null) {
  return n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}

function renderMd(s: any, rows: Row[], arms: string[], common: string[]): string {
  const L: string[] = [];
  L.push('# Evaluation summary (generated)', '');
  L.push(`Generated ${s.generatedAt} by \`eval/summarize.ts\` from \`eval/runs/\`. Do not edit by hand.`, '');
  if (s.freeze) L.push(`Prompt freeze: hash \`${s.freeze.promptHash}\` at ${s.freeze.frozenAt} (git ${s.freeze.gitSha}); arm D base: ${s.freeze.armDBase}.`);
  if (s.environment) L.push(`Model: ${s.environment.model}; Jev: ${s.environment.jevModel ?? 'n/a'}; thinking: ${s.environment.thinkingLevel}; fixtures: \`${String(s.environment.fixtureCorpusSha256).slice(0, 16)}\`; node ${s.environment.node}; ${s.environment.machine}.`);
  L.push(`Runs: ${s.runs.included} included, ${s.runs.excluded.length} excluded (pre-freeze), ${s.runs.crashed} crashed, ${s.runs.superseded.length} superseded and redone (see eval/runs-superseded/README.md). Estimated spend over all recorded runs: $${s.spendUsdAllRecordedRuns} (scored $${s.spendBreakdownUsd.scored}, dev $${s.spendBreakdownUsd.dev}, superseded $${s.spendBreakdownUsd.superseded}).`, '');
  const head = ['Metric', ...arms.map((a) => `Arm ${a}`)];
  const line = (name: string, f: (a: any) => string) => `| ${name} | ${arms.map((a) => f(s.byArm[a])).join(' | ')} |`;
  L.push('## By arm (all included runs)', '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
  L.push(line('Runs', (a) => String(a.runs)));
  L.push(line('Root-cause accuracy (credit / conclusive cases)', (a) => `${a.rootCause.credit} / ${a.rootCause.conclusiveCases} (${pct(a.rootCause.accuracy)})`));
  L.push(line('Top hypothesis matches (any outcome)', (a) => `${a.rootCause.topHypothesisMatches} / ${a.rootCause.conclusiveCases}`));
  L.push(line('Top-2 hit', (a) => `${a.rootCause.top2Hits} / ${a.rootCause.conclusiveCases}`));
  L.push(line('False abstentions (conclusive cases)', (a) => String(a.rootCause.falseAbstentions)));
  L.push(line('Correct abstentions (inconclusive cases)', (a) => `${a.inconclusiveHandling.correctAbstentions} / ${a.inconclusiveHandling.inconclusiveCases}`));
  L.push(line('Unsupported definitive diagnoses', (a) => String(a.inconclusiveHandling.unsupportedDiagnoses)));
  L.push(line('Fabricated-citation rate', (a) => `${pct(a.grounding.fabricatedCitationRate)} (${a.grounding.citationsInvalid}/${a.grounding.citationsValid + a.grounding.citationsInvalid})`));
  L.push(line('Facts stated without evidence', (a) => String(a.grounding.factsWithoutEvidence)));
  L.push(line('Required-evidence recall (mean)', (a) => pct(a.grounding.requiredEvidenceRecall)));
  L.push(line('Tool calls per run (mean, min-max)', (a) => `${a.toolCalls.mean} (${a.toolCalls.min}-${a.toolCalls.max})`));
  L.push(line('Tool attempts / retries / failures / partials per run', (a) => `${a.toolAttempts} / ${a.toolRetries} / ${a.toolFailures} / ${a.toolPartials}`));
  L.push(line('Model calls per run', (a) => String(a.llmCalls)));
  L.push(line('Latency s (mean, median, min-max)', (a) => `${a.latencyS.mean}, ${a.latencyS.median} (${a.latencyS.min}-${a.latencyS.max})`));
  L.push(line('Input tokens per run (mean)', (a) => String(a.tokensPerRun.input.mean ?? `unknown in ${a.tokensPerRun.input.unknownRuns} runs`)));
  L.push(line('Output tokens per run (mean)', (a) => String(a.tokensPerRun.output.mean ?? 'unknown')));
  L.push(line('Thinking tokens per run (mean)', (a) => String(a.tokensPerRun.thinking.mean ?? 'unknown')));
  L.push(line('Cached input tokens per run (mean)', (a) => String(a.tokensPerRun.cached.mean ?? 'unknown')));
  L.push(line('Calls with unknown usage', (a) => String(a.tokensUnknownCalls)));
  L.push(line('Jev calls / questions per run', (a) => `${a.jevPerRun.calls ?? 0} / ${a.jevPerRun.questions ?? 0}`));
  L.push(line('Est. cost per run (USD, standard rates)', (a) => `$${a.costUsd.mean}`));
  L.push(line('Critic rounds / follow-ups per run', (a) => `${a.criticRounds} / ${a.followUps}`));
  L.push(line('Stop reasons', (a) => Object.entries(a.stopReasons).map(([k, v]) => `${k}: ${v}`).join(', ')));
  L.push('');
  if (common.length && arms.length > 1) {
    L.push(`## Paired comparison on the ${common.length} cases every arm ran`, '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    const lc = (name: string, f: (a: any) => string) => `| ${name} | ${arms.map((a) => f(s.byArmCommonCases[a])).join(' | ')} |`;
    L.push(lc('Root-cause accuracy', (a) => `${a.rootCause.credit} / ${a.rootCause.conclusiveCases} (${pct(a.rootCause.accuracy)})`));
    L.push(lc('Correct abstentions', (a) => `${a.inconclusiveHandling.correctAbstentions} / ${a.inconclusiveHandling.inconclusiveCases}`));
    L.push(lc('Tool calls (mean)', (a) => String(a.toolCalls.mean)));
    L.push(lc('Latency s (mean)', (a) => String(a.latencyS.mean)));
    L.push(lc('Input / output+thinking tokens (mean)', (a) => `${a.tokensPerRun.input.mean} / ${a.tokensPerRun.output.mean !== null && a.tokensPerRun.thinking.mean !== null ? r3(a.tokensPerRun.output.mean + a.tokensPerRun.thinking.mean) : 'unknown'}`));
    L.push(lc('Est. cost per run', (a) => `$${a.costUsd.mean}`));
    L.push('');
  }
  L.push('## By split', '');
  for (const a of arms) {
    const d = s.byArmSplit[a];
    L.push(`- Arm ${a}: dev ${d.dev.rootCause.credit}/${d.dev.rootCause.conclusiveCases} root cause, ${d.dev.inconclusiveHandling.correctAbstentions}/${d.dev.inconclusiveHandling.inconclusiveCases} abstentions; held-out ${d.heldout.rootCause.credit}/${d.heldout.rootCause.conclusiveCases} root cause, ${d.heldout.inconclusiveHandling.correctAbstentions}/${d.heldout.inconclusiveHandling.inconclusiveCases} abstentions.`);
  }
  L.push('', '## Per case', '', `| Case | Split | Expected | ${arms.map((a) => `Arm ${a}`).join(' | ')} |`, `| --- | --- | --- | ${arms.map(() => '---').join(' | ')} |`);
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  for (const k of keys) {
    const any = rows.find((r) => r.key === k)!;
    L.push(`| ${k} | ${any.split} | ${any.expectedOutcome} | ${arms.map((a) => cell(rows.filter((r) => r.key === k && r.arm === a).sort((x, y) => x.rep - y.rep))).join(' | ')} |`);
  }
  L.push('', 'Legend: ✓ full root-cause credit; ½(x) partial credit; ✗ wrong top cause; "inconclusive"/"failed" after a mark = the run did not commit to a cause (no credit); for inconclusive cases ✓ abstain / ✗ diagnosed. Repetitions are separated by "/".');
  if (s.runs.excluded.length) {
    L.push('', '## Excluded runs', '', ...s.runs.excluded.map((e: any) => `- ${e.file}: ${e.reason}`));
  }
  return L.join('\n') + '\n';
}

if (process.argv[1] && /summarize\.ts$/.test(process.argv[1])) main();
