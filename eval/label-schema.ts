import { z } from 'zod';
import { CauseType } from '../src/contracts/common.js';

/**
 * Answer keys (eval/labels/<key>.json). Generated alongside the fixtures, never imported by
 * src/ and never loaded into any database. Frozen before any held-out evaluation run.
 */
export const CauseKey = z.object({
  id: z.string(),
  /** Any of these components counts (equivalent framings of the same fault). */
  components: z.array(z.string()).min(1),
  causeTypes: z.array(CauseType).min(1),
  mechanism: z.string(),
});
export type CauseKey = z.infer<typeof CauseKey>;

export const Label = z.object({
  scenario: z.string(),
  variant: z.enum(['A', 'B']),
  key: z.string(),
  worldId: z.string(),
  split: z.enum(['dev', 'heldout']),
  title: z.string(),
  expectedOutcome: z.enum(['conclusive', 'inconclusive']),
  acceptableCauses: z.array(CauseKey),
  /**
   * top1_any: full credit if the top hypothesis matches any acceptable cause.
   * top2_all: full credit if the top two hypotheses together match every acceptable cause;
   *           half credit if the top hypothesis matches exactly one.
   */
  scoring: z.enum(['top1_any', 'top2_all']),
  partialCredit: z.array(
    z.object({ components: z.array(z.string()), causeTypes: z.array(CauseType), credit: z.number().min(0).max(1), reason: z.string() }),
  ),
  /** Inconclusive scenarios: the causes a good report should list as unresolved candidates. */
  candidateCauses: z.array(z.string()),
  requiredEvidence: z.array(
    z.object({
      description: z.string(),
      match: z.object({
        tool: z.string(),
        service: z.string().optional(),
        metric: z.string().optional(),
        /** Case-insensitive substring of the evidence excerpt. */
        contains: z.string().optional(),
      }),
    }),
  ),
  keyCounterevidence: z.array(z.string()),
  redHerrings: z.array(z.string()),
  /** Which tool failures are scripted (for the recovery metric). */
  scriptedFaults: z.array(z.string()),
  notes: z.string(),
});
export type Label = z.infer<typeof Label>;
