import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '../src/contracts/agents.js';
import { loadRunEvents } from '../src/engine/persistence.js';
import { fold } from '../src/engine/run-state.js';
import { Scheduler } from '../src/engine/scheduler.js';
import { sleep } from '../src/util/sleep.js';
import { brain } from './helpers/brain.js';
import { run, types } from './helpers/engine.js';

const spec = (id: string, dependsOn: string[] = []): TaskSpec => ({ id, role: 'observability', question: id, scope: null, dependsOn, round: 0, origin: 'plan', rationale: null, discriminates: [], requestedCall: null });

describe('scheduler', () => {
  it('runs independent tasks concurrently, respects dependencies, and failed deps do not block', async () => {
    const log: string[] = [];
    const s = new Scheduler(
      3,
      async (t) => {
        log.push(`start ${t.id}`);
        await sleep(t.id === 'a' ? 30 : 10);
        log.push(`end ${t.id}`);
        return t.id === 'b' ? 'failed' : 'completed';
      },
      new AbortController().signal,
    );
    s.add(spec('a'));
    s.add(spec('b'));
    s.add(spec('c', ['a', 'b']));
    await s.runUntilIdle();
    expect(log.slice(0, 2).sort()).toEqual(['start a', 'start b']);
    expect(log.indexOf('start c')).toBeGreaterThan(log.indexOf('end a'));
    expect(s.outcome('b')).toBe('failed');
    expect(s.outcome('c')).toBe('completed');
  });

  it('bounds concurrency', async () => {
    let running = 0;
    let peak = 0;
    const s = new Scheduler(2, async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(10);
      running--;
      return 'completed';
    }, new AbortController().signal);
    for (const id of ['a', 'b', 'c', 'd', 'e']) s.add(spec(id));
    await s.runUntilIdle();
    expect(peak).toBe(2);
  });
});

describe('arm A end-to-end (scripted models)', () => {
  it('plans, runs specialists in real parallel, critic follow-up creates a new round, then accepts and reports', async () => {
    const r = await run('A', brain({ specialistDelayMs: 60 }), { persist: true });
    const t = types(r);
    for (const x of ['run.created', 'plan.validated', 'task.scheduled', 'tool.attempt', 'evidence.recorded', 'hypotheses.updated', 'critic.checks', 'critic.decided', 'followup.scheduled', 'report.ready', 'run.terminated']) expect(t, x).toContain(x);
    expect(r.state.stopReason).toBe('critic_accepted');
    expect(r.report.outcome).toBe('conclusive');

    // Real overlap: both round-0 specialists started before either finished.
    const s0 = Object.values(r.state.tasks).filter((x) => (x.role === 'observability' || x.role === 'dependency') && x.round === 0);
    expect(s0).toHaveLength(2);
    const [a, b] = s0;
    expect(a!.startedAt! < b!.endedAt! && b!.startedAt! < a!.endedAt!).toBe(true);

    // The critic's follow-ups became round-1 tasks, executed their requested calls, then reasoning v2 and critic round 1.
    const r1 = Object.values(r.state.tasks).filter((x) => x.round === 1 && x.origin === 'followup');
    expect(r1).toHaveLength(2);
    expect(r1.every((x) => x.status === 'completed' && x.requestedCall !== null)).toBe(true);
    expect(r.state.toolResults.filter((x) => r1.some((y) => y.id === x.taskId)).length).toBe(2);
    expect(r.state.hypothesisVersions).toHaveLength(2);
    expect(r.state.criticDecisions.map((d) => d.decision)).toEqual(['investigate', 'accept']);

    // Evidence ids are minted by the runner, dense from ev_1.
    const ids = Object.keys(r.state.evidence).map((x) => Number(x.slice(3))).sort((x, y) => x - y);
    expect(ids[0]).toBe(1);
    expect(ids).toEqual(ids.map((_, i) => i + 1));

    // The report's uncited "fact" was moved to assumptions; every cited id exists.
    expect(r.report.assumptions.some((x) => x.statement.includes('an uncited claim'))).toBe(true);
    for (const id of r.report.citedEvidence) expect(r.state.evidence[id]).toBeDefined();

    // Persistence + replay: fold(persisted events) equals the live state.
    const persisted = await loadRunEvents(r.db, r.runId);
    expect(persisted).toHaveLength(r.events.length);
    expect(fold(persisted, r.runId)).toEqual(r.state);
  });

  it('invalid citations raise citation.invalid and are removed from the hypothesis', async () => {
    const r = await run('A', brain({ invalidCitation: true, criticDecisions: ['accept'] }));
    expect(r.state.citationInvalid.some((c) => c.evidenceId === 'ev_999' && c.agent === 'reasoning')).toBe(true);
    const h1 = r.state.hypothesisVersions[0]!.hypotheses.find((h) => h.id === 'H1')!;
    expect(h1.supportingEvidence).not.toContain('ev_999');
    expect(r.state.criticChecks[0]!.checks.find((c) => c.check === 'citation_validity')!.status).toBe('flag');
  });

  it('rejects non-novel follow-ups; with no valid follow-up the run stops with no_new_evidence', async () => {
    const W = { from: '2026-10-14T03:30:00.000Z', to: '2026-10-14T05:00:00.000Z' };
    const repeat = () => [
      // Same canonical request as the observability specialist's first call (different key order/offset).
      { role: 'observability' as const, tool: 'query_logs' as const, params_json: JSON.stringify({ contains: '429', severity: ['ERROR'], to: W.to, from: W.from, services: ['broker-connector'] }), purpose: 'repeat', discriminates: [] },
      { role: 'dependency' as const, tool: 'query_logs' as const, params_json: JSON.stringify({ services: ['order-service'], from: W.from, to: W.to }), purpose: 'wrong role', discriminates: [] },
      { role: 'observability' as const, tool: 'query_metrics' as const, params_json: '{not json', purpose: 'bad json', discriminates: [] },
    ];
    const r = await run('A', brain({ criticDecisions: ['investigate'], followUps: repeat }));
    const reasons = r.state.followupsRejected.map((x) => x.reason);
    expect(reasons.some((x) => x.startsWith('not novel'))).toBe(true);
    expect(reasons.some((x) => x.includes('not authorized'))).toBe(true);
    expect(reasons.some((x) => x.includes('not valid JSON'))).toBe(true);
    expect(r.state.stopReason).toBe('no_new_evidence');
  });
});

