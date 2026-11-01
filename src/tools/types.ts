import type { z } from 'zod';
import type { ServiceInfo, WorldMeta } from '../contracts/world.js';
import type { Completeness, ToolName } from '../contracts/tools.js';
import type { Db } from '../db/client.js';

/** What a tool can see: the database scoped to one world (injected, never a parameter). */
export interface ToolContext {
  db: Db;
  worldId: string;
  world: WorldMeta;
  services: Map<string, ServiceInfo>;
}

/** Thrown for semantically invalid input (unknown service, bad window...). Not retryable. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface ToolOutput {
  /** Full records (the envelope). */
  records: unknown[];
  /** Compact per-record rendering for the model; same length and order as records. */
  modelRecords: unknown[];
  /** Stable source reference per record (log id, series key, change id ...). Same length. */
  refs: string[];
  services: string[];
  window: { from: string; to: string } | null;
  completeness: Completeness;
  coverage?: { requested: string; returned: string; fraction?: number };
  truncated: boolean;
  nextCursor?: string;
  notes: string[];
  /** Extra model-visible summary (e.g. log count totals). */
  summary?: Record<string, unknown>;
}

export interface PartialSpec {
  dropFraction?: number;
  truncateWindowFraction?: number;
  seed: string;
}

export interface ToolDef<I = any> {
  name: ToolName;
  /** e.g. "logs-store" */
  source: string;
  description: string;
  input: z.ZodType<I>;
  /** Apply defaults and normalize (UTC times, sorted sets). Throws ToolInputError. */
  canonicalize(input: I, ctx: ToolContext): Record<string, unknown>;
  execute(ctx: ToolContext, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput>;
  /** Optional custom record dropping for partial results (default: drop whole records). */
  drop?(out: ToolOutput, keep: (ref: string) => boolean): ToolOutput;
}
