import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GetDependenciesInput, QueryLogsInput, QueryMetricsInput } from '../src/contracts/tools.js';
import { toGeminiSchema } from '../src/llm/schema.js';

describe('zod -> Gemini schema subset', () => {
  it('converts tool inputs to the OpenAPI subset (no patterns, min/max or unions)', () => {
    for (const s of [QueryLogsInput, QueryMetricsInput, GetDependenciesInput]) {
      const g = toGeminiSchema(s);
      expect(g.type).toBe('OBJECT');
      const text = JSON.stringify(g);
      for (const banned of ['pattern', 'minimum', 'maximum', 'anyOf', 'oneOf', '$ref', 'additionalProperties', 'minLength']) {
        expect(text.includes(`"${banned}"`), banned).toBe(false);
      }
    }
    const logs = toGeminiSchema(QueryLogsInput);
    expect(logs.required).toEqual(['services', 'from', 'to']);
    expect(logs.properties!.services!.type).toBe('ARRAY');
    expect(logs.properties!.services!.items!.type).toBe('STRING');
    expect(logs.properties!.count_by!.enum).toContain('message');
    expect(logs.properties!.where!.items!.properties!.field!.enum).toContain('bank');
    expect(logs.properties!.from!.description).toContain('ISO-8601');
  });

  it('maps nullable, enums, nested arrays and literals', () => {
    const g = toGeminiSchema(
      z.object({
        a: z.string().nullable(),
        b: z.array(z.object({ k: z.enum(['x', 'y']), n: z.number().min(0).max(1), i: z.number().int() })),
        c: z.literal('fixed'),
        d: z.boolean().optional(),
      }),
    );
    expect(g.properties!.a).toMatchObject({ type: 'STRING', nullable: true });
    expect(g.properties!.b!.items!.properties!.k).toEqual({ type: 'STRING', enum: ['x', 'y'] });
    expect(g.properties!.b!.items!.properties!.n!.type).toBe('NUMBER');
    expect(g.properties!.b!.items!.properties!.i!.type).toBe('INTEGER');
    expect(g.properties!.c).toMatchObject({ type: 'STRING', enum: ['fixed'] });
    expect(g.required).toEqual(['a', 'b', 'c']);
  });

  it('rejects real unions (outside the subset) loudly', () => {
    expect(() => toGeminiSchema(z.object({ u: z.union([z.string(), z.number()]) }))).toThrow(/union/);
  });
});
