import { SYMBOLS, SCHEMES } from './_lib/catalog.js';
import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s08 — Portfolio values 100x too high.
 * Real cause: portfolio-service switched to a market-data endpoint that returns prices in paise
 * but kept treating them as rupees. A: config change to the v2 price endpoint (stocks x100).
 * B: feature flag for the v2 NAV endpoint (funds x100). Trap: a market-data-service deploy (A)
 * or a broker-connector config change (B) shortly before; market data itself is fine.
 */
export const s08: ScenarioDef = {
  id: 's08',
  slug: 'paise-rupee',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-13' : '2026-09-29';
    const changeAt = A ? ist(day, '11:02') : ist(day, '14:35');
    const share = A ? 0.55 : 0.45; // share of portfolio value in the affected asset class
    const b = world('s08', variant, {
      window: A ? { from: ist(day, '10:15'), to: ist(day, '12:30') } : { from: ist(day, '13:45'), to: ist(day, '16:15') },
    });
    b.protect(['portfolio-service', 'market-data-service'], addMin(changeAt, -300), b.window.to);

    if (A) {
      b.change({ at: changeAt, service: 'portfolio-service', type: 'config', summary: 'market-data client: price endpoint v1 -> v2 (batch prices, lower latency)', author: 'k.reddy', details: { key: 'marketdata.price_endpoint', from: 'v1', to: 'v2' } });
    } else {
      b.change({ at: changeAt, service: 'portfolio-service', type: 'feature_flag', summary: 'flag nav_v2_endpoint rollout 0% -> 100%', author: 'k.reddy', details: { flag: 'nav_v2_endpoint', from_pct: 0, to_pct: 100 } });
    }
    b.effect({ service: 'portfolio-service', metric: 'displayed_value_total_cr', from: changeAt, rampMin: 3, op: 'mul', value: 1 - share + share * 100 });
    b.effect({ service: 'portfolio-service', metric: 'latency_p50_ms', from: changeAt, rampMin: 3, op: 'mul', value: 0.9 });
    b.logStream({
      service: 'portfolio-service',
      from: addMin(changeAt, 1),
      to: b.window.to,
      perMin: (t) => 2.5 * Math.min(1.5, b.factor('investor', t)),
      sev: 'WARN',
      msg: (r) => `valuation sanity check: holdings value changed ${r.int(40, 100)}x since previous snapshot for u_${r.hex(8)}; serving anyway`,
      fields: (r) => ({ trace_id: r.hex(16), route: '/v1/portfolio' }),
    });
    // market-data serves the same numbers it always has; the v2 endpoint documents its unit.
    b.logStream({
      service: 'market-data-service',
      from: addMin(changeAt, 0.5),
      to: b.window.to,
      perMin: 1.2,
      sev: 'INFO',
      msg: (r) =>
        A
          ? `GET /v2/prices batch of ${r.int(20, 80)} symbols served (unit=paise) e.g. ${r.pick(SYMBOLS)}=${r.int(20000, 400000)}`
          : `GET /v2/nav served for "${r.pick(SCHEMES)}" (unit=paise) nav=${r.int(1500, 90000)}`,
      fields: (r) => ({ trace_id: r.hex(16), route: A ? '/v2/prices' : '/v2/nav' }),
    });
    b.logStream({
      service: 'market-data-service',
      from: b.dataFrom,
      to: changeAt,
      perMin: 0.6,
      sev: 'INFO',
      msg: (r) =>
        A
          ? `GET /v1/prices batch of ${r.int(20, 80)} symbols served (unit=INR) e.g. ${r.pick(SYMBOLS)}=${r.int(200, 4000)}.${r.int(10, 99)}`
          : `GET /v1/nav served for "${r.pick(SCHEMES)}" (unit=INR) nav=${r.int(15, 900)}.${r.int(1000, 9999)}`,
      fields: (r) => ({ trace_id: r.hex(16), route: A ? '/v1/prices' : '/v1/nav' }),
    });

    // Red herrings.
    if (A) {
      b.change({ at: ist(day, '10:40'), service: 'market-data-service', type: 'deploy', versionTo: '3.4.0', summary: 'release: price feed parser refactor', author: 'deploy-bot' });
    } else {
      b.change({ at: ist(day, '14:20'), service: 'broker-connector', type: 'config', summary: 'quotes cache TTL 1s -> 2s', author: 'v.rao', details: { key: 'quotes.cache_ttl_ms', from: 1000, to: 2000 } });
      b.logStream({
        service: 'market-data-service',
        from: ist(day, '14:00'),
        to: ist(day, '15:10'),
        perMin: 0.4,
        sev: 'WARN',
        msg: (r) => `price feed reconnecting (attempt ${r.int(1, 3)})`,
        fields: () => ({ provider: 'broker-api' }),
      });
    }
    b.setIncident({
      title: A ? 'Portfolio values about 100x too high' : 'Fund values shown 100x too high',
      reportedAt: ist(day, A ? '11:20' : '15:00').toISOString(),
      reportedBy: 'Customer support lead',
      severity: 'SEV1',
      summary: A
        ? 'Since about 11:00 IST users see wildly inflated portfolio values, e.g. a Rs 1.2 lakh portfolio showing Rs 1.2 crore. Stock holdings look ~100x. Several people suspect the price feed.'
        : 'Users report their mutual fund values are about 100x what they should be since ~14:35 IST. Stocks look right. Possibly a market data problem?',
      symptoms: ['portfolio values ~100x too high'],
      userImpact: 'Users see absurd values and P&L; panic and support load.',
      affectedSurface: 'Portfolio screen',
      suspectedServices: A ? ['market-data-service', 'broker-connector'] : ['market-data-service'],
      approxStart: changeAt.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['portfolio-service'],
            causeTypes: ['config_change'],
            mechanism: A
              ? 'portfolio-service switched to the v2 price endpoint (config change, 11:02 IST), which returns paise, but kept treating values as rupees: stock values x100.'
              : 'The nav_v2_endpoint flag (portfolio-service, 14:35 IST) switched to a NAV endpoint that returns paise, treated as rupees: fund values x100.',
          },
        ],
        scoring: 'top1_any',
        partialCredit: [],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'the portfolio-service change', match: { tool: 'get_changes', service: 'portfolio-service' } },
          { description: 'displayed value jump', match: { tool: 'query_metrics', service: 'portfolio-service', metric: 'displayed_value_total_cr' } },
        ],
        keyCounterevidence: [
          'market-data-service metrics are normal and it serves the same values; the v2 endpoint documents unit=paise.',
          A ? 'The market-data deploy at 10:40 IST is 22 minutes before the value jump at 11:02 IST.' : 'The broker-connector quotes cache change affects stock quotes, but only fund values jumped.',
        ],
        redHerrings: A ? ['market-data-service deploy at 10:40 IST'] : ['broker-connector quotes cache change at 14:20 IST', 'price feed reconnect warnings'],
        scriptedFaults: [],
        notes: 'Unit mismatch, not data corruption upstream.',
      },
    };
  },
};
