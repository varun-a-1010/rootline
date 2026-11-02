import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenRouterJev, type JevQuestion } from '../src/llm/jev.js';
import { costUsd } from '../src/llm/pricing.js';
import { ScriptedProvider } from '../src/llm/scripted.js';
import { generateStructured } from '../src/llm/structured.js';
import { LlmError, type LlmAttempt } from '../src/llm/types.js';
import { VertexGeminiProvider } from '../src/llm/vertex-gemini.js';

const signal = new AbortController().signal;

function vertex() {
  return new VertexGeminiProvider({ projectId: 'p', location: 'global', model: 'gemini-3.8-flash', backoffBaseMs: 1, tokenProvider: async () => 'tok' });
}

function okBody(parts: unknown[], usage?: Record<string, number>) {
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], ...(usage ? { usageMetadata: usage } : {}), modelVersion: 'gemini-3.8-flash-001' }), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('Vertex Gemini provider (3.8 Flash contract)', () => {
  it('sends thinkingLevel and never temperature/top_p/seed; drops thought parts from text; records usage', async () => {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return okBody([{ text: 'thinking...', thought: true }, { text: '{"a":1}' }], { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 });
    }));
    const r = await vertex().generate({ role: 'x', system: 's', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], thinkingLevel: 'medium', responseSchema: { type: 'OBJECT' }, signal });
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toEqual({ input: 10, output: 5, thinking: 7, cached: 0 });
    expect(r.modelVersion).toBe('gemini-3.8-flash-001');
    const gc = bodies[0]!.generationConfig;
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(gc.responseMimeType).toBe('application/json');
    for (const banned of ['temperature', 'topP', 'topK', 'seed', 'candidateCount', 'thinkingBudget']) expect(JSON.stringify(bodies[0])).not.toContain(banned);
  });

  it('missing usageMetadata is unknown (null), never 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okBody([{ text: 'x' }])));
    const r = await vertex().generate({ role: 'x', system: 's', contents: [], thinkingLevel: 'low', signal });
    expect(r.usage).toEqual({ input: null, output: null, thinking: null, cached: null });
  });

  it('retries 429 and 5xx with backoff (max 3 attempts) and records every attempt; never retries 400', async () => {
    const seq = [new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 }), new Response('oops', { status: 503 }), okBody([{ text: 'ok' }], { promptTokenCount: 1 })];
    vi.stubGlobal('fetch', vi.fn(async () => seq.shift()!));
    const attempts: LlmAttempt[] = [];
    const r = await vertex().generate({ role: 'x', system: 's', contents: [], thinkingLevel: 'low', signal, onAttempt: (a) => attempts.push(a) });
    expect(r.attempts).toBe(3);
    expect(attempts.map((a) => [a.status, a.httpStatus])).toEqual([['error', 429], ['error', 503], ['ok', 200]]);

    const f400 = vi.fn(async () => new Response('{"error":{"message":"bad"}}', { status: 400 }));
    vi.stubGlobal('fetch', f400);
    await expect(vertex().generate({ role: 'x', system: 's', contents: [], thinkingLevel: 'low', signal })).rejects.toMatchObject({ kind: 'bad_request' });
    expect(f400).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    await expect(vertex().generate({ role: 'x', system: 's', contents: [], thinkingLevel: 'low', signal })).rejects.toMatchObject({ kind: 'server', attempts: 3 });
  });

  it('keeps function-call parts verbatim (ids and thoughtSignature) for continuation', async () => {
    const parts = [{ functionCall: { id: 'call_1', name: 'query_logs', args: { services: ['a'] } }, thoughtSignature: 'abc' }];
    vi.stubGlobal('fetch', vi.fn(async () => okBody(parts, { promptTokenCount: 1 })));
    const r = await vertex().generate({ role: 'x', system: 's', contents: [], tools: [{ name: 'query_logs', description: 'd', parameters: { type: 'OBJECT' } }], thinkingLevel: 'low', signal });
    expect(r.content.parts).toEqual(parts);
    expect(r.functionCalls).toEqual([{ id: 'call_1', name: 'query_logs', args: { services: ['a'] } }]);
  });

  it('restricts allowed functions without changing the declarations', async () => {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return okBody([{ functionCall: { name: 'submit', args: {} } }], { promptTokenCount: 1 });
    }));
    const tools = [{ name: 'a', description: 'd', parameters: { type: 'OBJECT' as const } }, { name: 'submit', description: 'd', parameters: { type: 'OBJECT' as const } }];
    await vertex().generate({ role: 'x', system: 's', contents: [], tools, toolMode: 'ANY', allowedFunctions: ['submit'], thinkingLevel: 'low', signal });
    expect(bodies[0]!.tools[0].functionDeclarations).toHaveLength(2);
    expect(bodies[0]!.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['submit'] });
  });

  it('refuses to mix responseSchema with tools', async () => {
    await expect(vertex().generate({ role: 'x', system: 's', contents: [], responseSchema: { type: 'OBJECT' }, tools: [{ name: 't', description: 'd', parameters: { type: 'OBJECT' } }], thinkingLevel: 'low', signal })).rejects.toMatchObject({ kind: 'bad_request' });
  });
});

