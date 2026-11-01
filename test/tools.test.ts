import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolEnvelope } from '../src/contracts/tools.js';
import { ist } from '../scenarios/_lib/time.js';
import { makeRig, TEST_DAY, type TestRig } from './helpers/world.js';

const meta = { taskId: 't1', agent: 'test' };
const W = { from: ist(TEST_DAY, '09:00').toISOString(), to: ist(TEST_DAY, '10:30').toISOString() };

describe('tools: structured I/O and result semantics', () => {
  let rig: TestRig;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.db.close();
  });

  it('query_logs returns a complete, schema-valid envelope with an evidence id minted by the runner', async () => {
    const res = await rig.runner.call('query_logs', { services: ['broker-connector'], ...W, severity: ['ERROR'], contains: '429' }, meta, rig.signal);
    expect(() => ToolEnvelope.parse(res.envelope)).not.toThrow();
    expect(res.envelope.status).toBe('ok');
    expect(res.envelope.completeness).toBe('complete');
    expect(res.envelope.records.length).toBeGreaterThan(0);
    expect(res.evidence?.evidenceId).toMatch(/^ev_\d+$/);
    expect(res.envelope.evidenceId).toBe(res.evidence?.evidenceId);
    expect(rig.ledger.has(res.evidence!.evidenceId)).toBe(true);
    for (const r of res.envelope.records as Array<{ severity: string; message: string }>) {
      expect(r.severity).toBe('ERROR');
      expect(r.message.toLowerCase()).toContain('429');
    }
  });

  it('an empty complete result is evidence (a negative observation)', async () => {
    const res = await rig.runner.call('query_logs', { services: ['order-service'], ...W, contains: 'no-such-message-xyz' }, meta, rig.signal);
    expect(res.envelope.status).toBe('ok');
    expect(res.envelope.records).toHaveLength(0);
    expect(res.envelope.completeness).toBe('complete');
    expect(res.evidence).not.toBeNull();
    expect(res.evidence!.recordCount).toBe(0);
  });

  it('structured-field filters and count_by work', async () => {
    const res = await rig.runner.call(
      'query_logs',
      { services: ['broker-connector'], ...W, where: [{ field: 'status', value: '429' }], count_by: 'endpoint' },
      meta,
      rig.signal,
    );
    expect(res.envelope.status).toBe('ok');
    const groups = res.envelope.records as Array<{ key: string; count: number }>;
    expect(groups[0]!.key).toBe('orders');
    expect(groups[0]!.count).toBeGreaterThan(50);
  });

  it('paginates with a cursor without overlap, and marks truncation', async () => {
    const q = { services: ['api-gateway'], ...W, limit: 20 };
    const p1 = await rig.runner.call('query_logs', q, meta, rig.signal);
    expect(p1.envelope.truncated).toBe(true);
    expect(p1.envelope.nextCursor).toBeTruthy();
    const p2 = await rig.runner.call('query_logs', { ...q, cursor: p1.envelope.nextCursor }, meta, rig.signal);
    const ids1 = new Set((p1.envelope.records as Array<{ id: string }>).map((r) => r.id));
    const ids2 = (p2.envelope.records as Array<{ id: string }>).map((r) => r.id);
    expect(ids2.length).toBeGreaterThan(0);
    expect(ids2.some((id) => ids1.has(id))).toBe(false);
    // A cursor reused with different filters is rejected.
    const bad = await rig.runner.call('query_logs', { ...q, severity: ['WARN'], cursor: p1.envelope.nextCursor }, meta, rig.signal);
    expect(bad.envelope.error?.code).toBe('invalid_input');
  });

  it('invalid input is a non-retryable error with a useful message, recorded as one attempt, and never evidence', async () => {
    const attemptsBefore = rig.ledger.size;
    const res = await rig.runner.call('query_logs', { services: ['no-such-service'], ...W }, meta, rig.signal);
    expect(res.envelope.status).toBe('error');
    expect(res.envelope.error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect(res.envelope.error!.message).toContain('Known services');
    expect(res.attempts).toHaveLength(1);
    expect(res.evidence).toBeNull();
    expect(rig.ledger.size).toBe(attemptsBefore);

    const badTime = await rig.runner.call('query_metrics', { service: 'order-service', metric: 'error_rate', from: '09:00', to: W.to }, meta, rig.signal);
    expect(badTime.envelope.error?.code).toBe('invalid_input');
    expect(badTime.envelope.error?.message).toContain('from');
  });

  it('query_metrics returns series with stats; unknown metrics list what exists; group_by splits by label', async () => {
    const res = await rig.runner.call('query_metrics', { service: 'broker-connector', metric: 'rate_limited_count', ...W, group_by: 'endpoint' }, meta, rig.signal);
    expect(res.envelope.status).toBe('ok');
    const series = res.modelView.records as Array<{ labels: Record<string, string>; stats: { max: number } }>;
    const orders = series.find((s) => s.labels.endpoint === 'orders')!;
    const quotes = series.find((s) => s.labels.endpoint === 'quotes')!;
    expect(orders.stats.max).toBeGreaterThan(100);
    expect(quotes.stats.max).toBeLessThan(10);

    const unknown = await rig.runner.call('query_metrics', { service: 'broker-connector', metric: 'cpu', ...W }, meta, rig.signal);
    expect(unknown.envelope.error?.code).toBe('invalid_input');
    expect(unknown.envelope.error?.message).toContain('rate_limited_count');
  });

  it('a window beyond retained data is clamped and reported as partial coverage', async () => {
    const res = await rig.runner.call(
      'query_metrics',
      { service: 'order-service', metric: 'error_rate', from: ist(TEST_DAY, '04:00').toISOString(), to: ist(TEST_DAY, '09:30').toISOString() },
      meta,
      rig.signal,
    );
    expect(res.envelope.status).toBe('partial');
    expect(res.envelope.completeness).toBe('partial');
    expect(res.envelope.coverage?.fraction).toBeLessThan(1);
    expect(res.evidence?.completeness).toBe('partial');
  });

  it('get_changes, get_dependencies and search_incidents return structured records', async () => {
    const ch = await rig.runner.call('get_changes', { services: ['order-service'], ...W, change_types: ['deploy'] }, meta, rig.signal);
    expect((ch.envelope.records as Array<{ versionTo: string }>).some((c) => c.versionTo === '5.5.0')).toBe(true);

    const deps = await rig.runner.call('get_dependencies', { service: 'order-service', direction: 'downstream', depth: 2 }, meta, rig.signal);
    const edges = deps.envelope.records as Array<{ from: string; to: string; hop: number }>;
    expect(edges.some((e) => e.from === 'order-service' && e.to === 'broker-connector' && e.hop === 1)).toBe(true);
    expect(edges.some((e) => e.from === 'broker-connector' && e.to === 'broker-api' && e.hop === 2)).toBe(true);

    const hist = await rig.runner.call('search_incidents', { services: ['broker-connector'], text: 'orders failing market open' }, meta, rig.signal);
    expect((hist.envelope.records as Array<{ title: string }>)[0]!.title).toBe('Orders failing at market open');

    const none = await rig.runner.call('search_incidents', {}, meta, rig.signal);
    expect(none.envelope.error?.code).toBe('invalid_input');
  });

  it('naive (offset-less) source timestamps are returned as written and flagged, never normalized', async () => {
    // Insert a naive-IST line directly into this world: real 03:40 IST, written as "03:40",
    // indexed as 03:40Z (= 09:10 IST, inside the data range).
    const at = ist(TEST_DAY, '03:40');
    const naive = new Date(at.getTime() + 5.5 * 3_600_000);
    await rig.db.query(
      `INSERT INTO log_events (world_id, log_id, ts, source_timestamp, source_tz, service, severity, message, template, fields)
       VALUES ($1, 'lg_naive0001', $2, $3, NULL, 'order-service', 'INFO', 'naive line', 'naive line', '{}')`,
      [rig.world.meta.worldId, naive.toISOString(), naive.toISOString().slice(0, 23)],
    );
    const res = await rig.runner.call(
      'query_logs',
      { services: ['order-service'], from: ist(TEST_DAY, '09:05').toISOString(), to: ist(TEST_DAY, '09:15').toISOString(), contains: 'naive line' },
      meta,
      rig.signal,
    );
    const rec = (res.modelView.records as Array<Record<string, unknown>>)[0]!;
    expect(rec.t).toBe(naive.toISOString().slice(0, 23));
    expect(rec.tz).toBe('none');
    expect((res.modelView.notes as string[]).join(' ')).toContain('without a UTC offset');
  });
});
