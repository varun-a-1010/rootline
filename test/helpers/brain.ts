import type { FollowUpRequest } from '../../src/contracts/agents.js';
import { ScriptedProvider, type Script, type ScriptStep } from '../../src/llm/scripted.js';
import { LlmError, type GenerateRequest } from '../../src/llm/types.js';
import { ist } from '../../scenarios/_lib/time.js';
import { TEST_DAY } from './world.js';

/**
 * A scripted "brain" for the test world: deterministic stand-ins for every agent role that
 * read the conversation (evidence ids in tool results and prompts) and answer like a model.
 */
export interface BrainOptions {
  criticDecisions?: Array<'accept' | 'investigate' | 'insufficient_evidence'>;
  followUps?: (round: number) => FollowUpRequest[];
  reportOutcome?: 'conclusive' | 'inconclusive';
  reportJustification?: string;
  specialistDelayMs?: number;
  failRole?: string;
  reasoningInvalidJson?: boolean;
  invalidCitation?: boolean;
  modelDelayMs?: number;
  baselineToolTurns?: number;
}

export const W = { from: ist(TEST_DAY, '09:00').toISOString(), to: ist(TEST_DAY, '10:30').toISOString() };

function text(req: GenerateRequest): string {
  return req.contents.flatMap((c) => c.parts.map((p) => p.text ?? JSON.stringify(p.functionResponse?.response ?? ''))).join('\n');
}

function evidenceIds(req: GenerateRequest): string[] {
  return [...new Set([...text(req).matchAll(/ev_\d+/g)].map((m) => m[0]))];
}

function lastIsToolResponse(req: GenerateRequest): boolean {
  const last = req.contents[req.contents.length - 1];
  return !!last && last.parts.some((p) => p.functionResponse);
}

export function defaultFollowUps(round: number): FollowUpRequest[] {
  return [
    {
      role: 'observability',
      tool: 'query_metrics',
      params_json: JSON.stringify({ service: 'broker-connector', metric: 'upstream_latency_p95_ms', from: W.from, to: W.to, group_by: 'endpoint', resolution: round === 1 ? '5m' : '15m' }),
      purpose: 'Check broker upstream latency by endpoint',
      discriminates: ['H1', 'H2'],
    },
    {
      role: 'dependency',
      tool: 'get_dependencies',
      params_json: JSON.stringify({ service: 'broker-connector', direction: 'downstream', depth: round }),
      purpose: 'Confirm what broker-connector calls',
      discriminates: ['H1'],
    },
  ];
}

export function brain(o: BrainOptions = {}): ScriptedProvider {
  const decisions = o.criticDecisions ?? ['investigate', 'accept'];
  const followUps = o.followUps ?? defaultFollowUps;
  const delay = o.modelDelayMs ?? 0;
  let criticN = 0;
  const specialist = (role: 'observability' | 'dependency'): Script => (req) => {
    if (o.failRole === role) return { error: new LlmError('invalid_output', 'scripted failure') };
    if (req.allowedFunctions?.length === 1) return { functionCalls: [{ name: 'submit_findings', args: findings(req, role) }] };
    if (!lastIsToolResponse(req)) {
      const calls =
        role === 'observability'
          ? [
              { name: 'query_logs', args: { services: ['broker-connector'], from: W.from, to: W.to, severity: ['ERROR'], contains: '429' } },
              { name: 'query_metrics', args: { service: 'broker-connector', metric: 'rate_limited_count', from: W.from, to: W.to, group_by: 'endpoint' } },
            ]
          : [{ name: 'get_changes', args: { services: ['order-service', 'broker-connector'], from: W.from, to: W.to } }];
      // Follow-up tasks: one extra call, then findings.
      if (text(req).includes('The critic requested this check')) return { functionCalls: [{ name: 'submit_findings', args: findings(req, role) }], delayMs: o.specialistDelayMs ?? delay };
      return { functionCalls: calls, delayMs: o.specialistDelayMs ?? delay };
    }
    return { functionCalls: [{ name: 'submit_findings', args: findings(req, role) }], delayMs: delay };
  };
  const scripts: Record<string, Script> = {
    candidates: () => ({ json: candidates() }),
    orchestrator: () => (o.failRole === 'orchestrator' ? { error: new LlmError('network', 'scripted plan failure') } : {
      delayMs: delay,
      json: {
        approach: 'Split by source.',
        tasks: [
          { role: 'observability', question: 'What do broker-connector logs and metrics show at the open?', services: ['broker-connector', 'order-service'], from: W.from, to: W.to, rationale: 'symptoms', discriminates: [] },
          { role: 'dependency', question: 'What changed around the open?', services: ['order-service', 'broker-connector'], from: W.from, to: W.to, rationale: 'changes', discriminates: [] },
        ],
      },
    }),
    observability: specialist('observability'),
    dependency: specialist('dependency'),
    reasoning: (req) => {
      if (o.failRole === 'reasoning') return { error: new LlmError('server', 'scripted reasoning failure') };
      if (o.reasoningInvalidJson) return { text: 'not json' };
      if (/Propose 3 or 4 candidate causes/.test(text(req))) return { json: candidates() };
      const ids = evidenceIds(req);
      return {
        delayMs: delay,
        json: {
          hypotheses: [
            { id: 'H1', rank: 1, cause: 'Broker rate limit hit at the open', component: 'broker-connector', causeType: 'rate_limiting_or_quota', onset: ist(TEST_DAY, '09:15').toISOString(), confidence: 0.8, confidenceRationale: 'many 429s', supportingEvidence: [ids[0] ?? 'ev_1', ...(o.invalidCitation ? ['ev_999'] : [])], contradictingEvidence: [], assumptions: [], missingEvidence: [], discriminatingChecks: [] },
            { id: 'H2', rank: 2, cause: 'order-service deploy regression', component: 'order-service', causeType: 'deployment_regression', onset: ist(TEST_DAY, '09:12').toISOString(), confidence: 0.2, confidenceRationale: 'deploy nearby', supportingEvidence: ids.slice(1, 2), contradictingEvidence: ids.slice(0, 1), assumptions: ['deploy affected orders'], missingEvidence: [], discriminatingChecks: [] },
          ],
          dropped: [],
          keyFacts: [{ statement: '429s on /orders', evidenceIds: ids.slice(0, 1) }],
          notes: '',
        },
      };
    },
    critic: () => {
      if (o.failRole === 'critic') return { error: new LlmError('invalid_output', 'scripted critic failure') };
      const d = decisions[Math.min(criticN, decisions.length - 1)]!;
      criticN += 1;
      return { delayMs: delay, json: { decision: d, rationale: `scripted ${d}`, objections: [], followUps: d === 'investigate' ? followUps(criticN) : [] } };
    },
    reporting: (req) => ({ json: reportBody(evidenceIds(req), o.reportOutcome ?? 'conclusive', o.reportJustification ?? '') }),
    baseline: (req, n) => {
      const turns = o.baselineToolTurns ?? 2;
      const onlyTerminal = req.allowedFunctions?.length === 1;
      if (n < turns && !onlyTerminal) return { functionCalls: [{ name: n === 0 ? 'query_logs' : 'get_changes', args: n === 0 ? { services: ['broker-connector'], from: W.from, to: W.to, contains: '429' } : { from: W.from, to: W.to } }], delayMs: delay };
      return { functionCalls: [{ name: 'submit_report', args: reportBody(evidenceIds(req), o.reportOutcome ?? 'conclusive', '') }] };
    },
  };
  return new ScriptedProvider(scripts);
}

