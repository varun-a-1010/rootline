import { z } from 'zod';
import { IsoTime } from './common.js';

/**
 * Fault profiles (fixtures/v1/<world>/faults.json). Loaded only by the fault layer
 * (src/tools/faults.ts) and never returned to agents.
 *
 * Matching is on the tool name, a predicate over the *canonical* request, and the attempt
 * number — never on call order — so every arm meets the same faults for the same request.
 */

export const FaultEffect = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('timeout') }),
  z.object({ kind: z.literal('error'), code: z.enum(['unavailable', 'rate_limited']) }),
  z.object({
    kind: z.literal('partial'),
    /** Drop this fraction of records (deterministically chosen). */
    dropFraction: z.number().min(0).max(1).optional(),
    /** Keep only the first fraction of the requested window. */
    truncateWindowFraction: z.number().min(0).max(1).optional(),
  }),
  z.object({ kind: z.literal('latency'), ms: z.number().int().min(0).max(5000) }),
]);
export type FaultEffect = z.infer<typeof FaultEffect>;

export const FaultMatch = z.object({
  /** Request mentions any of these services (services[] or service). */
  servicesAny: z.array(z.string()).optional(),
  /** query_metrics: metric name is one of these. */
  metricsAny: z.array(z.string()).optional(),
  /** Requested window overlaps this range. */
  windowOverlaps: z.object({ from: IsoTime, to: IsoTime }).optional(),
  /** query_logs/search_incidents: free-text filter present and contains any of these (case-insensitive). */
  textAny: z.array(z.string()).optional(),
});
export type FaultMatch = z.infer<typeof FaultMatch>;

export const FaultRule = z.object({
  id: z.string(),
  tool: z.string(),
  match: FaultMatch,
  /** Attempt numbers (1-based) this applies to, or 'all'. */
  attempts: z.union([z.array(z.number().int().min(1)), z.literal('all')]),
  effect: FaultEffect,
  note: z.string().optional(),
});
export type FaultRule = z.infer<typeof FaultRule>;

export const TransientFault = z.object({
  /** Probability per (tool, canonical request, attempt) — decided by hash, not by RNG state. */
  p: z.number().min(0).max(1),
  tools: z.array(z.string()).optional(),
  /** Only attempts up to this number are eligible (so retries usually recover). */
  maxAttempt: z.number().int().min(1),
  effect: FaultEffect,
});
export type TransientFault = z.infer<typeof TransientFault>;

export const FaultProfile = z.object({
  seed: z.string(),
  latency: z.object({ minMs: z.number().int().min(0), maxMs: z.number().int().min(0) }),
  transient: z.array(TransientFault),
  rules: z.array(FaultRule),
});
export type FaultProfile = z.infer<typeof FaultProfile>;
