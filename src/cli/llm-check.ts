#!/usr/bin/env node
/**
 * Live checks for the model layer (brief §15 step 3): one structured call, one tool-loop call
 * (two turns, continuing with the model's parts verbatim) and one Jev call.
 *   doppler run -p shared -c dev_mac -- npx tsx src/cli/llm-check.ts
 * Prints model ids, versions, usage and the outputs — never credentials.
 */
import { z } from 'zod';
import { loadEnv } from '../config.js';
import { createLiveProviders } from '../llm/factory.js';
import { functionDeclaration } from '../llm/schema.js';
import { generateStructured } from '../llm/structured.js';
import type { Content } from '../llm/types.js';

async function main() {
  const env = loadEnv();
  const { llm, jev, problems } = createLiveProviders(env);
  for (const p of problems) console.log(`note: ${p}`);
  const signal = new AbortController().signal;
  const attempts: unknown[] = [];
  const onAttempt = (a: unknown) => attempts.push(a);

  if (llm) {
    // 1. Structured output.
    const Out = z.object({
      service: z.string(),
      likely_cause: z.enum(['deployment_regression', 'rate_limiting_or_quota', 'unknown']),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()),
    });
    const s = await generateStructured(
      llm,
      {
        role: 'check',
        system: 'You classify short incident notes. Answer in JSON only.',
        contents: [{ role: 'user', parts: [{ text: 'Note: order-service started returning 429 from the broker API at 09:15 when order volume doubled. No deploys today.' }] }],
        thinkingLevel: env.ROOTLINE_THINKING_LEVEL,
        signal,
        onAttempt,
      },
      Out,
    );
    console.log('structured:', JSON.stringify(s.value), '| repaired:', s.repaired, '| usage:', JSON.stringify(s.responses[0]!.usage), '| modelVersion:', s.responses[0]!.modelVersion);

    // 2. Tool loop: the model calls a tool, we answer, it calls the terminal function.
    const tools = [
      functionDeclaration('get_error_count', 'Errors for a service in the last hour.', z.object({ service: z.string() })),
      functionDeclaration('submit_findings', 'Submit the final answer.', z.object({ service: z.string(), errors: z.number().int(), summary: z.string() })),
    ];
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'How many errors did payout-service have in the last hour? Use the tool, then call submit_findings.' }] }];
    for (let turn = 1; turn <= 4; turn++) {
      const r = await llm.generate({ role: 'check-loop', system: 'Use tools. Finish by calling submit_findings.', contents, tools, toolMode: 'ANY', thinkingLevel: env.ROOTLINE_THINKING_LEVEL, signal, onAttempt });
      contents.push(r.content);
      const sigs = r.content.parts.filter((p) => p.thoughtSignature).length;
      console.log(`tool-loop turn ${turn}: calls=${JSON.stringify(r.functionCalls)} thoughtSignatures=${sigs} usage=${JSON.stringify(r.usage)}`);
      const done = r.functionCalls.find((c) => c.name === 'submit_findings');
      if (done) {
        console.log('tool-loop result:', JSON.stringify(done.args));
        break;
      }
      contents.push({
        role: 'user',
        parts: r.functionCalls.map((c) => ({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: { service: c.args.service, errors: 37 } } })),
      });
    }
  }

  if (jev) {
    const r = await jev.decide(
      { claim: 'payout-service is blocked on a database lock', evidence: 'database log: process 51234 still waiting for RowExclusiveLock on payout_instructions; blocked by process 48213 (ALTER TABLE ...)' },
      {
        supports: { type: 'noul', instructions: 'Does the evidence support the claim?' },
        kind: { type: 'choice', instructions: 'What kind of cause is this?', criteria: { lock: 'database lock contention', network: 'network failure', code: 'code bug' } },
      },
      { role: 'check', signal, onAttempt },
    );
    console.log('jev:', JSON.stringify(r.answers), '| usage:', JSON.stringify(r.usage), '| model:', r.model, '| latencyMs:', r.latencyMs);
  }
  console.log(`attempts recorded: ${attempts.length}`);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
