#!/usr/bin/env node
/**
 * Model judge (Jev). Blind to arm: no arm, run id or orchestration detail ever enters its state.
 *
 *   doppler run -p shared -c dev_mac -- npx tsx eval/judge.ts --validate   # agreement on the validation set
 *   doppler run -p shared -c dev_mac -- npx tsx eval/judge.ts              # judge all included runs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '../src/contracts/agents.js';
import type { EvidenceRecord } from '../src/contracts/evidence.js';
import type { RunEvent } from '../src/contracts/events.js';
import { loadEnv } from '../src/config.js';
import { fold } from '../src/engine/run-state.js';
import { OpenRouterJev, type JevClient, type JevQuestion } from '../src/llm/jev.js';
import { costUsd } from '../src/llm/pricing.js';
import { projectRoot } from '../src/util/paths.js';
import { readRunFiles, runFileName } from './runner.js';
import { loadLabel, scoreRun } from './score.js';
import { readFreeze, RESULTS_DIR } from './summarize.js';

const YES = 0.5;

export function mechanismQuestion(): Record<string, JevQuestion> {
  return {
    same: {
      type: 'noul',
      instructions: "Does the report's top cause describe the same causal mechanism as the reference mechanism (the same faulty component and the same thing going wrong), even if worded differently?",
      criteria: { true: 'same mechanism', false: 'a different mechanism, only a symptom, or only a coincidental change' },
    },
  };
}

export function claimQuestions(ids: string[]): Record<string, JevQuestion> {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        type: 'noul',
        instructions: `Do the excerpts of the evidence cited by claim ${id} entail its statement?`,
        criteria: { true: 'the cited excerpts directly show it', false: 'the excerpts do not show it, or show something else' },
      } satisfies JevQuestion,
    ]),
  );
}

export function counterQuestions(items: string[]): Record<string, JevQuestion> {
  return Object.fromEntries(
    items.map((item, i) => [
      `k${i}`,
      {
        type: 'noul',
        instructions: `Does the report address this point: "${item}"? Addressing it means stating it, using it to rule out an alternative, or explicitly discussing it.`,
        criteria: { true: 'addressed', false: 'not addressed' },
      } satisfies JevQuestion,
    ]),
  );
}

const p = (a: { type: string; noul?: number } | undefined) => (a && a.type === 'noul' ? (a.noul ?? 0) : null);

async function validate(jev: JevClient, signal: AbortSignal) {
  const { items } = JSON.parse(readFileSync(join(projectRoot(), 'eval', 'judge-validation', 'items.json'), 'utf8')) as { items: any[] };
  const results: Array<{ id: string; kind: string; expected: boolean; p: number | null; agree: boolean }> = [];
  let input = 0;
  for (const it of items) {
    let ans;
    if (it.kind === 'mechanism') {
      ans = await jev.decide({ reference_mechanism: it.reference, report_top_cause: it.top, report_root_cause_statement: it.top.cause }, mechanismQuestion(), { role: 'judge', signal });
      const pr = p(ans.answers.same as never);
      results.push({ id: it.id, kind: it.kind, expected: it.expected, p: pr, agree: pr !== null && pr >= YES === it.expected });
    } else {
      ans = await jev.decide({ claims: { c1: { statement: it.claim, cites: Object.keys(it.evidence) } }, evidence: it.evidence }, claimQuestions(['c1']), { role: 'judge', signal });
      const pr = p(ans.answers.c1 as never);
      results.push({ id: it.id, kind: it.kind, expected: it.expected, p: pr, agree: pr !== null && pr >= YES === it.expected });
    }
    input += ans.usage.input ?? 0;
  }
  const by = (k: string) => results.filter((r) => r.kind === k);
  const summary = {
    items: results.length,
    agreement: results.filter((r) => r.agree).length / results.length,
    mechanism: { items: by('mechanism').length, agree: by('mechanism').filter((r) => r.agree).length },
    claim: { items: by('claim').length, agree: by('claim').filter((r) => r.agree).length },
    disagreements: results.filter((r) => !r.agree),
    labeledBy: 'coding agent (not human)',
    jevModel: jev.model,
    inputTokens: input,
    estCostUsd: costUsd(jev.model, { input, output: 0, thinking: 0, cached: 0 }),
  };
  writeFileSync(join(RESULTS_DIR, 'judge-validation.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
  console.error(`judge validation: ${(summary.agreement * 100).toFixed(1)}% agreement (${results.filter((r) => r.agree).length}/${results.length}); mechanism ${summary.mechanism.agree}/${summary.mechanism.items}, claims ${summary.claim.agree}/${summary.claim.items}`);
}

async function judgeRuns(jev: JevClient, signal: AbortSignal) {
  const freeze = readFreeze();
  const files = readRunFiles().filter((f) => !freeze || f.environment.promptHash === freeze.promptHash);
  const outPath = join(RESULTS_DIR, 'judge.json');
  const prior = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, 'utf8')) as { perRun: Record<string, any> }).perRun : {};
  const perRun: Record<string, any> = { ...prior };
  for (const f of files) {
    const name = runFileName(f.job);
    if (perRun[name] || !f.report) continue;
    const label = loadLabel(f.job.key);
    const report = f.report as Report;
    const s = fold(f.events as RunEvent[]);
    const evidence = s.evidence as Record<string, EvidenceRecord>;
    const entry: any = { key: f.job.key, arm: f.job.arm, mechanism: null, claims: null, counter: null };
    const top = report.hypotheses.filter((h) => h.status !== 'ruled_out').sort((a, b) => a.rank - b.rank)[0];
    if (label.expectedOutcome === 'conclusive' && top) {
      const a = await jev.decide(
        { reference_mechanism: label.acceptableCauses.map((c) => c.mechanism).join(' AND '), report_top_cause: { cause: top.cause, component: top.component, causeType: top.causeType }, report_root_cause_statement: report.rootCauseStatement },
        mechanismQuestion(),
        { role: 'judge', signal },
      );
      entry.mechanism = { p: p(a.answers.same as never) };
    }
    const facts = report.facts.filter((x) => x.evidenceIds.length > 0).slice(0, 40);
    if (facts.length) {
      const claims = Object.fromEntries(facts.map((x, i) => [`c${i}`, { statement: x.statement, cites: x.evidenceIds }]));
      const cited = [...new Set(facts.flatMap((x) => x.evidenceIds))];
      const a = await jev.decide({ claims, evidence: Object.fromEntries(cited.map((id) => [id, evidence[id]?.excerpt.slice(0, 1500) ?? '(missing)'])) }, claimQuestions(Object.keys(claims)), { role: 'judge', signal });
      const ps = Object.keys(claims).map((k) => p(a.answers[k] as never));
      entry.claims = { assessed: ps.length, supported: ps.filter((x) => x !== null && x >= YES).length };
    }
    if (label.keyCounterevidence.length) {
      const a = await jev.decide(
        {
          summary: report.incidentSummary,
          root_cause: report.rootCauseStatement,
          hypotheses: report.hypotheses.map((h) => ({ rank: h.rank, cause: h.cause, status: h.status, rationale: h.rationale })),
          facts: report.facts.map((x) => x.statement),
          inferences: report.inferences.map((x) => x.statement),
          gaps: report.gaps.map((g) => g.description),
        },
        counterQuestions(label.keyCounterevidence),
        { role: 'judge', signal },
      );
      const ps = label.keyCounterevidence.map((_, i) => p(a.answers[`k${i}`] as never));
      entry.counter = { assessed: ps.length, addressed: ps.filter((x) => x !== null && x >= YES).length };
    }
    entry.deterministic = scoreRun(f, name).rootCauseCredit;
    perRun[name] = entry;
    console.error(`${name}: mechanism=${entry.mechanism?.p?.toFixed(2) ?? '-'} claims=${entry.claims ? `${entry.claims.supported}/${entry.claims.assessed}` : '-'} counter=${entry.counter ? `${entry.counter.addressed}/${entry.counter.assessed}` : '-'}`);
    writeFileSync(outPath, JSON.stringify({ perRun }, null, 2) + '\n');
  }
  // Summary by arm, and agreement between the judge and the deterministic root-cause score.
  const arms = [...new Set(Object.values(perRun).map((e: any) => e.arm))].sort();
  const summary: any = { byArm: {}, agreementWithDeterministic: null, disagreements: [] };
  let agree = 0;
  let both = 0;
  for (const [name, e] of Object.entries(perRun) as Array<[string, any]>) {
    if (e.mechanism && e.deterministic !== null) {
      both++;
      const judgeYes = (e.mechanism.p ?? 0) >= YES;
      const detYes = e.deterministic >= 1;
      if (judgeYes === detYes) agree++;
      else summary.disagreements.push({ run: name, judgeP: e.mechanism.p, deterministicCredit: e.deterministic });
    }
  }
  summary.agreementWithDeterministic = both ? { agree, of: both } : null;
  for (const a of arms) {
    const es = Object.values(perRun).filter((e: any) => e.arm === a) as any[];
    const m = es.filter((e) => e.mechanism);
    summary.byArm[a] = {
      mechanismAgreement: { yes: m.filter((e) => (e.mechanism.p ?? 0) >= YES).length, of: m.length },
      claimSupport: { supported: es.reduce((n, e) => n + (e.claims?.supported ?? 0), 0), assessed: es.reduce((n, e) => n + (e.claims?.assessed ?? 0), 0) },
      counterevidenceAddressed: { addressed: es.reduce((n, e) => n + (e.counter?.addressed ?? 0), 0), assessed: es.reduce((n, e) => n + (e.counter?.assessed ?? 0), 0) },
    };
  }
  writeFileSync(outPath, JSON.stringify({ summary, perRun }, null, 2) + '\n');
  console.error(`judged ${Object.keys(perRun).length} runs`);
}

async function main() {
  const env = loadEnv();
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const jev = new OpenRouterJev(env.OPENROUTER_API_KEY, env.ROOTLINE_JEV_MODEL);
  const signal = new AbortController().signal;
  if (process.argv.includes('--validate')) await validate(jev, signal);
  else await judgeRuns(jev, signal);
}

if (process.argv[1] && /judge\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
