import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, fmtIst, ist } from './_lib/time.js';

/**
 * s13 — Redemption payouts delayed.
 * Real cause: the payout batch is stuck waiting on a database lock (A: a schema migration's
 * ALTER TABLE; B: a reporting export holding row locks). Trap: the metrics tool keeps timing
 * out for payout-service and the database, so agents must retry or use logs, and disclose the
 * remaining gap.
 */
export const s13: ScenarioDef = {
  id: 's13',
  slug: 'payout-db-lock',
  dev: true,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-21' : '2026-09-09';
    const batchName = A ? 'payout-batch-am' : 'payout-batch-pm';
    const batchAt = ist(day, A ? '10:00' : '14:00');
    const lockAt = addMin(batchAt, A ? -4 : -10);
    const batchId = A ? 'PB-1021-AM' : 'PB-0909-PM';
    const queued = A ? 2412 : 1987;
    const b = world('s13', variant, {
      window: A ? { from: ist(day, '09:30'), to: ist(day, '12:15') } : { from: ist(day, '13:30'), to: ist(day, '16:15') },
    });
    b.protect(['payout-service', 'database', 'bank-connector'], addMin(batchAt, -300), b.window.to);
    b.jobOutcome(batchName, batchAt, 'skipped');

    if (A) {
      b.change({ at: lockAt, service: 'database', type: 'infra', status: 'in_progress', summary: 'schema migration 0142 started: ALTER TABLE payout_instructions ADD COLUMN utr_ref', author: 'deploy-bot', details: { migration: '0142', table: 'payout_instructions' } });
    } else {
      b.change({ at: lockAt, service: 'job-scheduler', type: 'job_schedule', summary: 'one-off job aum-export scheduled (monthly AUM export for auditors)', author: 't.das', details: { job: 'aum-export' } });
      b.log({ at: lockAt, service: 'job-scheduler', sev: 'INFO', msg: 'job aum-export started (run_9e1c22d0)', fields: { job: 'aum-export' } });
    }
    const blocker = A
      ? 'ALTER TABLE payout_instructions ADD COLUMN utr_ref text NOT NULL DEFAULT \'\''
      : 'SELECT ... FROM payout_instructions WHERE month = $1 FOR UPDATE (aum-export)';
    b.log({ at: addMin(batchAt, 0.1), service: 'payout-service', sev: 'INFO', msg: `payout batch ${batchId} started: ${queued} redemptions queued`, fields: { job: batchName } });
    b.logStream({
      service: 'payout-service',
      from: addMin(batchAt, 1),
      to: b.window.to,
      perMin: 0.5,
      sev: 'WARN',
      msg: (r, t) => `batch ${batchId}: waiting for lock on payout_instructions (${Math.round((t.getTime() - batchAt.getTime()) / 1000) + r.int(0, 20)}s)`,
      fields: () => ({ job: batchName }),
    });
    for (const m of [30, 60, 90, 120]) {
      const at = addMin(batchAt, m);
      if (at < b.window.to) b.log({ at, service: 'payout-service', sev: 'ERROR', msg: `batch ${batchId}: lock wait exceeded ${m * 60}s; 0 of ${queued} payouts sent; still waiting`, fields: { job: batchName } });
    }
    b.logStream({
      service: 'database',
      from: addMin(batchAt, 1),
      to: b.window.to,
      perMin: 0.4,
      sev: 'WARN',
      msg: (r, t) => `process ${r.int(51000, 51999)} still waiting for RowExclusiveLock on relation payout_instructions after 1000.0 ms; blocked by process 48213 (running ${Math.round((t.getTime() - lockAt.getTime()) / 60000)} min: ${blocker})`,
    });
    // Metrics consistent with the stall (but the metrics tool fails for these services).
    b.effect({ service: 'payout-service', metric: 'payouts_completed_per_min', from: batchAt, op: 'set', value: 0 });
    b.effect({ service: 'payout-service', metric: 'payouts_pending', from: batchAt, op: 'fn', fn: (v, t) => v + queued + ((t.getTime() - batchAt.getTime()) / 60000) * 6 });
    b.effect({ service: 'database', metric: 'db_lock_wait_ms', from: lockAt, op: 'set', value: 4200, noise: 0.2 });
    b.faultRule({ id: 'metrics-timeout', tool: 'query_metrics', match: { servicesAny: A ? ['payout-service', 'database'] : ['database'] }, attempts: 'all', effect: { kind: 'timeout' }, note: 'metrics backend overloaded for these series' });
    if (!A) b.faultRule({ id: 'payout-metrics-partial', tool: 'query_metrics', match: { servicesAny: ['payout-service'] }, attempts: 'all', effect: { kind: 'partial', truncateWindowFraction: 0.3 } });

    // Red herrings.
    b.logStream({
      service: 'bank-connector',
      from: addMin(batchAt, -20),
      to: addMin(batchAt, 40),
      perMin: 0.5,
      sev: 'WARN',
      msg: (r) => `payout API slow: ${r.int(3100, 4500)}ms`,
      fields: (r) => ({ trace_id: r.hex(16), bank: 'indus_valley', provider: 'bank-apis' }),
    });
    b.setIncident({
      title: 'Redemption payouts delayed',
      reportedAt: addMin(batchAt, A ? 55 : 70).toISOString(),
      reportedBy: 'Payments operations',
      severity: 'SEV2',
      summary: `The ${fmtIst(batchAt)} payout batch hasn't reached users; it usually finishes within 15 minutes. Users are asking where their redemption money is. Our metrics dashboards for payouts are not loading.`,
      symptoms: ['redemption payouts not received', 'payout batch not finishing', 'payout dashboards not loading'],
      userImpact: `About ${queued} users waiting for redemption money.`,
      affectedSurface: 'Redemptions (payouts)',
      suspectedServices: ['payout-service', 'bank-apis'],
      approxStart: batchAt.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['database', 'payout-service'],
            causeTypes: A ? ['infrastructure_failure', 'deployment_regression', 'config_change'] : ['infrastructure_failure', 'capacity_saturation'],
            mechanism: `The payout batch ${batchId} is blocked waiting for a lock on payout_instructions held by ${A ? 'a schema migration (ALTER TABLE ... ADD COLUMN utr_ref)' : 'the aum-export job (SELECT ... FOR UPDATE)'}; 0 payouts sent.`,
          },
        ],
        scoring: 'top1_any',
        partialCredit: A ? [] : [{ components: ['job-scheduler'], causeTypes: ['infrastructure_failure', 'capacity_saturation', 'config_change'], credit: 0.5, reason: 'Names the export job but not the lock it holds.' }],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'lock-wait logs from the batch', match: { tool: 'query_logs', service: 'payout-service', contains: 'lock' } },
          { description: 'blocking process in database logs', match: { tool: 'query_logs', service: 'database', contains: 'blocked by' } },
        ],
        keyCounterevidence: ['bank-connector shows slow payout API warnings, but no payouts were even sent: the batch never reached the bank.'],
        redHerrings: ['slow bank payout API warnings', 'payout dashboards (metrics) not loading'],
        scriptedFaults: [A ? 'query_metrics times out on every attempt for payout-service and database' : 'query_metrics times out for database and returns 30% of the window for payout-service'],
        notes: 'Conclusive only through logs or retries; the report must disclose the metrics gap.',
      },
    };
  },
};
