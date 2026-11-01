import { z } from 'zod';
import { Completeness, ToolErrorCode } from './tools.js';

/**
 * One tool attempt (a row in tool_attempts). Every attempt is recorded, including retries,
 * timeouts and invalid input.
 */
export const ToolAttempt = z.object({
  attemptId: z.string(),
  callId: z.string(),
  tool: z.string(),
  canonicalParams: z.record(z.string(), z.unknown()),
  fingerprint: z.string(),
  attempt: z.number().int().min(1),
  status: z.enum(['ok', 'partial', 'error']),
  errorCode: ToolErrorCode.nullable(),
  latencyMs: z.number(),
  startedAt: z.number(),
  taskId: z.string().nullable(),
  agent: z.string().nullable(),
});
export type ToolAttempt = z.infer<typeof ToolAttempt>;

/**
 * Evidence = a source-linked tool result. IDs are minted by the tool runner, never by a model.
 * Every ok or partial result becomes one record; an empty complete result is evidence too
 * (a negative observation). Errors are gaps, not evidence.
 */
export const EvidenceRecord = z.object({
  evidenceId: z.string().regex(/^ev_\d+$/),
  tool: z.string(),
  callId: z.string(),
  request: z.record(z.string(), z.unknown()),
  services: z.array(z.string()),
  window: z.object({ from: z.string(), to: z.string() }).nullable(),
  retrievedAt: z.number(),
  completeness: Completeness,
  recordCount: z.number().int(),
  truncated: z.boolean(),
  /** Source record references: log ids, metric series keys, change ids, incident ids, edges. */
  sourceRefs: z.array(z.string()),
  /** Bounded human/model-readable excerpt of what came back. */
  excerpt: z.string(),
  notes: z.array(z.string()),
  taskId: z.string().nullable(),
  agent: z.string().nullable(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;
