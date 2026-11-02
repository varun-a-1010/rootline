#!/usr/bin/env node
/**
 * Which request features allow Vertex implicit caching? Sends a fresh large prompt twice per
 * repetition and records what was cached on the repeat. Implicit caching is best-effort, so one
 * pair proves nothing: conditions are repeated and interleaved, and every pair is recorded.
 * Writes eval/results/cache-experiment.{json,md}. Generated, never hand-edited.
 *   doppler run -p shared -c dev_mac -- npx tsx eval/cache-experiment.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadEnv } from '../src/config.js';
import { createLiveProviders } from '../src/llm/factory.js';
import { functionDeclaration, toGeminiSchema } from '../src/llm/schema.js';
import { sleep } from '../src/util/sleep.js';
import { RESULTS_DIR } from './summarize.js';

const REPS = 4;
const GAP_MS = 6000;
const ROWS = 450;

const { llm } = createLiveProviders(loadEnv());
if (!llm) throw new Error('no model configured');
const signal = new AbortController().signal;
const big = (tag: string) => `Reference ${tag}.\n` + Array.from({ length: ROWS }, (_, i) => `row ${i} ${tag}: service order-service latency ${i % 97} errors ${i % 13}.`).join('\n');
const schemaA = toGeminiSchema(z.object({ answer: z.string() }));
const schemaB = toGeminiSchema(z.object({ verdict: z.string(), reasons: z.array(z.string()) }));
const tools = [functionDeclaration('lookup', 'Look something up.', z.object({ q: z.string() })), functionDeclaration('submit', 'Finish.', z.object({ answer: z.string() }))];
const toolReq = { tools, toolMode: 'ANY' as const };
const base = { role: 'cache-experiment', system: 'Answer briefly.', thinkingLevel: 'low' as const, signal };
const run = new Date().toISOString().replace(/\W/g, '');

const CASES: Array<[string, object, object]> = [
  ['plain text, repeated', {}, {}],
  ['same responseSchema, repeated', { responseSchema: schemaA }, { responseSchema: schemaA }],
  ['different responseSchema on the repeat', { responseSchema: schemaA }, { responseSchema: schemaB }],
  ['same tools, repeated', toolReq, toolReq],
  ['tools, then restricted to one function', toolReq, { ...toolReq, allowedFunctions: ['submit'] }],
];

interface Pair {
  rep: number;
  input: number | null;
  cachedOnFirst: number | null;
  cachedOnRepeat: number | null;
  error: string | null;
}
const pairs: Pair[][] = CASES.map(() => []);

for (let rep = 1; rep <= REPS; rep++) {
  for (const [i, [name, first, second]] of CASES.entries()) {
    const contents = [{ role: 'user' as const, parts: [{ text: `${big(`case${i}-rep${rep}-${run}`)}\nSay ok.` }] }];
    try {
      const a = await llm.generate({ ...base, contents, ...first });
      await sleep(GAP_MS);
      const b = await llm.generate({ ...base, contents, ...second });
      pairs[i]!.push({ rep, input: b.usage.input, cachedOnFirst: a.usage.cached, cachedOnRepeat: b.usage.cached, error: null });
      console.log(`rep ${rep} ${name}: ${b.usage.cached} of ${b.usage.input}`);
    } catch (e) {
      pairs[i]!.push({ rep, input: null, cachedOnFirst: null, cachedOnRepeat: null, error: e instanceof Error ? e.message.slice(0, 120) : 'error' });
      console.log(`rep ${rep} ${name}: failed`);
    }
  }
}

const results = CASES.map(([name], i) => {
  const ok = pairs[i]!.filter((p) => !p.error);
  return {
    case: name,
    pairs: pairs[i]!,
    measured: ok.length,
    hits: ok.filter((p) => (p.cachedOnRepeat ?? 0) > 0).length,
    coldFirstCalls: ok.filter((p) => (p.cachedOnFirst ?? 0) === 0).length,
    meanCachedPct: ok.length ? Math.round((ok.reduce((n, p) => n + (p.cachedOnRepeat ?? 0) / (p.input ?? 1), 0) / ok.length) * 100) : null,
  };
});
writeFileSync(join(RESULTS_DIR, 'cache-experiment.json'), JSON.stringify({ model: llm.model, measuredAt: new Date().toISOString(), reps: REPS, gapMs: GAP_MS, results }, null, 2) + '\n');
const md = [
  '| Condition | Repeats with a hit | Mean cached on repeat | Cached tokens per pair | Cold first calls |',
  '| --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.case} | ${r.hits} of ${r.measured} | ${r.meanCachedPct ?? 'n/a'}% | ${r.pairs.map((p) => p.cachedOnRepeat ?? 'failed').join(', ')} | ${r.coldFirstCalls} of ${r.measured} |`),
].join('\n');
writeFileSync(join(RESULTS_DIR, 'cache-experiment.md'), md + '\n');
console.log(md);
