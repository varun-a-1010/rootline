#!/usr/bin/env node
/**
 * Where the orchestrations differ, from the recorded runs: what the critic loop changed between
 * the first reasoning version and the final report, and every incident on which the arms did not
 * all reach the same score. Writes eval/results/differences.{json,md}. Generated, never hand-edited.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fold } from '../src/engine/run-state.js';
import { readRunFiles, runFileName } from './runner.js';
import { loadLabel, rootCauseCredit, scoreRun, type CaseScore } from './score.js';
import { RESULTS_DIR } from './summarize.js';

const ARMS = ['A', 'B', 'C', 'D', 'E'] as const;
const MULTI = ['A', 'B', 'C', 'D'] as const;
type Change = 'wrong_to_right' | 'right_to_wrong' | 'stayed_right' | 'stayed_wrong';

interface Hyp {
  rank: number;
  component: string;
  causeType: string;
  status?: string;
}
const ranked = (hs: Hyp[]) => hs.filter((h) => h.status !== 'ruled_out').sort((a, b) => a.rank - b.rank);

const files = readRunFiles();
const scores = new Map<string, CaseScore>();
const changes: Array<{ file: string; key: string; arm: string; split: string; reasoningVersions: number; criticRounds: number; first: string; final: string; change: Change }> = [];

for (const f of files) {
  const name = runFileName(f.job);
  const score = scoreRun(f, name);
  scores.set(name, score);
  const label = loadLabel(f.job.key);
  if (label.expectedOutcome !== 'conclusive' || f.job.arm === 'E') continue;
  const s = fold(f.events as Parameters<typeof fold>[0]);
  const versions = s.hypothesisVersions as Array<{ hypotheses: Hyp[] }>;
  if (!versions.length) continue;
  const firstTop = ranked(versions[0]!.hypotheses)[0];
  const firstRight = rootCauseCredit(label, ranked(versions[0]!.hypotheses)).topMatches;
  const finalRight = score.topMatches === true;
  const change: Change = !firstRight && finalRight ? 'wrong_to_right' : firstRight && !finalRight ? 'right_to_wrong' : firstRight ? 'stayed_right' : 'stayed_wrong';
  changes.push({
    file: name,
    key: f.job.key,
    arm: f.job.arm,
    split: label.split,
    reasoningVersions: versions.length,
    criticRounds: s.criticDecisions.length,
    first: firstTop ? `${firstTop.component} / ${firstTop.causeType}` : 'none',
    final: score.top ? `${score.top.component} / ${score.top.causeType}` : 'none',
    change,
  });
}

const byArm = Object.fromEntries(
  MULTI.map((arm) => {
    const rows = changes.filter((c) => c.arm === arm);
    const count = (k: Change) => rows.filter((c) => c.change === k).length;
    return [arm, { runs: rows.length, wrongToRight: count('wrong_to_right'), rightToWrong: count('right_to_wrong'), stayedRight: count('stayed_right'), stayedWrong: count('stayed_wrong'), fixed: rows.filter((c) => c.change === 'wrong_to_right').map((c) => c.key), broken: rows.filter((c) => c.change === 'right_to_wrong').map((c) => c.key) }];
  }),
);

/** 1 / partial / 0 for conclusive incidents; 1 for a correct abstention on inconclusive ones. */
const value = (c: CaseScore) => (c.expectedOutcome === 'inconclusive' ? (c.correctAbstention ? 1 : 0) : (c.rootCauseCredit ?? 0));
const keys = [...new Set([...scores.values()].map((c) => c.key))].sort();
const disagreements = keys
  .map((key) => {
    const cell = Object.fromEntries(ARMS.map((arm) => [arm, [...scores.values()].find((c) => c.key === key && c.arm === arm && c.rep === 1) ?? null]));
    return { key, cell };
  })
  .filter(({ cell }) => new Set(ARMS.map((a) => (cell[a] ? value(cell[a]!) : null))).size > 1)
  .map(({ key, cell }) => {
    const any = Object.values(cell).find(Boolean)!;
    const e = cell.E ? value(cell.E) : null;
    const better = MULTI.filter((a) => cell[a] && e !== null && value(cell[a]!) > e);
    const worse = MULTI.filter((a) => cell[a] && e !== null && value(cell[a]!) < e);
    return {
      key,
      split: any.split,
      expectedOutcome: any.expectedOutcome,
      arms: Object.fromEntries(ARMS.map((a) => [a, cell[a] ? { value: value(cell[a]!), outcome: cell[a]!.outcome, top: cell[a]!.top ? `${cell[a]!.top!.component} / ${cell[a]!.top!.causeType}` : null } : null])),
      multiAgentArmsBetterThanBaseline: better,
      multiAgentArmsWorseThanBaseline: worse,
    };
  });

