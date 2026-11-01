import { describe, expect, it } from 'vitest';
import type { ArmId } from '../src/contracts/events.js';
import { checkCitations } from '../src/engine/citations.js';
import { EvidenceLedger } from '../src/engine/ledger.js';
import { loadRunEvents } from '../src/engine/persistence.js';
import { fold } from '../src/engine/run-state.js';
import type { JevAnswer } from '../src/llm/jev.js';
import { ScriptedJev } from '../src/llm/scripted.js';
import { ScriptedProvider } from '../src/llm/scripted.js';
import { TOOL_NAMES } from '../src/contracts/tools.js';
import { brain, W } from './helpers/brain.js';
import { run } from './helpers/engine.js';

/** A Jev double: screening keeps records mentioning 429; the grid says 429 evidence supports H1. */
function scriptedJev(): ScriptedJev {
  return new ScriptedJev((state, questions) => {
    const st = state as { records?: Record<string, unknown>; evidence?: Record<string, string> };
    const out: Record<string, JevAnswer> = {};
    const recIds = st.records ? Object.keys(st.records) : [];
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') {
        const id = recIds[Number(k.slice(1))]!;
        out[k] = { type: 'noul', noul: JSON.stringify(st.records![id]).includes('429') ? 0.9 : 0.05 };
      } else if (q.type === 'choice') {
        const [ev, h] = k.split('__') as [string, string];
        const supports = h === 'H1' && (st.evidence?.[ev] ?? '').includes('429');
        const choice = supports ? 'supports' : 'neutral';
        out[k] = { type: 'choice', choice, confidence: 0.9, probabilities: { supports: supports ? 0.9 : 0.05, contradicts: 0.05, neutral: supports ? 0.05 : 0.9 } };
      }
    }
    return out;
  });
}

/** Observability that also pulls a noisy page of api-gateway logs (screening material). */
function noisyBrain() {
  const b = brain({ criticDecisions: ['accept'] });
  const inner = (b as unknown as { scripts: Record<string, (req: any, n: number) => any> }).scripts;
  const obs = inner.observability!;
  return new ScriptedProvider({
    ...inner,
    observability: (req: any, n: number) => {
      const step = obs(req, n);
      if (step.functionCalls?.[0]?.name === 'query_logs') {
        step.functionCalls.push({ name: 'query_logs', args: { services: ['api-gateway', 'broker-connector'], from: W.from, to: W.to, limit: 60 } });
      }
      return step;
    },
  });
}

describe('arm D (Jev-assisted)', () => {
  it('screens large results, grades evidence against hypotheses, checks citations; screened-out records stay in the ledger and citable', async () => {
    const r = await run('D', noisyBrain(), { jev: scriptedJev(), persist: true, armBase: 'A' });
    expect(r.state.config?.armBase).toBe('A');
    expect(r.state.config?.jevModel).toBe('scripted-jev');
    const kinds = r.state.jevDecisions.map((d) => d.kind);
    expect(kinds).toContain('screen');
    expect(kinds).toContain('grid');
    expect(kinds).toContain('citation_check');
    const screen = r.state.jevDecisions.find((d) => d.kind === 'screen' && (d.details.collapsed as string[]).length > 0)!;
    expect(screen).toBeDefined();
    const ev = r.state.evidence[screen.details.evidenceId as string]!;
    // The full result is in the ledger: every collapsed record is a source ref of that evidence.
    for (const id of screen.details.collapsed as string[]) expect(ev.sourceRefs).toContain(id);
    const ledger = new EvidenceLedger();
    for (const e of Object.values(r.state.evidence)) ledger.restore(e);
    expect(checkCitations([ev.evidenceId], ledger).valid).toEqual([ev.evidenceId]);
    // Jev usage is recorded per call.
    expect(r.state.jevCalls.length).toBeGreaterThan(0);
    expect(r.report).toBeTruthy();
    expect(fold(await loadRunEvents(r.db, r.runId), r.runId)).toEqual(r.state);
  });
});

describe('arm E (single-agent baseline)', () => {
  it('iterates with all five tools, then submits a report with the same schema and post-processing', async () => {
    const r = await run('E', brain({ baselineToolTurns: 3 }), { persist: true });
    expect(r.report.generatedBy).toBe('baseline_agent');
    expect(r.state.stopReason).toBe('completed');
    expect(r.state.toolResults.length).toBe(3);
    expect(r.state.tasks[Object.keys(r.state.tasks)[0]!]!.role).toBe('baseline');
    // Same report hygiene as the multi-agent arms.
    expect(r.report.assumptions.some((a) => a.statement.includes('an uncited claim'))).toBe(true);
    expect(fold(await loadRunEvents(r.db, r.runId), r.runId)).toEqual(r.state);
  });

  it('at the deadline it gets one final submit_report turn (never the multi-agent reporting agent)', async () => {
    const r = await run('E', brain({ baselineToolTurns: 50, modelDelayMs: 120 }), { settings: { deadlineMs: 400 } });
    expect(r.state.stopReason).toBe('deadline');
    expect(r.report.generatedBy).toBe('baseline_agent');
    expect(Object.values(r.state.tasks).some((t) => t.role === 'reporting')).toBe(false);
  });

  it('is forced to submit when its tool budget runs out, and the stop reason says so', async () => {
    const r = await run('E', brain({ baselineToolTurns: 10 }), { settings: { maxToolCalls: 2 } });
    expect(r.state.toolResults.length).toBeLessThanOrEqual(2);
    expect(r.state.stopReason).toBe('budget_tool_calls');
    expect(r.report.generatedBy).toBe('baseline_agent');
  });
});

describe('every arm (A-E): same tools per role, same budgets, persisted events and a final report', () => {
  it('runs end to end in every arm against the same seeded world', async () => {
    const configs: unknown[] = [];
    for (const arm of ['A', 'B', 'C', 'D', 'E'] as ArmId[]) {
      const llm = arm === 'D' ? noisyBrain() : brain({ criticDecisions: ['accept'] });
      const r = await run(arm, llm, { jev: arm === 'D' ? scriptedJev() : null, persist: true });
      expect(r.report, arm).toBeTruthy();
      expect(r.state.status, arm).toBe('completed');
      const persisted = await loadRunEvents(r.db, r.runId);
      expect(persisted.map((e) => e.type), arm).toEqual(r.events.map((e) => e.type));
      expect(persisted.at(-1)!.type).toBe('run.terminated');
      configs.push({ budgets: r.state.config!.budgets, model: r.state.config!.model, thinking: r.state.config!.thinkingLevel, prompts: r.state.config!.promptHash, fixtures: r.state.config!.fixtureHash });
      // Tool authorization: each role is only ever offered its own tools (+ its terminal function).
      for (const c of llm.calls) {
        const offered = (c.req.tools ?? []).map((t) => t.name).filter((n) => (TOOL_NAMES as readonly string[]).includes(n));
        if (c.role === 'observability') expect(offered.every((n) => ['query_logs', 'query_metrics'].includes(n))).toBe(true);
        if (c.role === 'dependency') expect(offered.every((n) => ['get_changes', 'get_dependencies', 'search_incidents'].includes(n))).toBe(true);
        if (c.role === 'baseline' && offered.length > 0) expect(offered.sort()).toEqual([...TOOL_NAMES].sort());
        if (['orchestrator', 'reasoning', 'critic', 'reporting'].includes(c.role)) expect(c.req.tools ?? []).toEqual([]);
      }
    }
    for (const c of configs) expect(c).toEqual(configs[0]);
  });
});
