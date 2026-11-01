import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s14 — KYC stuck at "pending". Expected: INCONCLUSIVE.
 * Two causes fit: the KYC agency is slow to decide, or our side fails to take in its status
 * updates (A: webhook endpoint 500s; B: the kyc_webhooks queue consumer is stuck). The evidence
 * that would separate them (webhook receipt counts, the webhook queue) keeps failing to load.
 * Picking one is the failure.
 */
export const s14: ScenarioDef = {
  id: 's14',
  slug: 'kyc-conflicting-evidence',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-22' : '2026-09-10';
    const onset = A ? ist(day, '10:30') : ist(day, '15:10');
    const b = world('s14', variant, {
      window: A ? { from: ist(day, '10:00'), to: ist(day, '13:30') } : { from: ist(day, '14:30'), to: ist(day, '18:00') },
    });
    b.protect(['kyc-service', 'message-queue'], addMin(onset, -24 * 60), b.window.to);

    // Pending KYC piles up.
    b.effect({ service: 'kyc-service', metric: 'kyc_pending_count', from: onset, op: 'fn', fn: (v, t) => v + ((t.getTime() - onset.getTime()) / 60000) * (A ? 9.5 : 8) });
    // Hypothesis 1 support: the agency is slower.
    b.effect({ service: 'kyc-service', metric: 'agency_latency_p95_ms', from: addMin(onset, -10), rampMin: 15, op: 'mul', value: A ? 3.2 : 2.6 });
    b.logStream({
      service: 'kyc-service',
      from: addMin(onset, -10),
      to: b.window.to,
      perMin: 0.8,
      sev: 'WARN',
      msg: (r) => `kyc-agency submit slow (${r.int(4200, 7800)}ms)`,
      fields: (r) => ({ trace_id: r.hex(16), provider: 'kyc-agency' }),
    });
    // Fewer status updates arrive (consistent with both hypotheses).
    b.effect({ service: 'kyc-service', metric: 'webhook_received_per_min', from: onset, rampMin: 10, op: 'mul', value: A ? 0.25 : 0.35 });

    if (A) {
      // Hypothesis 2 support: some webhook deliveries fail on our side.
      b.effect({ service: 'kyc-service', metric: 'webhook_errors', from: onset, rampMin: 5, op: 'set', value: 3, noise: 0.3 });
      b.logStream({
        service: 'kyc-service',
        from: onset,
        to: b.window.to,
        perMin: 1,
        sev: 'ERROR',
        msg: () => 'POST /hooks/kyc -> 500: signature verification failed',
        fields: (r) => ({ trace_id: r.hex(16), route: '/hooks/kyc', status: 500, provider: 'kyc-agency' }),
      });
      // The discriminating evidence keeps failing to load.
      b.faultRule({ id: 'webhook-metrics', tool: 'query_metrics', match: { servicesAny: ['kyc-service'], metricsAny: ['webhook_received_per_min', 'webhook_errors'] }, attempts: 'all', effect: { kind: 'timeout' } });
      b.faultRule({ id: 'webhook-logs', tool: 'query_logs', match: { servicesAny: ['kyc-service'], textAny: ['hook', 'webhook', 'signature', 'status'] }, attempts: 'all', effect: { kind: 'timeout' } });
      b.faultRule({ id: 'webhook-queue', tool: 'query_metrics', match: { servicesAny: ['message-queue'] }, attempts: 'all', effect: { kind: 'error', code: 'unavailable' } });
    } else {
      // Hypothesis 2 support: the webhook queue consumer may be stuck.
      b.effect({ service: 'message-queue', metric: 'queue_depth', label: 'kyc_webhooks', from: onset, op: 'fn', fn: (v, t) => v + ((t.getTime() - onset.getTime()) / 60000) * 4 });
      b.log({ at: addMin(onset, -2), service: 'message-queue', sev: 'WARN', msg: 'consumer group kyc-hooks rebalanced; 1 of 3 consumers left the group' });
      b.faultRule({ id: 'queue-metrics', tool: 'query_metrics', match: { servicesAny: ['message-queue'] }, attempts: 'all', effect: { kind: 'timeout' } });
      b.faultRule({ id: 'webhook-metrics', tool: 'query_metrics', match: { servicesAny: ['kyc-service'], metricsAny: ['webhook_received_per_min', 'webhook_errors'] }, attempts: 'all', effect: { kind: 'error', code: 'unavailable' } });
      b.faultRule({ id: 'kyc-logs', tool: 'query_logs', match: { servicesAny: ['kyc-service', 'message-queue'] }, attempts: 'all', effect: { kind: 'partial', dropFraction: 0.85 } });
    }
    b.addHistory({
      openedAt: ist('2026-09-14', '11:00').toISOString(),
      resolvedAt: ist('2026-09-14', '16:00').toISOString(),
      title: 'KYC stuck pending: agency decisions delayed',
      severity: 'SEV3',
      services: ['kyc-service', 'kyc-agency'],
      symptoms: 'Pending KYC count rose by ~1,500 over the day.',
      rootCause: 'KYC agency processing backlog.',
      resolution: 'Agency cleared backlog by evening.',
      tags: ['kyc', 'pending', 'agency', 'external'],
    });
    b.addHistory({
      openedAt: ist('2026-08-21', '10:30').toISOString(),
      resolvedAt: ist('2026-08-21', '12:00').toISOString(),
      title: 'KYC status updates not applied',
      severity: 'SEV2',
      services: ['kyc-service', 'message-queue'],
      symptoms: 'Agency approved KYCs but users stayed pending.',
      rootCause: A ? 'Webhook signing key rotated on our side before the agency switched; webhooks rejected.' : 'kyc_webhooks consumer stuck after a rebalance.',
      resolution: A ? 'Accepted both keys during rotation.' : 'Restarted consumers.',
      tags: ['kyc', 'webhook', 'pending'],
    });
    b.setIncident({
      title: 'KYC applications stuck at pending',
      reportedAt: addMin(onset, A ? 100 : 90).toISOString(),
      reportedBy: 'Onboarding operations',
      severity: 'SEV2',
      summary: A
        ? 'KYC applications are stuck at "pending" since about 10:30 IST; the pending count has gone from ~350 to over 1,200. New users cannot invest.'
        : 'Since mid-afternoon (~15:10 IST) new KYC applications are not moving out of "pending". Pending count is climbing.',
      symptoms: ['KYC stays pending', 'pending count rising'],
      userImpact: 'New users cannot complete onboarding and invest.',
      affectedSurface: 'KYC onboarding',
      suspectedServices: ['kyc-service', 'kyc-agency'],
      approxStart: onset.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'inconclusive',
        acceptableCauses: [],
        scoring: 'top1_any',
        partialCredit: [],
        candidateCauses: [
          'The KYC agency is slow to decide (agency latency is up)',
          A ? 'Our webhook endpoint fails to accept status updates (500s on /hooks/kyc)' : 'Our kyc_webhooks queue consumer is stuck (a consumer left the group)',
        ],
        requiredEvidence: [
          { description: 'pending count rising', match: { tool: 'query_metrics', service: 'kyc-service', metric: 'kyc_pending_count' } },
          { description: 'agency latency up', match: { tool: 'query_metrics', service: 'kyc-service', metric: 'agency_latency_p95_ms' } },
        ],
        keyCounterevidence: ['Neither hypothesis explains the drop in received webhooks on its own, and the series that would separate them fail to load.'],
        redHerrings: [],
        scriptedFaults: A
          ? ['webhook metrics time out', 'kyc-service log searches mentioning hooks/webhooks/signature/status time out', 'message-queue metrics unavailable']
          : ['message-queue metrics time out', 'webhook metrics unavailable', 'kyc-service and message-queue logs heavily partial'],
        notes: 'Picking one cause definitively is the failure; the report should list both and the missing evidence.',
      },
    };
  },
};
