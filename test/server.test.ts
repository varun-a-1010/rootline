import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { flowNodes, flowReplay } from '../src/flow/agentflow.js';
import { createApp } from '../src/server/app.js';
import { RunLimiter } from '../src/server/limits.js';
import { RunManager } from '../src/server/runs.js';
import { projectRoot } from '../src/util/paths.js';
import { fitScale, requiredWidth, treeDepth } from '../web/src/fit.js';
import { brain } from './helpers/brain.js';
import { run, SETTINGS, testDb } from './helpers/engine.js';

describe('Agentflow mapping (derived only from events)', () => {
  it('arm A: one root, parents before children, plan -> specialists -> reasoning (alsoFedBy) -> critic -> follow-ups -> reasoning v2 -> critic -> report', async () => {
    const r = await run('A', brain());
    const nodes = flowNodes(r.events);
    expect(nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    const seen = new Set<string>();
    for (const n of nodes) {
      if (n.parentId) expect(seen.has(n.parentId), `${n.id} parent ${n.parentId} must come first`).toBe(true);
      for (const a of n.alsoFedBy ?? []) expect(seen.has(a)).toBe(true);
      seen.add(n.id);
    }
    const byLabel = (re: RegExp) => nodes.filter((n) => re.test(n.label));
    const plan = byLabel(/^Plan$/)[0]!;
    const r1 = byLabel(/^Reasoning v1$/)[0]!;
    const c1 = byLabel(/^Critic round 1$/)[0]!;
    const r2 = byLabel(/^Reasoning v2$/)[0]!;
    expect(plan.parentId).toBe('run');
    const specialists0 = nodes.filter((n) => n.parentId === plan.id);
    expect(specialists0).toHaveLength(2);
    expect([r1.parentId, ...(r1.alsoFedBy ?? [])].sort()).toEqual(specialists0.map((n) => n.id).sort());
    expect(c1.parentId).toBe(r1.id);
    expect(c1.status).toBe('findings'); // the critic asked for more
    const followUps = nodes.filter((n) => n.parentId === c1.id);
    expect(followUps).toHaveLength(2);
    expect([r2.parentId, ...(r2.alsoFedBy ?? [])].sort()).toEqual(followUps.map((n) => n.id).sort());
    expect(byLabel(/^Report$/)[0]!.parentId).toBe(byLabel(/^Critic round 2$/)[0]!.id);
    // Captions are the latest tool call.
    expect(specialists0.some((n) => /query_(logs|metrics)|get_changes/.test(n.caption ?? ''))).toBe(true);
  });

  it('replay timestamps come from recorded events; runs over 90 s are compressed to about 60 s', async () => {
    const r = await run('A', brain());
    const rep = flowReplay(r.events);
    expect(rep.compression).toBe(1);
    for (const n of rep.nodes) expect(n.done).toBeGreaterThanOrEqual(n.spawn);
    const slow = r.events.map((e) => ({ ...e, ts: r.events[0]!.ts + (e.ts - r.events[0]!.ts) * 100_000 }));
    const s = flowReplay(slow as typeof r.events);
    expect(s.compression).toBeGreaterThan(1);
    expect(s.duration).toBeCloseTo(60, 0);
  });

  it('node labels are short names (the viewer gives each a fixed 176 px box in narrowing columns)', async () => {
    for (const arm of ['A', 'B', 'C', 'E'] as const) {
      const nodes = flowReplay((await run(arm, brain())).events).nodes;
      expect(nodes[0]!.label).toBe('Incident');
      for (const n of nodes) expect(n.label.length, `arm ${arm}: ${n.label}`).toBeLessThanOrEqual(16);
    }
  });

  it('a deep replay is laid out wide enough for its widest label, then scaled to the panel', () => {
    const chain = (n: number, label = 'Critic round 2') => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, parentId: i ? `n${i - 1}` : null, label }));
    expect(treeDepth(chain(9))).toBe(8);
    expect(treeDepth([{ id: 'r', parentId: null, label: 'Incident' }])).toBe(0);
    // Shallow runs fit as they are.
    expect(fitScale(requiredWidth(chain(5)), 1240)).toBe(1);
    // The deepest recorded run has depth 12: it is scaled, and at the required width the viewer's
    // own column rule, min(208, (width - 300) / depth), leaves room for the label and its clearance.
    const required = requiredWidth(chain(13));
    const s = fitScale(required, 1240);
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThan(0.6);
    expect(Math.min(208, (required - 300) / 12)).toBeGreaterThanOrEqual('Critic round 2'.length * 6.4 + 30);
  });

  it('baseline maps to root -> agent -> report; arm C has no critic nodes', async () => {
    const e = flowNodes((await run('E', brain())).events);
    expect(e.map((n) => [n.id === 'run' ? 'run' : n.label, n.parentId === null ? null : 'x'])).toEqual([
      ['run', null],
      ['Single agent', 'x'],
      ['Report', 'x'],
    ]);
    const c = flowNodes((await run('C', brain())).events);
    expect(c.some((n) => /Critic/.test(n.label))).toBe(false);
  });
});

