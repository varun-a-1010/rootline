import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s09 — Autopay setup failing "for some users".
 * Real cause: one bank's mandate API is failing (A: sahyadri timeouts; B: gomti rejecting with
 * a risk-rule error). Overall success still looks near-normal unless split by bank.
 * Trap: a mandate-service deploy (A) / npci client config change (B) just before, and a past
 * NPCI outage.
 */
export const s09: ScenarioDef = {
  id: 's09',
  slug: 'one-bank-mandates',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-15' : '2026-09-17';
    const bank = A ? 'sahyadri' : 'gomti';
    const onset = A ? ist(day, '10:10') : ist(day, '13:40');
    const b = world('s09', variant, {
      window: A ? { from: ist(day, '09:30'), to: ist(day, '12:30') } : { from: ist(day, '13:00'), to: ist(day, '16:00') },
    });
    b.protect(['mandate-service', 'bank-connector'], addMin(onset, -240), b.window.to);

    b.effect({ service: 'mandate-service', metric: 'mandate_success_rate', label: bank, from: onset, rampMin: 4, op: 'set', value: A ? 68 : 54, noise: 0.05 });
    b.effect({ service: 'mandate-service', metric: 'error_rate', from: onset, rampMin: 4, op: 'add', value: A ? 2.6 : 5 });
    b.effect({ service: 'bank-connector', metric: 'bank_error_rate', label: bank, from: onset, rampMin: 4, op: 'set', value: A ? 31 : 44, noise: 0.1 });
    if (A) {
      b.effect({ service: 'bank-connector', metric: 'bank_latency_p95_ms', label: bank, from: onset, rampMin: 4, op: 'set', value: 8000, noise: 0.01 });
      b.effect({ service: 'bank-connector', metric: 'timeout_count', label: bank, from: onset, rampMin: 4, op: 'set', value: 14, noise: 0.25 });
    }
    b.logStream({
      service: 'mandate-service',
      from: onset,
      to: b.window.to,
      perMin: A ? 3 : 4,
      sev: 'ERROR',
      msg: (r) =>
        A
          ? `mandate MD-${r.int(1000000, 9999999)} failed: bank-connector returned BANK_TIMEOUT`
          : `mandate MD-${r.int(1000000, 9999999)} failed: bank declined (U16 risk threshold exceeded)`,
      fields: (r) => ({ trace_id: r.hex(16), bank, error_code: A ? 'BANK_TIMEOUT' : 'U16' }),
    });
    b.logStream({
      service: 'bank-connector',
      from: onset,
      to: b.window.to,
      perMin: A ? 3 : 4,
      sev: 'ERROR',
      msg: () => (A ? 'POST /mandates -> 504 Gateway Timeout after 8000ms' : 'POST /mandates -> 422 {"code":"U16","message":"risk threshold exceeded"}'),
      fields: (r) => ({ trace_id: r.hex(16), bank, provider: 'bank-apis', status: A ? 504 : 422 }),
    });

    if (A) {
      b.change({ at: ist(day, '09:52'), service: 'mandate-service', type: 'deploy', versionTo: '2.4.0', summary: 'release: new mandate status polling', author: 'deploy-bot' });
    } else {
      b.change({ at: ist(day, '13:30'), service: 'mandate-service', type: 'config', summary: 'npci client timeout 8000ms -> 10000ms', author: 'v.rao', details: { key: 'npci.timeout_ms', from: 8000, to: 10000 } });
      b.logStream({
        service: 'mandate-service',
        from: ist(day, '13:20'),
        to: ist(day, '14:30'),
        perMin: 0.5,
        sev: 'WARN',
        msg: (r) => `npci response slow: ${r.int(2500, 4200)}ms`,
        fields: (r) => ({ trace_id: r.hex(16), provider: 'npci' }),
      });
    }
    b.addHistory({
      openedAt: ist('2026-09-03', A ? '11:00' : '10:00').toISOString(),
      resolvedAt: ist('2026-09-03', A ? '11:25' : '10:25').toISOString(),
      title: 'Autopay mandate setup failing for users',
      severity: 'SEV1',
      services: ['mandate-service', 'npci'],
      symptoms: 'Mandate registrations failing; success rate fell sharply.',
      rootCause: 'NPCI e-mandate gateway degradation.',
      resolution: 'Waited for NPCI; retried queued mandates.',
      tags: ['mandate', 'autopay', 'npci', 'external'],
    });
    b.setIncident({
      title: 'Autopay setup failing for some users',
      reportedAt: ist(day, A ? '11:15' : '14:45').toISOString(),
      reportedBy: 'Payments product manager',
      severity: 'SEV2',
      summary: A
        ? 'Some users cannot set up UPI autopay for SIPs since around 10:00 IST. Mandate success on the dashboard is ~94%, a bit below normal, so it is not a full outage. We released mandate-service at 09:52 IST.'
        : 'Autopay setup is failing for a subset of users since early afternoon. Overall mandate success is around 90%. Could NPCI be slow again?',
      symptoms: ['autopay mandate setup fails for some users', 'overall success only slightly lower'],
      userImpact: 'Affected users cannot start SIPs on autopay.',
      affectedSurface: 'SIP autopay setup',
      suspectedServices: A ? ['mandate-service'] : ['mandate-service', 'npci'],
      approxStart: onset.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['bank-apis', 'bank-connector'],
            causeTypes: ['upstream_dependency_degradation'],
            mechanism: A
              ? "Bank sahyadri's mandate API started timing out (504 after 8 s) at 10:10 IST; only its users fail, which overall success (~94%) hides."
              : "Bank gomti started declining mandates with U16 'risk threshold exceeded' at 13:40 IST; only its users fail.",
          },
        ],
        scoring: 'top1_any',
        partialCredit: [],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'mandate success split by bank', match: { tool: 'query_metrics', service: 'mandate-service', metric: 'mandate_success_rate' } },
          { description: 'bank-specific errors', match: { tool: 'query_logs', service: 'bank-connector', contains: 'mandates' } },
        ],
        keyCounterevidence: [
          `Only bank ${bank} fails; the other banks' success is unchanged after the ${A ? 'deploy' : 'config change'}.`,
          'NPCI-wide problems hit every bank; this hits one.',
        ],
        redHerrings: A ? ['mandate-service deploy 2.4.0 at 09:52 IST', 'past NPCI incident'] : ['npci client timeout change at 13:30 IST', 'npci slow warnings', 'past NPCI incident'],
        scriptedFaults: [],
        notes: 'Requires grouping mandate_success_rate (or errors) by bank.',
      },
    };
  },
};
