import { afterEach, describe, expect, it } from 'vitest';
import type { ToolAttempt } from '../src/contracts/evidence.js';
import type { FaultProfile } from '../src/contracts/faults.js';
import { FaultInjector } from '../src/tools/faults.js';
import { fingerprintOf } from '../src/tools/runner.js';
import { ist } from '../scenarios/_lib/time.js';
import { FAST, makeRig, TEST_DAY, type TestRig } from './helpers/world.js';

const meta = { taskId: null, agent: 'test' };
const W = { from: ist(TEST_DAY, '09:00').toISOString(), to: ist(TEST_DAY, '10:30').toISOString() };
const rigs: TestRig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.db.close();
});

async function rig(...args: Parameters<typeof makeRig>) {
  const r = await makeRig(...args);
  rigs.push(r);
  return r;
}

describe('fault injection, retries and attempt records', () => {
  it('a timeout on attempt 1 is retried; attempt 2 succeeds; both attempts are recorded and the timeout really elapses', async () => {
    const seen: ToolAttempt[] = [];
    const r = await rig(
      [{ id: 'm-t1', tool: 'query_metrics', match: { servicesAny: ['order-service'] }, attempts: [1], effect: { kind: 'timeout' } }],
      FAST,
      { onAttempt: (a) => seen.push(a) },
    );
    const t0 = Date.now();
    const res = await r.runner.call('query_metrics', { service: 'order-service', metric: 'error_rate', ...W }, meta, r.signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.deadlineMs);
    expect(res.envelope.status).toBe('ok');
    expect(res.attempts.map((a) => [a.attempt, a.status, a.errorCode])).toEqual([
      [1, 'error', 'timeout'],
      [2, 'ok', null],
    ]);
    expect(seen).toHaveLength(2);
    expect(res.modelView.attempts).toBe(2);
  });

  it('a persistent timeout exhausts bounded retries (1 + 2) and yields a retryable error with no evidence', async () => {
    const r = await rig([{ id: 'm-all', tool: 'query_metrics', match: { servicesAny: ['database'] }, attempts: 'all', effect: { kind: 'timeout' } }]);
    const res = await r.runner.call('query_metrics', { service: 'database', metric: 'db_lock_wait_ms', ...W }, meta, r.signal);
    expect(res.envelope.status).toBe('error');
    expect(res.envelope.error).toMatchObject({ code: 'timeout', retryable: true });
    expect(res.attempts).toHaveLength(3);
    expect(res.evidence).toBeNull();
    expect(r.ledger.size).toBe(0);
  });

  it('unavailable and rate_limited errors are retried; invalid input is not', async () => {
    const r = await rig([
      { id: 'u', tool: 'get_changes', match: {}, attempts: [1, 2], effect: { kind: 'error', code: 'unavailable' } },
      { id: 'rl', tool: 'search_incidents', match: {}, attempts: [1], effect: { kind: 'error', code: 'rate_limited' } },
    ]);
    const ch = await r.runner.call('get_changes', W, meta, r.signal);
    expect(ch.attempts.map((a) => a.errorCode)).toEqual(['unavailable', 'unavailable', null]);
    expect(ch.envelope.status).toBe('ok');
    const hs = await r.runner.call('search_incidents', { text: 'orders' }, meta, r.signal);
    expect(hs.attempts.map((a) => a.errorCode)).toEqual(['rate_limited', null]);
    const bad = await r.runner.call('get_changes', { from: W.to, to: W.from }, meta, r.signal);
    expect(bad.attempts).toHaveLength(1);
    expect(bad.envelope.error?.retryable).toBe(false);
  });

  it('partial results pass through as completeness: partial and still become (partial) evidence', async () => {
    const r = await rig([
      { id: 'drop', tool: 'query_logs', match: { servicesAny: ['api-gateway'] }, attempts: 'all', effect: { kind: 'partial', dropFraction: 0.5 } },
      { id: 'trunc', tool: 'query_metrics', match: { servicesAny: ['api-gateway'] }, attempts: 'all', effect: { kind: 'partial', truncateWindowFraction: 0.25 } },
    ]);
    const full = await (await rig()).runner.call('query_logs', { services: ['api-gateway'], ...W, limit: 100 }, meta, r.signal);
    const part = await r.runner.call('query_logs', { services: ['api-gateway'], ...W, limit: 100 }, meta, r.signal);
    expect(part.envelope.status).toBe('partial');
    expect(part.envelope.completeness).toBe('partial');
    expect(part.envelope.records.length).toBeLessThan(full.envelope.records.length);
    expect(part.evidence?.completeness).toBe('partial');
    expect(part.attempts).toHaveLength(1); // partial is not retried

    const tr = await r.runner.call('query_metrics', { service: 'api-gateway', metric: 'request_rate', ...W }, meta, r.signal);
    expect(tr.envelope.status).toBe('partial');
    expect(tr.envelope.coverage?.fraction).toBe(0.25);
    expect((tr.modelView.notes as string[]).join(' ')).toContain('missing');
  });

  it('fault decisions depend on (request, attempt), never on call order', () => {
    const profile: FaultProfile = {
      seed: 'abc',
      latency: { minMs: 50, maxMs: 400 },
      transient: [{ p: 0.3, maxAttempt: 2, effect: { kind: 'timeout' } }],
      rules: [],
    };
    const requests = Array.from({ length: 40 }, (_, i) => ({ service: `svc-${i % 7}`, metric: `m${i}`, from: W.from, to: W.to }));
    const decideAll = (order: number[]) => {
      const inj = new FaultInjector(profile);
      const out = new Map<number, string>();
      for (const i of order) {
        const c = requests[i]!;
        const fp = fingerprintOf('query_metrics', c);
        out.set(i, JSON.stringify([1, 2, 3].map((a) => inj.decide('query_metrics', c, fp, a))));
      }
      return out;
    };
    const forward = decideAll(requests.map((_, i) => i));
    const backward = decideAll(requests.map((_, i) => requests.length - 1 - i));
    for (const [i, v] of forward) expect(backward.get(i)).toBe(v);
    const hits = [...forward.values()].filter((v) => v.includes('timeout')).length;
    expect(hits).toBeGreaterThan(5); // the transient fault actually fires
    // maxAttempt bounds transient faults: attempt 3 is never affected.
    for (const v of forward.values()) expect(JSON.parse(v)[2].effect).toBeNull();
  });

  it('cancellation aborts a tool call in flight', async () => {
    const r = await rig([{ id: 't', tool: 'query_logs', match: {}, attempts: 'all', effect: { kind: 'timeout' } }], { ...FAST, deadlineMs: 5000 });
    const ac = new AbortController();
    const p = r.runner.call('query_logs', { services: ['api-gateway'], ...W }, meta, ac.signal);
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
