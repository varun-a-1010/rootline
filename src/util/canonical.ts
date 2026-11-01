import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so equal requests serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A deterministic number in [0, 1) derived from the inputs. */
export function hashUnit(...parts: Array<string | number>): number {
  const hex = sha256(parts.join('␟')).slice(0, 13); // 52 bits, exact in a double
  return parseInt(hex, 16) / 2 ** 52;
}

/** Canonical ISO form (UTC, millisecond precision) of a timestamp with an offset. */
export function toUtcIso(ts: string | Date): string {
  return (ts instanceof Date ? ts : new Date(ts)).toISOString();
}
