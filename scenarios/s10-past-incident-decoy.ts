import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s10 — Orders failing at market open, "again".
 * Real cause: our own connection-pool config change (A: DB pool max 100 -> 20; B: HTTP client
 * pool to broker-connector 200 -> 20) the previous Friday. At the open the pool saturates.
 * Trap: past incidents with identical symptoms were broker-side; the reporter assumes the same.
 */
export const s10: ScenarioDef = {
  id: 's10',
  slug: 'past-incident-decoy',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-19' : '2026-09-28';
    const open = ist(day, '09:15');
    const end = A ? ist(day, '09:56') : ist(day, '09:49');
    const b = world('s10', variant, { window: { from: ist(day, '08:45'), to: ist(day, '10:45') } });
    b.protect(['order-service', 'broker-connector', 'database'], addMin(open, -5 * 24 * 60), b.window.to);

    if (A) {
      b.change({
        at: ist('2026-10-16', '19:05'),
        service: 'order-service',
        type: 'config',
        summary: 'db pool: max_connections 100 -> 20 (reduce idle connections on primary)',
        author: 'r.iyer',
        details: { key: 'db.pool.max_connections', from: 100, to: 20 },
      });
      b.editDependency('order-service', 'database', { notes: 'connection pool: max 20' });
      b.effect({ service: 'order-service', metric: 'db_pool_in_use', from: addMin(open, -1), to: end, rampMin: 1, op: 'set', value: 20, noise: 0.001 });
      b.effect({ service: 'order-service', metric: 'db_pool_wait_ms', from: open, to: end, rampMin: 1, op: 'set', value: 1050, noise: 0.05 });
      b.effect({ service: 'database', metric: 'active_connections', from: b.dataFrom, op: 'mul', value: 0.78 });
    } else {
      b.change({
        at: ist('2026-09-25', '18:30'),
        service: 'order-service',
        type: 'config',
        summary: 'broker client: max_connections_per_host 200 -> 20 (align with service mesh defaults)',
        author: 'r.iyer',
        details: { key: 'broker_client.max_connections_per_host', from: 200, to: 20 },
      });
      b.editDependency('order-service', 'broker-connector', { notes: 'HTTP client pool: max 20 connections per host' });
      b.effect({ service: 'broker-connector', metric: 'request_rate', from: open, to: end, rampMin: 1, op: 'mul', value: 0.45 });
    }
    b.effect({ service: 'order-service', metric: 'error_rate', from: open, to: end, rampMin: 1, rampOutMin: 3, op: 'add', value: A ? 22 : 17 });
    b.effect({ service: 'order-service', metric: 'order_success_rate', from: open, to: end, rampMin: 1, rampOutMin: 3, op: 'set', value: A ? 73 : 79, noise: 0.03 });
    b.effect({ service: 'order-service', metric: 'latency_p95_ms', from: open, to: end, rampMin: 1, rampOutMin: 3, op: 'set', value: A ? 2100 : 3100, noise: 0.06 });
    b.logStream({
      service: 'order-service',
      from: open,
      to: end,
      perMin: 12,
      sev: 'ERROR',
      msg: (r) =>
        A
          ? `order OR-${r.int(100000, 999999)} failed: timeout acquiring DB connection (pool 20/20 in use, waited 1000ms)`
          : `order OR-${r.int(100000, 999999)} failed: timed out waiting for a connection to broker-connector (client pool 20/20 busy)`,
      fields: (r) => ({ trace_id: r.hex(16), route: '/v1/orders', status: 503 }),
    });

    // Decoys: past incidents with the same symptoms and a broker-side cause.
    b.addHistory({
      openedAt: ist(A ? '2026-09-21' : '2026-08-31', '09:16').toISOString(),
      resolvedAt: ist(A ? '2026-09-21' : '2026-08-31', '10:02').toISOString(),
      title: 'Orders failing at market open',
      severity: 'SEV1',
      services: ['order-service', 'broker-connector', 'broker-api'],
      symptoms: 'About 25% of stock orders failed from 09:15 IST; order-service errors and high latency.',
      rootCause: A ? 'Broker API outage at the exchange gateway.' : 'Broker API rate limit hit by our opening burst.',
      resolution: A ? 'Broker restored service; we added a broker status check to the runbook.' : 'Smoothed order submission at the open.',
      tags: ['orders', 'market-open', 'broker', 'external'],
    });
    b.addHistory({
      openedAt: ist(A ? '2026-08-17' : '2026-08-10', '09:15').toISOString(),
      resolvedAt: ist(A ? '2026-08-17' : '2026-08-10', '09:40').toISOString(),
      title: 'Order placement errors at the open',
      severity: 'SEV2',
      services: ['order-service', 'broker-api'],
      symptoms: 'Order errors in the first 20 minutes of trading.',
      rootCause: 'Broker API degraded (5xx) during the opening auction.',
      resolution: 'Broker fixed on their side.',
      tags: ['orders', 'market-open', 'broker'],
    });
    b.setIncident({
      title: 'Orders failing at market open again',
      reportedAt: ist(day, '09:35').toISOString(),
      reportedBy: 'On-call SRE',
      severity: 'SEV1',
      summary:
        'Stock orders failing again at the 09:15 IST open, same pattern as the broker outage last month: about a quarter of orders error out and latency is high. Probably the broker again.',
      symptoms: ['order failures at market open', 'high order latency'],
      userImpact: 'Users cannot place orders at the open.',
      affectedSurface: 'Stock orders',
      suspectedServices: ['broker-connector', 'broker-api'],
      approxStart: open.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['order-service'],
            causeTypes: ['config_change'],
            mechanism: A
              ? "A config change on Friday cut order-service's DB pool from 100 to 20 connections; at the open the pool saturated and orders timed out acquiring connections."
              : "A config change on Friday cut order-service's HTTP client pool to broker-connector to 20 connections; at the open requests timed out waiting for a connection.",
          },
        ],
        scoring: 'top1_any',
        partialCredit: [
          { components: ['order-service'], causeTypes: ['capacity_saturation'], credit: 0.5, reason: 'Finds the saturated pool but not the config change that caused it.' },
        ],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'pool exhaustion errors', match: { tool: 'query_logs', service: 'order-service', contains: 'pool' } },
          { description: 'the pool config change', match: { tool: 'get_changes', service: 'order-service' } },
        ],
        keyCounterevidence: [
          'broker-connector shows no 429s or upstream errors; broker latency is normal.',
          'Errors are connection-pool timeouts inside order-service, not broker rejections.',
        ],
        redHerrings: ['past incidents: broker outage/limit at the open', 'reporter suspects the broker'],
        scriptedFaults: [],
        notes: 'A similar past incident is a lead, not proof.',
      },
    };
  },
};
