import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runToolLoop } from '../src/agents/specialist-loop.js';
import type { TaskSpec } from '../src/contracts/agents.js';
import { Budget, type LlmKind } from '../src/engine/budgets.js';
import type { RunContext } from '../src/engine/context.js';
import type { GenerateRequest } from '../src/llm/types.js';

/** A model that keeps calling query_logs until a request allows it nothing but the terminal function. */
function setup(maxLlmCalls: number) {
  const budget = new Budget({ maxToolCalls: 10, maxLlmCalls, maxTokens: 1_000_000, deadlineMs: 60_000, synthesisReserve: 0 });
  const requests: GenerateRequest[] = [];
  const ctx = {
    signal: new AbortController().signal,
    budget,
    generate: async (_task: string, kind: LlmKind, req: GenerateRequest) => {
      budget.takeLlmCall(kind);
      requests.push(req);
      const call = req.allowedFunctions ? { name: 'submit', args: { done: true } } : { name: 'query_logs', args: {} };
      return { content: { role: 'model', parts: [{ functionCall: call }] }, functionCalls: [call], text: '' };
    },
    callTool: async () => ({ evidence: null, modelView: { rows: [] } }),
  } as unknown as RunContext;
  const run = () =>
    runToolLoop(ctx, {
      task: { id: 't1' } as TaskSpec,
      agent: 'observability',
      system: 's',
      userText: 'u',
      tools: ['query_logs'],
      terminal: { name: 'submit', description: 'd', schema: z.object({ done: z.boolean() }) },
      maxToolCalls: 1,
      kind: 'specialist',
      finalKind: 'specialist',
    });
  return { requests, run };
}

describe('forced final turn', () => {
  it('keeps the request cacheable on the first try and restricts it only if the model ignores the notice', async () => {
    const { requests, run } = setup(10);
    const r = await run();
    expect(r.output).toEqual({ done: true });
    expect(requests.map((q) => q.allowedFunctions ?? null)).toEqual([null, null, ['submit']]);
  });

  it('restricts the first forced turn when the budget allows no second try', async () => {
    const { requests, run } = setup(2);
    const r = await run();
    expect(r.output).toEqual({ done: true });
    expect(requests.map((q) => q.allowedFunctions ?? null)).toEqual([null, ['submit']]);
  });
});
