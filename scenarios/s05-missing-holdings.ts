import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, fmtIst, ist } from './_lib/time.js';

/**
 * s05 — Assistant says "you don't hold any funds".
 * Two causes: (1) user-context-service timed out building contexts (A: worker pool saturated
 * by a push-campaign traffic surge; B: pods OOM-restarting), and (2) on timeout it cached an
 * EMPTY context with a 6 h TTL, so users keep getting "no holdings" after the timeouts stop.
 * Fixing either alone does not explain everything. Red herring: a portfolio-service deploy (A)
 * or knowledge-index deploy (B) near the onset.
 */
export const s05: ScenarioDef = {
  id: 's05',
  slug: 'missing-holdings',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-09' : '2026-09-25';
    const onset = A ? ist(day, '10:05') : ist(day, '14:20');
    const recover = A ? ist(day, '10:45') : ist(day, '14:52');
    const b = world('s05', variant, {
      window: A ? { from: ist(day, '09:30'), to: ist(day, '13:00') } : { from: ist(day, '13:45'), to: ist(day, '17:15') },
    });
    b.protect(['user-context-service', 'cache', 'assistant-orchestrator'], addMin(onset, -300), b.window.to);

    // Cause 1: context builds time out.
    b.effect({ service: 'user-context-service', metric: 'timeout_count', from: onset, to: recover, rampMin: 3, rampOutMin: 3, op: 'set', value: A ? 42 : 35, noise: 0.2 });
    b.effect({ service: 'user-context-service', metric: 'latency_p95_ms', from: onset, to: recover, rampMin: 3, rampOutMin: 3, op: 'set', value: 1200, noise: 0.02 });
    b.effect({ service: 'user-context-service', metric: 'error_rate', from: onset, to: recover, rampMin: 3, rampOutMin: 3, op: 'add', value: A ? 12 : 10 });
    // Cause 2: empty contexts cached for 6 h keep "missing context" high after recovery.
    b.effect({ service: 'user-context-service', metric: 'missing_context_rate', from: onset, to: recover, rampMin: 3, op: 'set', value: A ? 22 : 19, noise: 0.08 });
    b.effect({ service: 'user-context-service', metric: 'missing_context_rate', from: recover, op: 'set', value: A ? 9 : 8, noise: 0.1 });
    b.effect({ service: 'cache', metric: 'cache_hit_rate', label: 'user_context', from: addMin(onset, 5), rampMin: 15, op: 'add', value: 4 });

    if (A) {
      // Trigger: a push campaign doubles assistant traffic at 10:00.
      b.change({ at: ist(day, '09:58'), service: 'notification-service', type: 'config', summary: "campaign 'Ask the assistant about your SIPs' push to 2.1M users scheduled 10:00 IST", author: 'm.bose', details: { campaign: 'ask-sip-oct', audience: 2100000 } });
      b.effect({ service: 'assistant-orchestrator', metric: 'request_rate', from: ist(day, '10:00'), to: ist(day, '10:55'), rampMin: 4, rampOutMin: 15, op: 'mul', value: 2.3 });
      b.effect({ service: 'user-context-service', metric: 'request_rate', from: ist(day, '10:00'), to: ist(day, '10:55'), rampMin: 4, rampOutMin: 15, op: 'mul', value: 2.2 });
    } else {
      b.logStream({
        service: 'user-context-service',
        from: onset,
        to: recover,
        perMin: 0.4,
        sev: 'ERROR',
        msg: (r) => `pod user-context-${r.hex(4)} restarted (OOMKilled, limit 1Gi)`,
        fields: () => ({}),
      });
    }
    b.logStream({
      service: 'user-context-service',
      from: onset,
      to: recover,
      perMin: A ? 7 : 6,
      sev: 'ERROR',
      msg: (r) =>
        A
          ? `context build timed out after 1200ms (holdings fetch pending); worker pool 64/64 busy, ${r.int(120, 380)} queued`
          : `context build timed out after 1200ms (holdings fetch pending); ${r.int(2, 4)} of 6 pods ready`,
      fields: (r) => ({ trace_id: r.hex(16) }),
    });
    b.logStream({
      service: 'user-context-service',
      from: onset,
      to: recover,
      perMin: 5,
      sev: 'WARN',
      msg: (r) => `cache SET user_ctx:u_${r.hex(8)} holdings=0 sips=0 ttl=21600s (fallback after timeout)`,
      fields: (r) => ({ trace_id: r.hex(16) }),
    });
    b.logStream({
      service: 'user-context-service',
      from: recover,
      to: b.window.to,
      perMin: 3,
      sev: 'INFO',
      msg: (r) => `context served from cache (holdings=0, sips=0, cached_at=${fmtIst(addMin(onset, r.int(1, 38)))})`,
      fields: (r) => ({ trace_id: r.hex(16) }),
    });

    // Red herring deploy near the onset.
    const rh = A
      ? { at: ist(day, '09:58'), service: 'portfolio-service', versionTo: '7.2.1', summary: 'release: holdings endpoint pagination fix' }
      : { at: ist(day, '14:15'), service: 'knowledge-index', versionTo: '1.9.0', summary: 'release: hybrid search ranking' };
    b.change({ at: rh.at, service: rh.service, type: 'deploy', versionTo: rh.versionTo, summary: rh.summary, author: 'deploy-bot' });

    b.setIncident({
      title: A ? "Assistant says users don't hold any funds" : 'Assistant cannot see user holdings',
      reportedAt: (A ? ist(day, '12:10') : ist(day, '16:30')).toISOString(),
      reportedBy: 'Support team lead',
      severity: 'SEV2',
      summary: A
        ? 'Since around 10:00 IST many users asking the assistant about their portfolio get "you don\'t hold any funds" even though the Portfolio screen shows their holdings. Still happening for a lot of users at noon.'
        : 'Since mid-afternoon (about 14:20 IST) the assistant tells some users it cannot find any holdings. The Portfolio screen is fine. Not going away.',
      symptoms: ['assistant claims user holds no funds', 'portfolio screen shows holdings correctly'],
      userImpact: 'Wrong personal answers from the assistant; users worry their investments are gone.',
      affectedSurface: 'Assistant chat (personal questions)',
      suspectedServices: A ? ['portfolio-service', 'assistant-orchestrator'] : ['assistant-orchestrator'],
      approxStart: onset.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['user-context-service'],
            causeTypes: A ? ['capacity_saturation'] : ['capacity_saturation', 'infrastructure_failure'],
            mechanism: A
              ? 'user-context-service timed out building contexts when a push campaign more than doubled assistant traffic (worker pool saturated).'
              : 'user-context-service timed out building contexts while its pods were OOM-restarting.',
          },
          {
            id: 'c2',
            components: ['user-context-service', 'cache'],
            causeTypes: ['cache_or_staleness'],
            mechanism: 'On timeout it cached an empty context (holdings=0) with a 6 h TTL, so users keep getting "no holdings" after the timeouts stopped.',
          },
        ],
        scoring: 'top2_all',
        partialCredit: [],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'context build timeouts', match: { tool: 'query_logs', service: 'user-context-service', contains: 'timed out' } },
          { description: 'empty context cached with long TTL', match: { tool: 'query_logs', service: 'user-context-service', contains: 'holdings=0' } },
          { description: 'missing-context rate stays high after timeouts stop', match: { tool: 'query_metrics', service: 'user-context-service', metric: 'missing_context_rate' } },
        ],
        keyCounterevidence: [
          `Timeouts stopped around ${fmtIst(recover)} but missing_context_rate stayed elevated: the timeout alone does not explain the ongoing failures.`,
          A ? 'portfolio-service latency and errors stayed normal after its 09:58 IST deploy.' : 'knowledge-index is not on the user-context path.',
        ],
        redHerrings: [`${rh.service} deploy ${rh.versionTo} at ${fmtIst(rh.at)}`],
        scriptedFaults: [],
        notes: 'Two-cause scenario: full credit needs both causes in the top two hypotheses; half credit if the top hypothesis is one of them.',
      },
    };
  },
};
