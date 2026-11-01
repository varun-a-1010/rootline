import type { z } from 'zod';
import { toGeminiSchema } from './schema.js';
import { LlmError, type GenerateRequest, type GenerateResponse, type GeminiSchema, type LlmProvider } from './types.js';

const cache = new WeakMap<z.ZodType, GeminiSchema>();

function geminiSchemaFor(schema: z.ZodType): GeminiSchema {
  let g = cache.get(schema);
  if (!g) {
    g = toGeminiSchema(schema);
    cache.set(schema, g);
  }
  return g;
}

export interface StructuredResult<T> {
  value: T;
  /** Every model response, including a repair call if one was needed. */
  responses: GenerateResponse[];
  repaired: boolean;
}

/**
 * Structured output: responseSchema derived from zod, then re-validated with zod. On a
 * validation failure, one repair call that includes the error; if that fails too, a typed
 * LlmError('invalid_output').
 */
export async function generateStructured<T>(
  provider: LlmProvider,
  req: Omit<GenerateRequest, 'responseSchema' | 'tools' | 'toolMode'>,
  schema: z.ZodType<T>,
): Promise<StructuredResult<T>> {
  const responseSchema = geminiSchemaFor(schema);
  const first = await provider.generate({ ...req, responseSchema });
  const a = validate(first.text, schema);
  if (a.ok) return { value: a.value, responses: [first], repaired: false };

  const repairContents = [
    ...req.contents,
    first.content.parts.length ? first.content : { role: 'model' as const, parts: [{ text: first.text }] },
    {
      role: 'user' as const,
      parts: [{ text: `Your previous output failed validation:\n${a.error}\nReturn the complete corrected JSON object only.` }],
    },
  ];
  const second = await provider.generate({ ...req, contents: repairContents, responseSchema });
  const b = validate(second.text, schema);
  if (b.ok) return { value: b.value, responses: [first, second], repaired: true };
  const err = new LlmError('invalid_output', `output failed validation after one repair: ${b.error}`);
  (err as LlmError & { responses?: GenerateResponse[] }).responses = [first, second];
  throw err;
}

function validate<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON (${(e as Error).message}); output began: ${text.slice(0, 200)}` };
  }
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    error: r.error.issues
      .slice(0, 12)
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n'),
  };
}
