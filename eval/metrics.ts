import type { RunEvent } from '../src/contracts/events.js';
import { fold, type RunState } from '../src/engine/run-state.js';
import { costUsd } from '../src/llm/pricing.js';
import type { TokenUsage } from '../src/llm/types.js';

/** Per-run measurements derived only from the event log (never from model text). */
export interface RunMetrics {
  latencyMs: number | null;
  stageMs: Record<string, number>;
  toolCalls: number;
  toolAttempts: number;
  toolRetries: number;
  toolFailures: number;
  toolPartials: number;
  llmCalls: number;
  llmAttempts: number;
  llmErrors: number;
  llmCallsByRole: Record<string, number>;
  tokens: TokenUsage;
  tokensByRole: Record<string, TokenUsage>;
  tokensUnknownCalls: number;
  jev: { calls: number; questions: number; inputTokens: number | null; outputTokens: number | null; decisions: Record<string, number> };
  costUsd: { flash: number | null; jev: number | null; total: number | null };
  citations: { invalid: number; invalidByAgent: Record<string, number>; reportCited: number; reportUngrounded: number };
  stopReason: string | null;
  outcome: string | null;
  criticRounds: number;
  criticDecisions: string[];
  followUpsScheduled: number;
  followUpsRejected: number;
  evidenceRecords: number;
  evidencePartial: number;
  tasksFailed: number;
  modelVersions: string[];
}

const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

export function computeMetrics(events: RunEvent[], s: RunState = fold(events)): RunMetrics {
  const first = events[0]?.ts ?? null;
  const last = events.find((e) => e.type === 'run.terminated')?.ts ?? null;
  const stageMs: Record<string, number> = {};
  for (const t of Object.values(s.tasks)) {
    if (t.startedAt === null || t.endedAt === null) continue;
    stageMs[t.role] = (stageMs[t.role] ?? 0) + (t.endedAt - t.startedAt);
  }
  const ok = s.llmCalls.filter((c) => c.status === 'ok');
  const zero: TokenUsage = { input: 0, output: 0, thinking: 0, cached: 0 };
  let tokens: TokenUsage = { ...zero };
  const tokensByRole: Record<string, TokenUsage> = {};
  let unknown = 0;
  for (const c of ok) {
    const u = c.usage ?? { input: null, output: null, thinking: null, cached: null };
    if (u.input === null) unknown++;
    tokens = { input: add(tokens.input, u.input), output: add(tokens.output, u.output), thinking: add(tokens.thinking, u.thinking), cached: add(tokens.cached, u.cached) };
    const r = (tokensByRole[c.role] ??= { ...zero });
    tokensByRole[c.role] = { input: add(r.input, u.input), output: add(r.output, u.output), thinking: add(r.thinking, u.thinking), cached: add(r.cached, u.cached) };
  }
  const llmCallsByRole: Record<string, number> = {};
  for (const c of s.llmCalls.filter((x) => x.attempt === 1)) llmCallsByRole[c.role] = (llmCallsByRole[c.role] ?? 0) + 1;
  const model = s.config?.model ?? 'unknown';
  const flash = costUsd(model, tokens);
  const jevOk = s.jevCalls.filter((c) => c.status === 'ok');
  let jevIn: number | null = 0;
  let jevOut: number | null = 0;
  for (const c of jevOk) {
    jevIn = add(jevIn, c.usage?.input ?? null);
    jevOut = add(jevOut, c.usage?.output ?? null);
  }
  const jevCost = s.config?.jevModel && jevIn !== null ? costUsd(s.config.jevModel, { input: jevIn, output: jevOut ?? 0, thinking: 0, cached: 0 }) : 0;
  const decisions: Record<string, number> = {};
  for (const d of s.jevDecisions) decisions[d.kind] = (decisions[d.kind] ?? 0) + 1;
  const invalidByAgent: Record<string, number> = {};
  for (const c of s.citationInvalid) invalidByAgent[c.agent] = (invalidByAgent[c.agent] ?? 0) + 1;
  return {
    latencyMs: first !== null && last !== null ? last - first : null,
    stageMs,
    toolCalls: s.toolResults.length,
    toolAttempts: s.attempts.length,
    toolRetries: s.attempts.length - s.toolResults.length,
    toolFailures: s.toolResults.filter((r) => r.status === 'error').length,
    toolPartials: s.toolResults.filter((r) => r.status === 'partial').length,
    llmCalls: s.llmCalls.filter((c) => c.attempt === 1).length,
    llmAttempts: s.llmCalls.length,
    llmErrors: s.llmCalls.filter((c) => c.status === 'error').length,
    llmCallsByRole,
    tokens,
    tokensByRole,
    tokensUnknownCalls: unknown,
    jev: { calls: s.jevCalls.length, questions: s.jevCalls.reduce((n, c) => n + c.questions, 0), inputTokens: jevIn, outputTokens: jevOut, decisions },
    costUsd: { flash, jev: jevCost, total: flash === null || jevCost === null ? null : flash + jevCost },
    citations: {
      invalid: s.citationInvalid.filter((c) => c.evidenceId !== '').length,
      invalidByAgent,
      reportCited: s.report?.citedEvidence.length ?? 0,
      reportUngrounded: s.report?.ungroundedCitations.length ?? 0,
    },
    stopReason: s.stopReason,
    outcome: s.outcome,
    criticRounds: s.criticDecisions.length,
    criticDecisions: s.criticDecisions.map((d) => d.decision),
    followUpsScheduled: s.followupsScheduled.length,
    followUpsRejected: s.followupsRejected.length,
    evidenceRecords: Object.keys(s.evidence).length,
    evidencePartial: Object.values(s.evidence).filter((e) => e.completeness !== 'complete').length,
    tasksFailed: Object.values(s.tasks).filter((t) => t.status === 'failed').length,
    modelVersions: [...new Set(s.llmCalls.map((c) => c.modelVersion).filter((v): v is string => !!v))],
  };
}
