import { z } from 'zod';
import type { FunctionDeclaration, GeminiSchema } from './types.js';

/**
 * zod -> Gemini schema (OpenAPI-3.0 subset: OBJECT/ARRAY/STRING/NUMBER/INTEGER/BOOLEAN,
 * properties, required, items, enum, nullable). zod's JSON Schema is the intermediate form.
 * Constraints outside the subset (patterns, min/max, lengths) are dropped here and enforced by
 * re-validating every response with the original zod schema.
 */
export function toGeminiSchema(schema: z.ZodType): GeminiSchema {
  const json = z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'throw', io: 'input' }) as JsonSchema;
  return convert(json, json, '$');
}

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  [k: string]: unknown;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  const def = m ? (root[m[1]!] as Record<string, JsonSchema> | undefined)?.[m[2]!] : undefined;
  if (!def) throw new Error(`unresolvable $ref ${ref}`);
  return def;
}

function convert(node: JsonSchema, root: JsonSchema, path: string): GeminiSchema {
  if (node.$ref) return convert(resolveRef(root, node.$ref), root, path);
  if (node.allOf && node.allOf.length === 1) return withDesc(convert(node.allOf[0]!, root, path), node.description);
  const union = node.anyOf ?? node.oneOf;
  if (union) {
    const nonNull = union.filter((u) => u.type !== 'null' && !(u.enum && u.enum.length === 1 && u.enum[0] === null));
    if (nonNull.length === 1) return { ...withDesc(convert(nonNull[0]!, root, path), node.description), nullable: true };
    throw new Error(`${path}: unions are outside the Gemini schema subset`);
  }
  let type = node.type;
  let nullable = node.nullable === true;
  if (Array.isArray(type)) {
    const t = type.filter((x) => x !== 'null');
    nullable = nullable || t.length !== type.length;
    if (t.length !== 1) throw new Error(`${path}: multi-type nodes are outside the subset`);
    type = t[0];
  }
  if (node.const !== undefined) return clean({ type: 'STRING', enum: [String(node.const)], description: node.description, nullable: nullable || undefined });
  const base: Partial<GeminiSchema> = { description: node.description, nullable: nullable || undefined };
  switch (type) {
    case 'object': {
      const props: Record<string, GeminiSchema> = {};
      for (const [k, v] of Object.entries(node.properties ?? {})) props[k] = convert(v, root, `${path}.${k}`);
      const keys = Object.keys(props);
      return clean({ ...base, type: 'OBJECT', properties: props, required: (node.required ?? []).filter((r) => keys.includes(r)), propertyOrdering: keys });
    }
    case 'array':
      if (!node.items) throw new Error(`${path}: array without items`);
      return clean({ ...base, type: 'ARRAY', items: convert(node.items, root, `${path}[]`) });
    case 'string':
      return clean({ ...base, type: 'STRING', enum: node.enum ? node.enum.map(String) : undefined });
    case 'number':
      return clean({ ...base, type: 'NUMBER' });
    case 'integer':
      return clean({ ...base, type: 'INTEGER' });
    case 'boolean':
      return clean({ ...base, type: 'BOOLEAN' });
    default:
      if (node.enum) return clean({ ...base, type: 'STRING', enum: node.enum.map(String) });
      throw new Error(`${path}: unsupported schema node ${JSON.stringify(node).slice(0, 120)}`);
  }
}

function withDesc(s: GeminiSchema, description?: string): GeminiSchema {
  return description && !s.description ? { ...s, description } : s;
}

function clean(s: Partial<GeminiSchema>): GeminiSchema {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && k !== 'required') continue;
    if (k === 'required' && Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as unknown as GeminiSchema;
}

export function functionDeclaration(name: string, description: string, params: z.ZodType): FunctionDeclaration {
  return { name, description, parameters: toGeminiSchema(params) };
}