describe('structured output: zod re-validation and one repair call', () => {
  const S = z.object({ n: z.number().int().min(1) });
  it('repairs once with the validation error, then succeeds', async () => {
    const p = new ScriptedProvider({ r: [{ json: { n: 0 } }, { json: { n: 2 } }] });
    const out = await generateStructured(p, { role: 'r', system: 's', contents: [], thinkingLevel: 'low', signal }, S);
    expect(out.value).toEqual({ n: 2 });
    expect(out.repaired).toBe(true);
    const repairPrompt = JSON.stringify(p.calls[1]!.req.contents);
    expect(repairPrompt).toContain('failed validation');
  });
  it('fails with a typed error after one failed repair', async () => {
    const p = new ScriptedProvider({ r: [{ text: 'not json' }, { json: { n: -1 } }] });
    await expect(generateStructured(p, { role: 'r', system: 's', contents: [], thinkingLevel: 'low', signal }, S)).rejects.toBeInstanceOf(LlmError);
    expect(p.calls).toHaveLength(2);
  });
});

describe('Jev client (OpenRouter Decisions)', () => {
  const reply = (qs: Record<string, JevQuestion>) =>
    new Response(
      JSON.stringify({
        model: 'typesafe/jev-1.13-20260917',
        answers: Object.fromEntries(Object.keys(qs).map((k) => [k, { type: 'noul', noul: 0.8 }])),
        usage: { input_tokens: 100, output_tokens: 5, cost: 0.0000042 },
      }),
      { status: 200 },
    );

  it('sends model/state/questions, maps answers by name and batches large question sets', async () => {
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return reply(body.questions);
    }));
    const qs: Record<string, JevQuestion> = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `claim ${i}?` }]));
    const r = await new OpenRouterJev('key').decide({ evidence: 'x' }, qs, { role: 'judge', signal });
    expect(sent).toHaveLength(2);
    expect(sent[0].model).toBe('typesafe/jev-1.13');
    expect(sent[0].state).toEqual({ evidence: 'x' });
    expect(Object.keys(r.answers)).toHaveLength(55);
    expect(r.usage.input).toBe(200);
    expect(r.requests).toBe(2);
  });

  it('retries 429 and rejects responses with missing answers', async () => {
    const seq = [new Response('{"error":{"code":429}}', { status: 429 })];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => seq.shift() ?? reply(JSON.parse(String(init.body)).questions)));
    const r = await new OpenRouterJev('key', 'typesafe/jev-1.13', { backoffBaseMs: 1 }).decide({}, { a: { type: 'noul', instructions: 'x' } }, { role: 'j', signal });
    expect(r.answers.a).toEqual({ type: 'noul', noul: 0.8 });

    vi.stubGlobal('fetch', vi.fn(async () => reply({})));
    await expect(new OpenRouterJev('key').decide({}, { a: { type: 'noul', instructions: 'x' } }, { role: 'j', signal })).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});

describe('pricing', () => {
  it('computes cost with cached input discount and thinking billed as output; unknown usage -> null', () => {
    expect(costUsd('gemini-3.8-flash', { input: 1_000_000, output: 100_000, thinking: 100_000, cached: 500_000 })).toBeCloseTo(0.75 + 0.075 + 1.5, 6);
    expect(costUsd('gemini-3.8-flash', { input: null, output: 1, thinking: 1, cached: 0 })).toBeNull();
    expect(costUsd('typesafe/jev-1.13', { input: 1_000_000, output: 10, thinking: 0, cached: 0 })).toBeCloseTo(0.042, 6);
  });
});