describe('termination reasons and the honesty rule', () => {
  it('critic_insufficient_evidence: a conclusive report without justification is downgraded to inconclusive and flagged', async () => {
    const r = await run('A', brain({ criticDecisions: ['insufficient_evidence'], reportOutcome: 'conclusive' }));
    expect(r.state.stopReason).toBe('critic_insufficient_evidence');
    expect(r.report.outcome).toBe('inconclusive');
    expect(r.report.honesty).toMatchObject({ downgraded: true, inconsistencyFlag: true, criticAccepted: false });
  });

  it('a conclusive report with a justification stays conclusive but is flagged', async () => {
    const r = await run('A', brain({ criticDecisions: ['insufficient_evidence'], reportOutcome: 'conclusive', reportJustification: 'The 429 evidence is direct and complete; the critic wanted an extra confirmation.' }));
    expect(r.report.outcome).toBe('conclusive');
    expect(r.report.honesty).toMatchObject({ downgraded: false, inconsistencyFlag: true });
  });

  it('max_rounds', async () => {
    const r = await run('A', brain({ criticDecisions: ['investigate'] }), { settings: { maxRounds: 2 } });
    expect(r.state.stopReason).toBe('max_rounds');
    expect(r.state.criticDecisions).toHaveLength(2);
  });

  it('budget_tool_calls: the budget is enforced and the run still reports', async () => {
    const r = await run('A', brain(), { settings: { maxToolCalls: 2 } });
    expect(r.state.toolResults.length).toBeLessThanOrEqual(2);
    expect(r.state.budgetExhausted.some((b) => b.budget === 'tool_calls')).toBe(true);
    expect(r.state.stopReason).toBe('budget_tool_calls');
    expect(r.report).toBeTruthy();
  });

  it('budget_llm_calls: never more than the limit plus the final report call', async () => {
    const r = await run('A', brain(), { settings: { maxLlmCalls: 6, synthesisReserve: 2 } });
    const calls = r.state.llmCalls.filter((c) => c.attempt === 1).length;
    expect(calls).toBeLessThanOrEqual(6 + 1);
    expect(r.state.stopReason).toBe('budget_llm_calls');
    expect(r.report.generatedBy).toBe('reporting_agent');
  });

  it('budget_tokens', async () => {
    const r = await run('A', brain(), { settings: { maxTokens: 2000 } });
    expect(r.state.stopReason).toBe('budget_tokens');
  });

  it('deadline: in-flight work is abandoned, the stop reason is deadline, and a report is still produced', async () => {
    const r = await run('A', brain({ modelDelayMs: 150 }), { settings: { deadlineMs: 400 } });
    expect(r.state.stopReason).toBe('deadline');
    expect(r.state.budgetExhausted.some((b) => b.budget === 'deadline')).toBe(true);
    expect(r.report).toBeTruthy();
  });

  it('cancelled: an external abort stops the run with a code-built report', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const r = await run('A', brain({ modelDelayMs: 100 }), { signal: ac.signal });
    expect(r.state.stopReason).toBe('cancelled');
    expect(r.state.status).toBe('cancelled');
    expect(r.report.generatedBy).toBe('code_fallback');
  });

  it('unrecoverable_error: reasoning fails twice -> outcome failed, code-built report clearly labeled', async () => {
    const r = await run('A', brain({ failRole: 'reasoning' }));
    const reasoning = Object.values(r.state.tasks).find((t) => t.role === 'reasoning')!;
    expect(reasoning.attempts).toBe(2);
    expect(reasoning.status).toBe('failed');
    expect(r.state.stopReason).toBe('unrecoverable_error');
    expect(r.report.outcome).toBe('failed');
    expect(r.report.generatedBy).toBe('code_fallback');
    expect(r.report.rootCauseStatement).toContain('generated by code');
  });

  it('completed: arm C has no critic and stops after one round', async () => {
    const r = await run('C', brain());
    expect(r.state.stopReason).toBe('completed');
    expect(r.state.criticDecisions).toHaveLength(0);
    expect(types(r)).not.toContain('critic.decided');
  });
});

