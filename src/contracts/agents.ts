import { z } from 'zod';
import { CauseType, IsoTime, ServiceId } from './common.js';
import { ToolName } from './tools.js';

/** Structured results the agents exchange. Every one is zod-validated. */

export const EvidenceIds = z.array(z.string()).describe('Evidence ids (ev_N) from the ledger that this rests on.');

// ------------------------------------------------------------------------------ orchestrator

export const SpecialistRole = z.enum(['observability', 'dependency']);
export type SpecialistRole = z.infer<typeof SpecialistRole>;

export const PlannedTask = z.object({
  role: SpecialistRole,
  question: z.string().describe('What this task must find out.'),
  services: z.array(z.string()).describe('Services in scope.'),
  from: z.string().describe('Window start, ISO-8601 with offset.'),
  to: z.string().describe('Window end, ISO-8601 with offset.'),
  rationale: z.string().describe('What this establishes for the investigation.'),
  discriminates: z.array(z.string()).describe('Candidate hypothesis ids this task helps confirm or rule out (empty if none).'),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlanOutput = z.object({
  approach: z.string().describe('One or two sentences on the investigation strategy.'),
  tasks: z.array(PlannedTask).describe('2 to 6 independent tasks.'),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

// ------------------------------------------------------------------------------- specialists

export const Observation = z.object({
  statement: z.string(),
  kind: z.enum(['fact', 'inference']).describe('fact = directly shown by cited evidence; inference = your interpretation.'),
  evidenceIds: EvidenceIds,
});
export type Observation = z.infer<typeof Observation>;

export const Gap = z.object({
  description: z.string(),
  cause: z.enum(['tool_error', 'partial', 'no_data', 'out_of_budget']),
});
export type Gap = z.infer<typeof Gap>;

export const Findings = z.object({
  summary: z.string().describe('Short summary of what you found.'),
  observations: z.array(Observation),
  gaps: z.array(Gap).describe('What you could not establish and why.'),
  suggestedNextQueries: z.array(z.object({ tool: ToolName, purpose: z.string(), services: z.array(z.string()) })),
});
export type Findings = z.infer<typeof Findings>;

// --------------------------------------------------------------------------------- reasoning

export const Hypothesis = z.object({
  id: z.string().describe('Stable id like H1; keep ids across versions for the same cause.'),
  rank: z.number().int().min(1),
  cause: z.string().describe('The causal mechanism in one or two sentences.'),
  component: ServiceId.describe('The service where the fault lies.'),
  causeType: CauseType,
  onset: IsoTime.nullable().describe('When the cause began (ISO-8601 with offset), or null if unknown.'),
  confidence: z.number().min(0).max(1),
  confidenceRationale: z.string(),
  supportingEvidence: EvidenceIds,
  contradictingEvidence: EvidenceIds,
  assumptions: z.array(z.string()).describe('What must be true for this hypothesis that no evidence shows.'),
  missingEvidence: z.array(z.string()),
  discriminatingChecks: z.array(z.string()).describe('Checks that would confirm or rule this out.'),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const ReasoningOutput = z.object({
  hypotheses: z.array(Hypothesis).describe('1 to 5 competing hypotheses, ranked.'),
  dropped: z.array(z.object({ id: z.string(), reason: z.string() })).describe('Earlier hypotheses you now drop, with the reason.'),
  keyFacts: z.array(z.object({ statement: z.string(), evidenceIds: EvidenceIds })).describe('Facts that matter most, each with evidence.'),
  notes: z.string(),
});
export type ReasoningOutput = z.infer<typeof ReasoningOutput>;

/** Arm B: candidate causes proposed before any tool call. */
export const CandidatesOutput = z.object({
  candidates: z
    .array(
      z.object({
        id: z.string(),
        cause: z.string(),
        component: ServiceId,
        causeType: CauseType,
        whyPlausible: z.string(),
        wouldConfirm: z.string(),
        wouldRuleOut: z.string(),
      }),
    )
    .describe('3 or 4 candidate causes.'),
});
export type CandidatesOutput = z.infer<typeof CandidatesOutput>;

// ------------------------------------------------------------------------------------ critic

export const ObjectionType = z.enum(['unsupported_claim', 'chronology', 'alternative_unexplored', 'missing_data', 'overconfidence', 'counterevidence_ignored']);

export const FollowUpRequest = z.object({
  role: SpecialistRole,
  tool: ToolName,
  params_json: z.string().describe('The exact tool parameters as a JSON object string.'),
  purpose: z.string(),
  discriminates: z.array(z.string()).describe('Hypothesis ids this check discriminates between.'),
});
export type FollowUpRequest = z.infer<typeof FollowUpRequest>;

export const CriticOutput = z.object({
  decision: z.enum(['accept', 'investigate', 'insufficient_evidence']),
  rationale: z.string(),
  objections: z.array(z.object({ hypothesisId: z.string(), type: ObjectionType, detail: z.string(), evidenceIds: EvidenceIds })),
  followUps: z.array(FollowUpRequest).describe('Concrete tool calls to run next (required for investigate; at most 4).'),
});
export type CriticOutput = z.infer<typeof CriticOutput>;

// --------------------------------------------------------------------------------- reporting

export const ReportHypothesis = z.object({
  rank: z.number().int().min(1),
  id: z.string(),
  cause: z.string(),
  component: ServiceId,
  causeType: CauseType,
  confidence: z.number().min(0).max(1),
  status: z.enum(['supported', 'plausible', 'unresolved', 'ruled_out']),
  supportingEvidence: EvidenceIds,
  contradictingEvidence: EvidenceIds,
  rationale: z.string(),
});
export type ReportHypothesis = z.infer<typeof ReportHypothesis>;

/** What the reporting agent (and the baseline's submit_report) writes. */
export const ReportBody = z.object({
  outcome: z.enum(['conclusive', 'inconclusive']).describe('inconclusive when the evidence does not establish a cause.'),
  incidentSummary: z.string(),
  rootCauseStatement: z.string().describe('The most likely cause, or why it cannot be determined.'),
  hypotheses: z.array(ReportHypothesis).describe('Ranked; include ruled-out alternatives that mattered.'),
  facts: z.array(z.object({ statement: z.string(), evidenceIds: EvidenceIds })).describe('Directly shown by tool results; each cites evidence.'),
  inferences: z.array(z.object({ statement: z.string(), evidenceIds: EvidenceIds })),
  assumptions: z.array(z.object({ statement: z.string() })).describe('Believed but not shown by any evidence; cite nothing.'),
  timeline: z.array(z.object({ time: z.string(), event: z.string(), evidenceIds: EvidenceIds })),
  confidence: z.object({ overall: z.number().min(0).max(1), rationale: z.string() }),
  gaps: z.array(z.object({ description: z.string(), impact: z.string() })),
  recommendedActions: z.array(
    z.object({
      action: z.string().describe('A recommendation, never a claim that it was done.'),
      rationale: z.string(),
      verification: z.string().describe('How to verify it worked.'),
      priority: z.enum(['now', 'next', 'later']),
      evidenceIds: EvidenceIds,
    }),
  ),
  justification: z.string().describe('Required only if you report conclusive although the investigation stopped without critic acceptance; otherwise empty.'),
});
export type ReportBody = z.infer<typeof ReportBody>;

export const StopReason = z.enum([
  'critic_accepted',
  'critic_insufficient_evidence',
  'max_rounds',
  'no_new_evidence',
  'budget_tool_calls',
  'budget_llm_calls',
  'budget_tokens',
  'deadline',
  'cancelled',
  'unrecoverable_error',
  'completed',
]);
export type StopReason = z.infer<typeof StopReason>;

export const Report = ReportBody.omit({ outcome: true }).extend({
  outcome: z.enum(['conclusive', 'inconclusive', 'failed']),
  stopReason: StopReason,
  toolFailures: z.array(z.object({ tool: z.string(), request: z.string(), error: z.string(), attempts: z.number().int() })),
  citedEvidence: z.array(z.string()),
  honesty: z.object({
    criticAccepted: z.boolean().nullable(),
    downgraded: z.boolean(),
    inconsistencyFlag: z.boolean(),
    note: z.string(),
  }),
  ungroundedCitations: z.array(z.string()),
  generatedBy: z.enum(['reporting_agent', 'baseline_agent', 'code_fallback']),
});
export type Report = z.infer<typeof Report>;

export const TaskRole = z.enum(['orchestrator', 'candidates', 'observability', 'dependency', 'reasoning', 'critic', 'reporting', 'baseline']);
export type TaskRole = z.infer<typeof TaskRole>;

export const TaskSpec = z.object({
  id: z.string(),
  role: TaskRole,
  question: z.string(),
  scope: z.object({ services: z.array(z.string()), from: z.string(), to: z.string() }).nullable(),
  dependsOn: z.array(z.string()),
  round: z.number().int().min(0),
  origin: z.enum(['plan', 'followup', 'system', 'fallback']),
  rationale: z.string().nullable(),
  discriminates: z.array(z.string()),
  /** Follow-up tasks: the critic's exact tool call, executed first. */
  requestedCall: z.object({ tool: ToolName, params: z.record(z.string(), z.unknown()) }).nullable(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
