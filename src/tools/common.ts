import { toUtcIso } from '../util/canonical.js';
import { ToolInputError, type ToolContext } from './types.js';

export const HOUR = 3_600_000;

export function requireService(ctx: ToolContext, id: string): void {
  if (!ctx.services.has(id)) {
    const known = [...ctx.services.keys()].sort();
    throw new ToolInputError(`unknown service "${id}". Known services: ${known.join(', ')}`);
  }
}

/** Pure range validation (no data access): run in canonicalize, before any fault decision. */
export function validateRange(fromRaw: string, toRaw: string, maxSpanMs: number): { from: string; to: string } {
  const from = toUtcIso(fromRaw);
  const to = toUtcIso(toRaw);
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) throw new ToolInputError(`"from" (${fromRaw}) must be before "to" (${toRaw})`);
  if (span > maxSpanMs) {
    throw new ToolInputError(`time range is ${(span / HOUR).toFixed(1)} h; the maximum is ${maxSpanMs / HOUR} h. Narrow it.`);
  }
  return { from, to };
}

export interface ClampedWindow {
  from: string;
  to: string;
  requested: { from: string; to: string };
  clamped: boolean;
  fraction: number;
}

/** Validate a window and clamp it to the data the world retains. */
export function checkWindow(
  fromRaw: string,
  toRaw: string,
  maxSpanMs: number,
  retained: { from: string; to: string },
): ClampedWindow {
  const { from, to } = validateRange(fromRaw, toRaw, maxSpanMs);
  const span = Date.parse(to) - Date.parse(from);
  const cf = Math.max(Date.parse(from), Date.parse(retained.from));
  const ct = Math.min(Date.parse(to), Date.parse(retained.to));
  if (ct <= cf) {
    return { from, to: from, requested: { from, to }, clamped: true, fraction: 0 };
  }
  const clamped = cf !== Date.parse(from) || ct !== Date.parse(to);
  return {
    from: new Date(cf).toISOString(),
    to: new Date(ct).toISOString(),
    requested: { from, to },
    clamped,
    fraction: (ct - cf) / span,
  };
}

export function retentionNote(w: ClampedWindow, retained: { from: string; to: string }): string | null {
  if (!w.clamped) return null;
  return `Requested ${w.requested.from}..${w.requested.to}; data is retained only for ${retained.from}..${retained.to}, so ${w.from === w.to ? 'nothing in the range is available' : `only ${w.from}..${w.to} was searched`}.`;
}

/** Round to keep tool output compact without hiding magnitude. */
export function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v);
  if (a >= 100) return Math.round(v * 10) / 10;
  if (a >= 1) return Math.round(v * 100) / 100;
  return Math.round(v * 10000) / 10000;
}

export function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}