describe('failure recovery', () => {
  it('a failed plan call falls back to the default plan and the run still investigates', async () => {
    const r = await run('A', brain({ failRole: 'orchestrator', criticDecisions: ['accept'] }));
    expect(r.state.planFallback).toBe(true);
    expect(r.state.toolResults.length).toBeGreaterThan(0);
    expect(r.state.stopReason).toBe('critic_accepted');
  });

  it('a failed specialist leaves a failed task and a gap; reasoning still runs on what exists', async () => {
    const r = await run('A', brain({ failRole: 'observability', criticDecisions: ['accept'] }));
    const obs = Object.values(r.state.tasks).filter((t) => t.role === 'observability' && t.round === 0);
    expect(obs.every((t) => t.status === 'failed')).toBe(true);
    expect(types(r)).toContain('task.failed');
    const reasoning = Object.values(r.state.tasks).find((t) => t.role === 'reasoning')!;
    expect(reasoning.status).toBe('completed');
    expect(r.state.stopReason).toBe('critic_accepted');
  });

  it('a failed critic does not lose the run: it stops with unrecoverable_error and the reporting agent still writes a report', async () => {
    const r = await run('A', brain({ failRole: 'critic' }));
    expect(r.state.stopReason).toBe('unrecoverable_error');
    expect(r.report.generatedBy).toBe('reporting_agent');
    expect(r.report.outcome).toBe('inconclusive'); // no critic acceptance, no justification
  });
});

describe('arm B (causes first)', () => {
  it('proposes candidates before any tool call and plans discriminating tasks', async () => {
    const r = await run('B', brain({ criticDecisions: ['accept'] }));
    const firstTool = r.events.findIndex((e) => e.type === 'tool.attempt');
    const cand = r.events.findIndex((e) => e.type === 'candidates.proposed');
    expect(cand).toBeGreaterThan(0);
    expect(cand).toBeLessThan(firstTool);
    expect(r.state.candidates?.candidates.length).toBeGreaterThanOrEqual(3);
    expect(r.state.stopReason).toBe('critic_accepted');
  });
});
