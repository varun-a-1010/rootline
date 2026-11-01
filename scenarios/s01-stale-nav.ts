import { SCHEMES } from './_lib/catalog.js';
import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s01 — Portfolio shows yesterday's values.
 * Real cause: the overnight NAV import (market-data-service, 23:30 IST) failed, so fund NAVs
 * were never refreshed. Trap (A): a portfolio-service deploy at 09:10, exactly when complaints
 * start. Trap (B): a cache TTL change for the NAV keyspace shortly before complaints.
 */
export const s01: ScenarioDef = {
  id: 's01',
  slug: 'stale-nav',
  dev: true,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-14' : '2026-09-23';
    const prevDay = A ? '2026-10-13' : '2026-09-22';
    const lastGoodNavDate = A ? '2026-10-12' : '2026-09-21';
    const failedImport = ist(prevDay, '23:30');
    const b = world('s01', variant, {
      window: A ? { from: ist(day, '07:30'), to: ist(day, '10:30') } : { from: ist(day, '08:00'), to: ist(day, '11:00') },
      preHours: A ? 9 : 9.5,
    });
    const nav = b.jobs.find((j) => j.name === 'nav-import')!;
    nav.failMsgs = A
      ? (r) => [
          { sev: 'INFO', msg: `nav-import: downloaded NAVAll.txt (${r.int(1900, 2100)} KB)`, afterMin: 1 },
          { sev: 'ERROR', msg: `nav-import: parse error at line ${r.int(8000, 9000)}: invalid NAV value 'N.A.' for scheme code ${r.int(118000, 119999)}`, afterMin: 2 },
          { sev: 'ERROR', msg: 'nav-import: aborting import; 0 of 14231 NAVs written, previous NAV set remains active', afterMin: 2.1 },
        ]
      : (r) => [
          { sev: 'INFO', msg: `nav-import: downloaded NAVAll.txt (${r.int(1900, 2100)} KB)`, afterMin: 1 },
          { sev: 'WARN', msg: 'nav-import: loaded 6210 of 14302 rows into staging; memory at 96% of limit', afterMin: 3 },
          { sev: 'ERROR', msg: 'nav-import: worker killed (OOMKilled, limit 512Mi); transaction rolled back, 0 NAVs committed', afterMin: 3.4 },
        ];
    b.jobOutcome('nav-import', failedImport, 'failed');
    b.protect(['market-data-service', 'portfolio-service', 'cache'], addMin(failedImport, -600), b.window.to);

    // Fund NAV lookups keep serving the last good NAV date.
    b.logStream({
      service: 'market-data-service',
      from: addMin(failedImport, 30),
      to: b.window.to,
      perMin: (t) => 0.15 * b.factor('investor', t),
      sev: 'INFO',
      msg: (r) => `NAV lookup served for "${r.pick(SCHEMES)}" (nav_date=${lastGoodNavDate})`,
      fields: (r) => ({ trace_id: r.hex(16), region: 'mum-a' }),
    });
    // Portfolio warns that fund NAVs are old once users start opening the app.
    b.logStream({
      service: 'portfolio-service',
      from: A ? ist(day, '06:30') : ist(day, '07:00'),
      to: b.window.to,
      perMin: (t) => 0.5 * b.factor('investor', t),
      sev: 'WARN',
      msg: (r) => `fund NAV older than 1 trading day for ${r.int(1, 9)} holdings (nav_date=${lastGoodNavDate}); showing last available NAV`,
      fields: (r) => ({ trace_id: r.hex(16), route: '/v1/portfolio' }),
    });

    if (A) {
      // Red herring: a portfolio-service release right when complaints start.
      const deployAt = ist(day, '09:10');
      b.change({
        at: deployAt,
        service: 'portfolio-service',
        type: 'deploy',
        versionTo: '7.3.0',
        summary: 'release: new portfolio summary card; valuation code refactor',
        author: 'k.reddy',
        details: { pipeline: 'build-58213', canary: '10% for 15m, promoted' },
      });
      b.effect({ service: 'portfolio-service', metric: 'latency_p95_ms', from: deployAt, rampMin: 5, op: 'mul', value: 1.22 });
      b.effect({ service: 'portfolio-service', metric: 'latency_p50_ms', from: deployAt, rampMin: 5, op: 'mul', value: 1.1 });
      b.logStream({
        service: 'portfolio-service',
        from: deployAt,
        to: addMin(deployAt, 40),
        perMin: 0.3,
        sev: 'WARN',
        msg: () => 'summary card: falling back to legacy layout (feature payload missing)',
        fields: (r) => ({ trace_id: r.hex(16), route: '/v1/portfolio' }),
      });
      b.addHistory({
        openedAt: ist('2026-09-24', '09:20').toISOString(),
        resolvedAt: ist('2026-09-24', '12:05').toISOString(),
        title: 'Fund NAVs not updated: AMFI published NAVs late',
        severity: 'SEV3',
        services: ['market-data-service', 'amfi-nav-feed', 'portfolio-service'],
        symptoms: 'Portfolio showed previous-day fund values in the morning.',
        rootCause: 'AMFI published the NAV file after our 23:30 IST import window; import found no new file.',
        resolution: 'Manual re-run of nav-import at 11:40 IST after the file appeared.',
        tags: ['nav', 'stale', 'amfi', 'external'],
      });
      b.setIncident({
        title: "Portfolio shows yesterday's values",
        reportedAt: ist(day, '09:40').toISOString(),
        reportedBy: 'Customer support lead',
        severity: 'SEV2',
        summary:
          "Since this morning many users say their portfolio shows yesterday's values. Complaints started around 09:10 IST, right when people open the app. Mostly mutual fund holdings; a few users say stock values look fine. No errors in the app.",
        symptoms: ['portfolio value unchanged since yesterday', 'mutual fund values look stale', 'no visible errors'],
        userImpact: 'Users see wrong current values and P&L for their fund holdings.',
        affectedSurface: 'Portfolio screen (holdings and P&L)',
        suspectedServices: ['portfolio-service'],
        approxStart: ist(day, '09:10').toISOString(),
      });
    } else {
      // Red herring: a cache TTL change for the NAV keyspace shortly before complaints.
      b.change({
        at: ist(day, '08:55'),
        service: 'cache',
        type: 'config',
        summary: 'raise TTL for nav keyspace 3600s -> 21600s (reduce load on market-data-service)',
        author: 'v.rao',
        details: { key: 'ttl.nav', from: 3600, to: 21600 },
      });
      b.effect({ service: 'cache', metric: 'cache_hit_rate', label: 'nav', from: ist(day, '08:55'), rampMin: 20, op: 'add', value: 3 });
      b.addHistory({
        openedAt: ist('2026-08-27', '10:10').toISOString(),
        resolvedAt: ist('2026-08-27', '11:30').toISOString(),
        title: 'Stale fund values after cache TTL misconfiguration',
        severity: 'SEV3',
        services: ['cache', 'portfolio-service'],
        symptoms: 'Fund values on portfolio lagged NAV updates by several hours.',
        rootCause: 'Cache TTL for the nav keyspace set to 24h by mistake.',
        resolution: 'TTL reverted; keyspace flushed.',
        tags: ['cache', 'nav', 'stale', 'config'],
      });
      b.setIncident({
        title: 'Mutual fund values not updating',
        reportedAt: ist(day, '10:20').toISOString(),
        reportedBy: 'On-call SRE',
        severity: 'SEV2',
        summary:
          "Users report mutual fund values in their portfolio haven't changed since yesterday. First tickets around 09:30 IST and growing. Stock holdings seem fine. Nothing obviously red on the dashboards.",
        symptoms: ['fund values unchanged since yesterday', 'fund P&L unchanged'],
        userImpact: 'Users see stale fund values and P&L.',
        affectedSurface: 'Portfolio screen (mutual funds)',
        suspectedServices: ['portfolio-service', 'cache'],
        approxStart: ist(day, '09:30').toISOString(),
      });
    }

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['market-data-service'],
            causeTypes: ['data_pipeline_failure'],
            mechanism: A
              ? `The overnight nav-import job in market-data-service (23:30 IST, ${prevDay}) aborted on a parse error and wrote 0 NAVs, so fund values still use the ${lastGoodNavDate} NAVs.`
              : `The overnight nav-import job in market-data-service (23:30 IST, ${prevDay}) was OOM-killed and rolled back, so fund values still use the ${lastGoodNavDate} NAVs.`,
          },
        ],
        scoring: 'top1_any',
        partialCredit: [
          { components: ['amfi-nav-feed'], causeTypes: ['upstream_dependency_degradation', 'data_pipeline_failure'], credit: 0.5, reason: 'Right pipeline, wrong side: the feed was delivered; our import failed.' },
          { components: ['job-scheduler'], causeTypes: ['data_pipeline_failure'], credit: 0.5, reason: 'Names the failed job but attributes it to the scheduler.' },
        ],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'nav-import failure logs', match: { tool: 'query_logs', service: 'market-data-service', contains: 'nav-import' } },
          { description: 'NAV age metric showing staleness since the failed import', match: { tool: 'query_metrics', service: 'market-data-service', metric: 'nav_age_s' } },
        ],
        keyCounterevidence: [
          A
            ? 'nav_age_s was already past 24 h and climbing well before the 09:10 IST portfolio-service deploy; the deploy only changed latency slightly.'
            : 'nav_age_s in market-data-service (the source) was already ~34 h before the 08:55 IST cache TTL change; the cache only serves what market-data publishes.',
          `NAV lookups report nav_date=${lastGoodNavDate}, i.e. the previous import's data.`,
        ],
        redHerrings: A ? ['portfolio-service deploy 7.3.0 at 09:10 IST', 'past incident: AMFI published NAVs late'] : ['cache nav TTL change at 08:55 IST', 'past incident: stale values from cache TTL'],
        scriptedFaults: [],
        notes: 'Background transient tool faults only.',
      },
    };
  },
};