describe('HTTP API (scripted models, no browser)', () => {
  async function makeApp(opts: { accessCode?: string; perIp?: number } = {}) {
    const { db, worldId } = await testDb();
    const root = mkdtempSync(join(tmpdir(), 'rootline-'));
    mkdirSync(join(root, 'eval', 'runs'), { recursive: true });
    mkdirSync(join(root, 'eval', 'results'), { recursive: true });
    mkdirSync(join(root, 'fixtures', 'v1', 'w_00000000'), { recursive: true });
    mkdirSync(join(root, 'eval', 'labels'), { recursive: true });
    writeFileSync(join(root, 'fixtures', 'v1', 'w_00000000', 'world.json'), '{}');
    writeFileSync(join(root, 'eval', 'labels', 's99-A.json'), '{"scenario":"s99"}');
    const runs = new RunManager(db, { llm: brain({ specialistDelayMs: 20 }), jev: null }, SETTINGS);
    const app = createApp({ db, runs, limiter: new RunLimiter(opts.perIp ?? 3, 40), accessCode: opts.accessCode, flowViewerUrl: 'https://flow.example.test', root });
    return { app, worldId, root };
  }

  it('serves health, config and incidents', async () => {
    const { app } = await makeApp();
    expect((await app.request('/healthz')).status).toBe(200);
    const cfg: any = await (await app.request('/api/config')).json();
    expect(cfg.arms.map((a: { id: string }) => a.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    // Arm D runs on the base frozen for the evaluation (eval/results/freeze.json: B).
    expect(JSON.parse(readFileSync(join(projectRoot(), 'eval', 'results', 'freeze.json'), 'utf8')).armDBase).toBe('B');
    expect(cfg.arms.find((a: { id: string }) => a.id === 'D').title).toBe('Jev-assisted (causes first)');
    const inc: any = await (await app.request('/api/incidents')).json();
    expect(inc.length).toBeGreaterThan(0);
  });

  it('requires the access code when set, and rate-limits live runs per address', async () => {
    const { app, worldId } = await makeApp({ accessCode: 'letmein', perIp: 1 });
    const post = (body: object) => app.request('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(body) });
    expect((await post({ worldId, arm: 'A' })).status).toBe(403);
    expect((await post({ worldId, arm: 'A', accessCode: 'nope' })).status).toBe(403);
    expect((await post({ worldId, arm: 'A', accessCode: 'letmein' })).status).toBe(202);
    expect((await post({ worldId, arm: 'A', accessCode: 'letmein' })).status).toBe(429);
    expect((await post({ worldId, arm: 'D', accessCode: 'letmein' })).status).toBe(503); // no Jev configured
    expect((await post({ arm: 'A', accessCode: 'letmein' })).status).toBe(400);
  });

  it('starts a run (by incident id), streams its events over SSE until the end, then serves state and flow', async () => {
    const { app } = await makeApp();
    const inc: any = await (await app.request('/api/incidents')).json();
    const res = await app.request('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ incidentId: inc[0].incident.incidentId, arm: 'A' }) });
    const { runId } = (await res.json()) as any;
    const sse = await app.request(`/api/runs/${runId}/events?after=0`);
    const text = await sse.text(); // ends when the run ends
    const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('report.ready');
    expect(types).toContain('run.terminated');
    expect(types.at(-1)).toBe('end');
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    const state: any = await (await app.request(`/api/runs/${runId}`)).json();
    expect(state.state.report.outcome).toBe('conclusive');
    const flow: any = await (await app.request(`/api/runs/${runId}/flow`)).json();
    expect(flow.nodes[0].parentId).toBeNull();
    expect(flow.replay.nodes.length).toBe(flow.nodes.length);
    // Resume after a sequence number.
    const resumed = await (await app.request(`/api/runs/${runId}/events?after=${ids.length - 2}`)).text();
    expect([...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([ids.length - 1, ids.length]);
  });

  it('serves recorded eval runs and their flow, and the fixture zip with evaluator-only labels separated', async () => {
    const { app, root } = await makeApp();
    const r = await run('E', brain());
    writeFileSync(join(root, 'eval', 'runs', 's99-A-E-r1.json'), JSON.stringify({ job: { key: 's99-A', arm: 'E', rep: 1 }, status: 'completed', environment: { promptHash: 'x' }, metrics: null, report: r.report, events: r.events }));
    const list: any = await (await app.request('/api/eval/runs')).json();
    expect(list[0].file).toBe('s99-A-E-r1.json');
    const one: any = await (await app.request('/api/eval/runs/s99-A-E-r1.json')).json();
    expect(one.state.report.generatedBy).toBe('baseline_agent');
    expect((await app.request('/api/eval/runs/..%2Fsecret.json')).status).toBe(404);
    const flow: any = await (await app.request('/api/eval/runs/s99-A-E-r1.json/flow')).json();
    expect(flow.replay.nodes.length).toBe(3);
    const zip = unzipSync(new Uint8Array(await (await app.request('/downloads/fixtures-v1.zip')).arrayBuffer()));
    expect(Object.keys(zip)).toContain('evaluator-only/labels/s99-A.json');
    expect(Object.keys(zip)).toContain('fixtures/v1/w_00000000/world.json');
    expect(strFromU8(zip['README.txt']!)).toContain('evaluator-only');
    expect((await app.request('/api/eval/summary')).status).toBe(404);
  });
});

it('the web app never talks to anything but the API, docs, downloads and the configured viewer', () => {
  // Cheap guard: no hard-coded hosts in the web source.
  const src = ['main.ts', 'flow.ts', 'md.ts'].map((f) => readFileSync(join(projectRoot(), 'web', 'src', f), 'utf8')).join('\n');
  expect(src).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
});