const out = {
  generatedBy: 'eval/differences.ts',
  definitions: {
    criticChange: 'Conclusive incidents only. The top hypothesis of the first reasoning version is compared with the top hypothesis of the final report, against the label (component and cause type, as in root-cause scoring). A change needs a second reasoning version, which only a critic follow-up round produces; arm C has no critic. The baseline (E) has no separate reasoning versions.',
    disagreement: 'An incident on which the five arms did not all score the same: root-cause credit for conclusive incidents, a correct abstention for inconclusive ones.',
  },
  criticChange: byArm,
  criticChangeRuns: changes.filter((c) => c.change === 'wrong_to_right' || c.change === 'right_to_wrong'),
  disagreements,
};
writeFileSync(join(RESULTS_DIR, 'differences.json'), JSON.stringify(out, null, 2) + '\n');

const mark = (x: { value: number; outcome: string | null } | null, expected: string) => {
  if (!x) return '–';
  if (expected === 'inconclusive') return x.value ? '✓ abstained' : `✗ ${x.outcome === 'inconclusive' ? 'inconclusive*' : 'diagnosed'}`;
  return x.value === 1 ? '✓' : x.value ? `½ (${x.value})` : `✗${x.outcome !== 'conclusive' ? ` ${x.outcome}` : ''}`;
};
const md = `# Where the orchestrations differ (generated)

Generated by \`eval/differences.ts\` from \`eval/runs/\` and the labels. Do not edit by hand.

## What the critic loop changed

${out.definitions.criticChange}

| Arm | Conclusive runs | Wrong first, right in the end | Right first, wrong in the end | Right throughout | Wrong throughout |
| --- | --- | --- | --- | --- | --- |
${MULTI.map((a) => `| ${a} | ${byArm[a]!.runs} | ${byArm[a]!.wrongToRight}${byArm[a]!.fixed.length ? ` (${byArm[a]!.fixed.join(', ')})` : ''} | ${byArm[a]!.rightToWrong}${byArm[a]!.broken.length ? ` (${byArm[a]!.broken.join(', ')})` : ''} | ${byArm[a]!.stayedRight} | ${byArm[a]!.stayedWrong} |`).join('\n')}

${out.criticChangeRuns.length ? `| Run | Split | First reasoning version's top cause | Final report's top cause | Reasoning versions | Critic rounds |\n| --- | --- | --- | --- | --- | --- |\n${out.criticChangeRuns.map((c) => `| \`${c.file}\` | ${c.split} | ${c.first} | ${c.final} | ${c.reasoningVersions} | ${c.criticRounds} |`).join('\n')}\n` : ''}
## Incidents where the arms disagree

${out.definitions.disagreement} The other incidents had the same score in every arm.

| Incident | Split | Expected | A | B | C | D | E (baseline) | Multi-agent arms better than E | Worse than E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${disagreements.map((d) => `| ${d.key} | ${d.split} | ${d.expectedOutcome} | ${ARMS.map((a) => mark(d.arms[a] as never, d.expectedOutcome)).join(' | ')} | ${d.multiAgentArmsBetterThanBaseline.join(', ') || '–'} | ${d.multiAgentArmsWorseThanBaseline.join(', ') || '–'} |`).join('\n')}

Top causes in those incidents:

${disagreements.map((d) => `- **${d.key}**: ${ARMS.map((a) => `${a}: ${d.arms[a]?.top ?? 'none'}${d.arms[a] && d.arms[a]!.outcome !== 'conclusive' ? ` (${d.arms[a]!.outcome})` : ''}`).join('; ')}`).join('\n')}

\\* For an inconclusive incident, "inconclusive*" means the run said inconclusive but earned no abstention credit (it failed, or its report was built by code). See \`eval/rubric.md\`.
`;
writeFileSync(join(RESULTS_DIR, 'differences.md'), md);
console.log(`wrote ${join(RESULTS_DIR, 'differences.{json,md}')}: ${changes.length} critic comparisons, ${disagreements.length} disagreements`);
