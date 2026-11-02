#!/usr/bin/env node
/**
 * Which request features allow Vertex implicit caching? Sends each large prompt twice and
 * records how many tokens were cached on the repeat. Writes eval/results/cache-experiment.json.
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

const { llm } = createLiveProviders(loadEnv());
if (!llm) throw new Error('no model configured');
const signal = new AbortController().signal;
const big = (tag: string) => `Reference ${tag}.\n` + Array.from({ length: 900 }, (_, i) => `row ${i} ${tag}: service order-service latency ${i % 97} errors ${i % 13}.`).join('\n');
const schema = toGeminiSchema(z.object({ answer: z.string() }));
const tools = [functionDeclaration('lookup', 'Look something up.', z.object({ q: z.string() })), functionDeclaration('submit', 'Finish.', z.object({ answer: z.string() }))];
const base = { role: 'cache-experiment', system: 'Answer briefly.', thinkingLevel: 'low' as const, signal };
const run = new Date().toISOString().replace(/\W/g, '');
const results: Array<{ case: string; input: number | null; cachedOnRepeat: number | null }> = [];

async function pair(name: string, tag: string, first: object, second: object = first, gapMs = 6000) {
  const contents = [{ role: 'user' as const, parts: [{ text: `${big(`${tag}-${run}`)}\nSay ok.` }] }];
  await llm!.generate({ ...base, contents, ...first });
  await sleep(gapMs);
  const b = await llm!.generate({ ...base, contents, ...second });
  results.push({ case: name, input: b.usage.input, cachedOnRepeat: b.usage.cached });
  console.log(`${name}: ${b.usage.cached} of ${b.usage.input}`);
}

await pair('plain text', 'a', {});
await pair('plain text, 60 s later', 'b', {}, {}, 60_000);
await pair('structured output (responseSchema)', 'c', { responseSchema: schema });
await pair('tools', 'd', { tools, toolMode: 'ANY' });
await pair('tools, then restricted to one function', 'e', { tools, toolMode: 'ANY' }, { tools, toolMode: 'ANY', allowedFunctions: ['submit'] });
writeFileSync(join(RESULTS_DIR, 'cache-experiment.json'), JSON.stringify({ model: llm.model, measuredAt: new Date().toISOString(), results }, null, 2) + '\n');
