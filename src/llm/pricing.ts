import type { TokenUsage } from './types.js';

/**
 * Cost estimates (brief §5). Tokens are the primary measure; dollars are an estimate at the
 * standard rates below. Gemini 3.8 Flash: $1.50/M input, $7.50/M output (thinking billed as
 * output), cached input at 0.1x. Jev 1.13: $0.042/M input, output free (TypeSafe docs). Any
 * promotional credits are ignored.
 */
export interface RateCard {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number;
}

export const RATES: Record<string, RateCard> = {
  'gemini-3.8-flash': { inputPerM: 1.5, outputPerM: 7.5, cachedInputPerM: 0.15 },
  'typesafe/jev-1.13': { inputPerM: 0.042, outputPerM: 0, cachedInputPerM: 0.042 },
  'typesafe/jev-1.14': { inputPerM: 0.042, outputPerM: 0, cachedInputPerM: 0.042 },
  'scripted-flash': { inputPerM: 1.5, outputPerM: 7.5, cachedInputPerM: 0.15 },
  'scripted-jev': { inputPerM: 0.042, outputPerM: 0, cachedInputPerM: 0.042 },
};

/** USD for one model's usage; null if any needed count is unknown or the model has no rate. */
export function costUsd(model: string, u: TokenUsage): number | null {
  const r = RATES[model];
  if (!r || u.input === null || u.output === null || u.thinking === null || u.cached === null) return null;
  const freshInput = Math.max(0, u.input - u.cached);
  return (freshInput * r.inputPerM + u.cached * r.cachedInputPerM + (u.output + u.thinking) * r.outputPerM) / 1e6;
}
