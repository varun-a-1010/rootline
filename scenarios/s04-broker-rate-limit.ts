import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s04 — Stock orders failing at the 09:15 IST market open.
 * Real cause: our opening order burst exceeds the broker API's per-second rate limit (429s).
 * Trap (A): order-service CPU near 90% looks like overload. Trap (B): database CPU and slow
 * queries spike at the open.
 */
export const s04: ScenarioDef = {
  id: 's04',
  slug: 'broker-rate-limit',
  dev: true,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-12' : '2026-09-14';
    const open = ist(day, '09:15');
    const end = A ? ist(day, '09:42') : ist(day, '09:51');
    const limit = A ? 400 : 300;
    const b = world('s04', variant, { window: { from: ist(day, '08:45'), to: ist(day, '10:45') } });
    b.protect(['order-service', 'broker-connector'], addMin(open, -180), b.window.to);

    // A bigger-than-usual opening burst (news-driven) runs into the broker's limit.
    b.effect({ service: 'order-service', metric: 'orders_per_min', from: addMin(open, -2), to: addMin(end, 8), rampMin: 2, rampOutMin: 8, op: 'mul', value: A ? 1.6 : 1.5 });
    b.effect({ service: 'order-service', metric: 'request_rate', from: addMin(open, -2), to: addMin(end, 8), rampMin: 2, rampOutMin: 8, op: 'mul', value: A ? 1.5 : 1.45 });
    b.effect({ service: 'broker-connector', metric: 'request_rate', from: addMin(open, -2), to: addMin(end, 8), rampMin: 2, rampOutMin: 8, op: 'mul', value: A ? 1.6 : 1.5 });
    b.effect({ service: 'broker-connector', metric: 'rate_limited_count', label: 'orders', from: open, to: end, rampMin: 1, rampOutMin: 4, op: 'set', value: A ? 720 : 540, noise: 0.25 });
    b.effect({ service: 'broker-connector', metric: 'retry_count', from: open, to: end, rampMin: 1, rampOutMin: 4, op: 'set', value: A ? 310 : 240, noise: 0.2 });
    b.effect({ service: 'broker-connector', metric: 'error_rate', from: open, to: end, rampMin: 1, rampOutMin: 4, op: 'add', value: A ? 14 : 11 });
    b.effect({ service: 'order-service', metric: 'order_success_rate', from: open, to: end, rampMin: 1, rampOutMin: 4, op: 'set', value: A ? 76 : 81, noise: 0.03 });
    b.effect({ service: 'order-service', metric: 'error_rate', from: open, to: end, rampMin: 1, rampOutMin: 4, op: 'add', value: A ? 19 : 15 });
    b.logStream({
      service: 'broker-connector',
      from: open,
      to: end,
      perMin: 10,
      sev: 'ERROR',
      msg: (r) => `POST /orders -> 429 Too Many Requests (limit ${limit} req/s; retry-after 1s) [sampled 1/${r.pick([50, 50, 100])}]`,
      fields: (r) => ({ trace_id: r.hex(16), provider: 'broker-api', endpoint: 'orders', status: 429 }),
    });
    b.logStream({
      service: 'order-service',
      from: addMin(open, 0.5),
      to: end,
      perMin: 8,
      sev: 'ERROR',
      msg: (r) => `order OR-${r.int(100000, 999999)} rejected: broker rate limit (429) after 2 retries`,
      fields: (r) => ({ trace_id: r.hex(16), route: '/v1/orders', status: 503, provider: 'broker-api' }),
    });

    if (A) {
      // Red herring: CPU close to 90% at the open looks like overload.
      b.effect({ service: 'order-service', metric: 'cpu_utilization', from: addMin(open, -1), to: addMin(end, 10), rampMin: 2, rampOutMin: 10, op: 'add', value: 24 });
      b.effect({ service: 'order-service', metric: 'latency_p95_ms', from: open, to: end, rampMin: 2, rampOutMin: 5, op: 'mul', value: 1.35 });
      b.logStream({
        service: 'order-service',
        from: open,
        to: addMin(open, 22),
        perMin: 1,
        sev: 'WARN',
        msg: (r) => `worker thread pool queue length ${r.int(130, 190)} above high watermark (128)`,
        fields: () => ({}),
      });
      b.addHistory({
        openedAt: ist('2026-08-31', '09:15').toISOString(),
        resolvedAt: ist('2026-08-31', '09:50').toISOString(),
        title: 'order-service CPU saturation at market open',
        severity: 'SEV2',
        services: ['order-service'],
        symptoms: 'Order latency 3 s and timeouts at the open; CPU pinned at 100%.',
        rootCause: 'Too few order-service replicas for the opening rush.',
        resolution: 'Raised autoscaling floor before 09:00 IST.',
        tags: ['orders', 'market-open', 'cpu', 'capacity'],
      });
      b.setIncident({
        title: 'Stock orders failing at market open',
        reportedAt: ist(day, '09:30').toISOString(),
        reportedBy: 'On-call SRE',
        severity: 'SEV1',
        summary:
          'Stock orders started failing at the 09:15 IST open; roughly a quarter of orders error out. order-service CPU is around 90%, so it looks like we are overloaded at the open.',
        symptoms: ['order placement errors at market open', 'high order-service CPU'],
        userImpact: 'Users cannot place stock orders at the open.',
        affectedSurface: 'Stock orders',
        suspectedServices: ['order-service'],
        approxStart: open.toISOString(),
      });
    } else {
      // Red herring: database CPU and slow queries spike at the open.
      b.effect({ service: 'database', metric: 'cpu_utilization', from: addMin(open, -1), to: addMin(end, 15), rampMin: 3, rampOutMin: 10, op: 'add', value: 38 });
      b.effect({ service: 'database', metric: 'slow_queries_per_min', from: open, to: addMin(end, 10), rampMin: 2, op: 'set', value: 26, noise: 0.25 });
      b.logStream({
        service: 'database',
        from: open,
        to: addMin(end, 10),
        perMin: 1.2,
        sev: 'WARN',
        msg: (r) => `slow query ${r.int(1100, 3200)}ms: SELECT ... FROM holdings WHERE user_id = $1 ORDER BY updated_at`,
        fields: () => ({}),
      });
      b.addHistory({
        openedAt: ist('2026-08-24', '09:16').toISOString(),
        resolvedAt: ist('2026-08-24', '10:02').toISOString(),
        title: 'Database CPU spike at market open from unindexed query',
        severity: 'SEV2',
        services: ['database', 'portfolio-service', 'order-service'],
        symptoms: 'Portfolio and order pages slow at the open; database CPU 95%.',
        rootCause: 'New holdings query without an index ran on every app open.',
        resolution: 'Added index.',
        tags: ['database', 'market-open', 'cpu', 'slow-query'],
      });
      b.setIncident({
        title: 'Orders erroring at the open',
        reportedAt: ist(day, '09:40').toISOString(),
        reportedBy: 'Trading desk lead',
        severity: 'SEV1',
        summary:
          'Many stock orders failed at the 09:15 IST open (about one in five). The database dashboard shows a CPU spike at the same time.',
        symptoms: ['order failures at the open', 'database CPU spike'],
        userImpact: 'Orders rejected at the open.',
        affectedSurface: 'Stock orders',
        suspectedServices: ['database', 'order-service'],
        approxStart: open.toISOString(),
      });
    }

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['broker-api', 'broker-connector', 'order-service'],
            causeTypes: ['rate_limiting_or_quota'],
            mechanism: `Our opening order burst exceeded the broker API's rate limit (${limit} req/s); the broker returned 429 on /orders and orders failed after retries.`,
          },
        ],
        scoring: 'top1_any',
        partialCredit: [],
        candidateCauses: [],
        requiredEvidence: [
          { description: '429 responses on /orders', match: { tool: 'query_metrics', service: 'broker-connector', metric: 'rate_limited_count' } },
          { description: '429 errors in broker-connector logs', match: { tool: 'query_logs', service: 'broker-connector', contains: '429' } },
        ],
        keyCounterevidence: A
          ? ['Failures are broker 429 rejections, not timeouts or 5xx; order-service latency rose only ~35% and quotes/holdings endpoints were not limited.']
          : ['Order failures are broker 429s; database slow queries are on holdings reads, not the order path.'],
        redHerrings: A ? ['order-service CPU ~90% at the open', 'past incident: CPU saturation at open'] : ['database CPU spike at the open', 'past incident: unindexed query at open'],
        scriptedFaults: [],
        notes: 'Background transient tool faults only.',
      },
    };
  },
};