function findings(req: GenerateRequest, role: string) {
  const ids = evidenceIds(req);
  return {
    summary: `${role} findings`,
    observations: [{ statement: `${role} saw something`, kind: 'fact', evidenceIds: ids.slice(0, 2) }],
    gaps: [],
    suggestedNextQueries: [],
  };
}

function candidates() {
  return {
    candidates: [
      { id: 'C1', cause: 'broker rate limit', component: 'broker-connector', causeType: 'rate_limiting_or_quota', whyPlausible: 'open burst', wouldConfirm: '429s', wouldRuleOut: 'no 429s' },
      { id: 'C2', cause: 'deploy regression', component: 'order-service', causeType: 'deployment_regression', whyPlausible: 'deploy', wouldConfirm: 'errors after deploy', wouldRuleOut: 'errors before deploy' },
      { id: 'C3', cause: 'database saturation', component: 'database', causeType: 'capacity_saturation', whyPlausible: 'load', wouldConfirm: 'lock waits', wouldRuleOut: 'normal db' },
    ],
  };
}

export function reportBody(ids: string[], outcome: 'conclusive' | 'inconclusive', justification: string) {
  return {
    outcome,
    incidentSummary: 'Orders failed at the open.',
    rootCauseStatement: 'Broker rate limiting.',
    hypotheses: [
      { rank: 1, id: 'H1', cause: 'Broker rate limit', component: 'broker-connector', causeType: 'rate_limiting_or_quota', confidence: 0.8, status: 'supported', supportingEvidence: ids.slice(0, 1), contradictingEvidence: [], rationale: 'r' },
      { rank: 2, id: 'H2', cause: 'Deploy', component: 'order-service', causeType: 'deployment_regression', confidence: 0.1, status: 'ruled_out', supportingEvidence: [], contradictingEvidence: ids.slice(0, 1), rationale: 'r' },
    ],
    facts: [
      { statement: '429s on /orders', evidenceIds: ids.slice(0, 1) },
      { statement: 'an uncited claim', evidenceIds: [] },
    ],
    inferences: [],
    assumptions: [],
    timeline: [{ time: '09:15 IST', event: 'open', evidenceIds: ids.slice(0, 1) }],
    confidence: { overall: 0.8, rationale: 'r' },
    gaps: [],
    recommendedActions: [{ action: 'Smooth the opening burst', rationale: 'r', verification: 'no 429s at next open', priority: 'now', evidenceIds: ids.slice(0, 1) }],
    justification,
  };
}

export type { ScriptStep };
