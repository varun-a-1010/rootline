import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, fmtIst, ist } from './_lib/time.js';

/**
 * s06 — SIP debited twice.
 * Real cause: one bank slowed down, and a recently shortened confirmation timeout in
 * debit-worker made it resubmit debits that the slow bank later confirmed (no idempotency key).
 * Trap: an app release at 09:15 IST (A: mf-order-service; B: a bank-connector deploy at 05:50)
 * and a past double-debit incident with a different cause.
 */
export const s06: ScenarioDef = {
  id: 's06',
  slug: 'sip-double-debit',
  dev: true,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-05' : '2026-09-21';
    const bank = A ? 'kaveri' : 'northstar';
    const timeoutMs = A ? 3000 : 2500;
    const slowFrom = A ? ist(day, '06:20') : ist(day, '06:40');
    const slowTo = A ? ist(day, '08:05') : ist(day, '07:55');
    const b = world('s06', variant, { window: { from: ist(day, '05:45'), to: ist(day, '10:00') } });
    b.protect(['debit-worker', 'bank-connector', 'job-scheduler'], addMin(slowFrom, -4 * 24 * 60), b.window.to);

    // The shortened timeout (A: config change the evening before; B: a deploy three days before).
    if (A) {
      b.change({
        at: ist('2026-10-04', '18:40'),
        service: 'debit-worker',
        type: 'config',
        summary: `bank confirmation timeout 8000ms -> ${timeoutMs}ms (speed up the morning batch)`,
        author: 'm.bose',
        details: { key: 'bank.confirm_timeout_ms', from: 8000, to: timeoutMs },
      });
    } else {
      b.change({
        at: ist('2026-09-18', '17:20'),
        service: 'debit-worker',
        type: 'deploy',
        versionTo: '3.8.0',
        summary: `release: faster SIP batch (confirmation wait ${timeoutMs}ms, parallel presentment)`,
        author: 'm.bose',
        details: { pipeline: 'build-57720', canary: 'none' },
      });
    }
    b.editDependency('debit-worker', 'bank-connector', { timeoutMs, notes: 'resubmits a debit if no confirmation within the timeout' });

    // The bank slows down during the batch.
    b.effect({ service: 'bank-connector', metric: 'bank_latency_p95_ms', label: bank, from: slowFrom, to: slowTo, rampMin: 6, rampOutMin: 10, op: 'set', value: A ? 7800 : 6900, noise: 0.08 });
    b.effect({ service: 'bank-connector', metric: 'timeout_count', label: bank, from: slowFrom, to: slowTo, rampMin: 6, op: 'set', value: 4, noise: 0.3 });
    b.effect({ service: 'debit-worker', metric: 'retry_count', label: bank, from: slowFrom, to: slowTo, rampMin: 6, rampOutMin: 8, op: 'set', value: A ? 230 : 180, noise: 0.2 });
    b.effect({ service: 'debit-worker', metric: 'debit_count', label: bank, from: slowFrom, to: slowTo, rampMin: 6, rampOutMin: 8, op: 'mul', value: 1.45 });
    b.effect({ service: 'debit-worker', metric: 'latency_p95_ms', from: slowFrom, to: slowTo, rampMin: 6, op: 'set', value: timeoutMs, noise: 0.02 });

    b.logStream({
      service: 'debit-worker',
      from: slowFrom,
      to: slowTo,
      perMin: A ? 22 : 18,
      sev: 'WARN',
      msg: (r) => `debit DB-${r.int(10000000, 99999999)}: no confirmation from bank within ${timeoutMs}ms; resubmitting (attempt 2)`,
      fields: (r) => ({ trace_id: r.hex(16), bank, attempt: 2 }),
    });
    b.logStream({
      service: 'debit-worker',
      from: addMin(slowFrom, 1),
      to: addMin(slowTo, 3),
      perMin: A ? 14 : 11,
      sev: 'INFO',
      msg: (r) => `debit DB-${r.int(10000000, 99999999)} confirmed by bank (late response to attempt 1 after ${r.int(timeoutMs + 800, 9500)}ms)`,
      fields: (r) => ({ trace_id: r.hex(16), bank, attempt: 1 }),
    });
    b.logStream({
      service: 'bank-connector',
      from: slowFrom,
      to: slowTo,
      perMin: 6,
      sev: 'WARN',
      msg: (r) => `bank responded in ${r.int(5200, 9800)}ms (p95 budget 3000ms)`,
      fields: (r) => ({ trace_id: r.hex(16), bank, provider: 'bank-apis' }),
    });
    // The post-batch duplicate check finds pairs once the batch finishes.
    b.logStream({
      service: 'debit-worker',
      from: ist(day, '08:10'),
      to: b.window.to,
      perMin: 2.2,
      sev: 'ERROR',
      msg: (r) => `duplicate-check: mandate MD-${r.int(1000000, 9999999)} instalment ${day} has 2 confirmed debits (DB-${r.int(10000000, 99999999)}, DB-${r.int(10000000, 99999999)})`,
      fields: () => ({ bank, error_code: 'DUPLICATE_DEBIT' }),
    });

    // Red herrings.
    if (A) {
      b.change({ at: ist(day, '09:15'), service: 'mf-order-service', type: 'deploy', versionTo: '4.1.0', summary: 'release: SIP management screen v2 APIs', author: 'r.iyer' });
    } else {
      b.change({ at: ist(day, '05:50'), service: 'bank-connector', type: 'deploy', versionTo: '2.13.0', summary: 'release: new TLS client for bank APIs', author: 'deploy-bot' });
    }
    b.addHistory(
      A
        ? {
            openedAt: ist('2026-09-08', '08:50').toISOString(),
            resolvedAt: ist('2026-09-08', '13:00').toISOString(),
            title: 'SIP instalments debited twice',
            severity: 'SEV1',
            services: ['job-scheduler', 'debit-worker'],
            symptoms: 'About 3,000 users debited twice for the same SIP instalment.',
            rootCause: 'sip-debit-batch ran twice after a job-scheduler leader election.',
            resolution: 'Refunds issued; batch now takes a distributed lock.',
            tags: ['sip', 'debit', 'duplicate', 'scheduler'],
          }
        : {
            openedAt: ist('2026-08-14', '09:30').toISOString(),
            resolvedAt: ist('2026-08-14', '16:00').toISOString(),
            title: 'Double debit from bank duplicate presentment',
            severity: 'SEV1',
            services: ['bank-apis', 'bank-connector'],
            symptoms: 'Users of one bank debited twice for SIPs.',
            rootCause: "The bank's own batch presented our file twice.",
            resolution: 'Bank reversed duplicates.',
            tags: ['sip', 'debit', 'duplicate', 'bank', 'external'],
          },
    );
    b.setIncident({
      title: 'SIP instalments debited twice',
      reportedAt: ist(day, A ? '09:40' : '09:20').toISOString(),
      reportedBy: 'Payments support lead',
      severity: 'SEV1',
      summary: A
        ? 'Many users report their SIP instalment was debited twice from their bank account this morning (SMS from the bank shows two debits). Tickets started around 09:00 IST. We released the new SIP screen at 09:15 IST.'
        : 'Users report two debits for the same SIP instalment today, mostly customers of one bank. First tickets around 08:30 IST.',
      symptoms: ['two debits for one SIP instalment', 'bank SMS shows duplicate debits'],
      userImpact: 'Users charged twice; refunds needed.',
      affectedSurface: 'SIP autopay',
      suspectedServices: A ? ['mf-order-service', 'debit-worker'] : ['bank-connector', 'debit-worker'],
      approxStart: ist(day, A ? '09:00' : '08:30').toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['debit-worker'],
            causeTypes: ['retry_or_idempotency_bug', 'config_change', 'deployment_regression'],
            mechanism: `Bank ${bank} slowed down during the SIP batch; debit-worker's shortened confirmation timeout (${timeoutMs} ms) made it resubmit debits without an idempotency key, and the bank later confirmed both.`,
          },
        ],
        scoring: 'top1_any',
        partialCredit: [
          { components: ['bank-apis', 'bank-connector'], causeTypes: ['upstream_dependency_degradation'], credit: 0.5, reason: 'The bank slowdown is a contributing cause but not why debits were duplicated.' },
        ],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'resubmission logs', match: { tool: 'query_logs', service: 'debit-worker', contains: 'resubmitting' } },
          { description: 'the timeout change', match: { tool: 'get_changes', service: 'debit-worker' } },
        ],
        keyCounterevidence: [
          A ? 'The 09:15 IST release came after the debits (06:00-08:00 IST batch).' : 'The 05:50 IST bank-connector deploy did not slow other banks; only one bank was slow.',
          'job-scheduler shows sip-debit-batch ran once today, unlike the past double-run incident.',
        ],
        redHerrings: A ? ['mf-order-service release at 09:15 IST', 'past incident: batch ran twice'] : ['bank-connector deploy at 05:50 IST', 'past incident: bank duplicate presentment'],
        scriptedFaults: [],
        notes: `Slow bank: ${bank} from ${fmtIst(slowFrom)} to ${fmtIst(slowTo)}.`,
      },
    };
  },
};
