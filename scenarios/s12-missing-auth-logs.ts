import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s12 — OTP logins failing; the auth logs for the window never arrived. Expected: INCONCLUSIVE.
 * The OTP success rate drops, but there is no auth-service log evidence (A: a log-shipper
 * upgrade broke shipping; B: logs arrive heavily incomplete). "The SMS provider" sounds right,
 * but SMS sends look normal and nothing supports it. A definite diagnosis is unsupported.
 */
export const s12: ScenarioDef = {
  id: 's12',
  slug: 'missing-auth-logs',
  dev: true,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-16' : '2026-09-18';
    const onset = A ? ist(day, '10:40') : ist(day, '11:05');
    const b = world('s12', variant, {
      window: A ? { from: ist(day, '10:00'), to: ist(day, '12:30') } : { from: ist(day, '10:30'), to: ist(day, '13:00') },
    });
    b.protect(['auth-service', 'notification-service'], addMin(onset, -36 * 60), b.window.to);

    b.effect({ service: 'auth-service', metric: 'otp_success_rate', from: onset, rampMin: 5, op: 'set', value: A ? 71 : 76, noise: 0.04 });
    b.effect({ service: 'auth-service', metric: 'error_rate', from: onset, rampMin: 5, op: 'add', value: A ? 4 : 3 });
    b.effect({ service: 'auth-service', metric: 'otp_sent_per_min', from: onset, rampMin: 5, op: 'mul', value: 1.3 });
    b.effect({ service: 'auth-service', metric: 'request_rate', from: onset, rampMin: 5, op: 'mul', value: 1.15 });

    if (A) {
      const shipper = ist(day, '10:24');
      b.change({ at: shipper, service: 'auth-service', type: 'infra', summary: 'log shipper agent upgraded on auth-service node pool (v2.8 -> v3.0)', author: 't.das', details: { component: 'log-shipper', from: '2.8', to: '3.0' } });
      b.suppressLogs({ service: 'auth-service', from: addMin(shipper, 1), to: b.window.to });
      // An older, unrelated-looking OTP config change: plausible but nothing ties it to 10:40.
      b.change({ at: ist('2026-10-14', '15:00'), service: 'auth-service', type: 'config', summary: 'OTP expiry 300s -> 240s', author: 'n.shah', details: { key: 'otp.expiry_s', from: 300, to: 240 } });
    } else {
      // Logs arrive, but heavily incomplete; the tool reports partial results.
      b.suppressLogs({ service: 'auth-service', from: addMin(onset, -20), to: b.window.to, fraction: 0.9 });
      b.faultRule({ id: 'auth-logs-partial', tool: 'query_logs', match: { servicesAny: ['auth-service'] }, attempts: 'all', effect: { kind: 'partial', dropFraction: 0.6 }, note: 'auth log ingestion degraded' });
      // Red herring: a planned cache failover with a brief session blip.
      const fo = ist(day, '11:02');
      b.change({ at: fo, service: 'cache', type: 'infra', summary: 'planned cache primary failover (maintenance)', author: 'v.rao', details: {} });
      b.effect({ service: 'cache', metric: 'cache_hit_rate', label: 'sessions', from: fo, to: addMin(fo, 4), op: 'add', value: -30 });
      b.log({ at: addMin(fo, 0.5), service: 'cache', sev: 'WARN', msg: 'failover: replica promoted to primary; clients reconnecting' });
    }
    // SMS sends look normal throughout.
    b.logStream({
      service: 'notification-service',
      from: addMin(onset, -30),
      to: b.window.to,
      perMin: 2,
      sev: 'INFO',
      msg: () => 'sms accepted by sms-provider (template=otp)',
      fields: (r) => ({ trace_id: r.hex(16), provider: 'sms-provider', status: 202 }),
    });
    b.addHistory({
      openedAt: ist(A ? '2026-09-29' : '2026-08-28', '19:10').toISOString(),
      resolvedAt: ist(A ? '2026-09-29' : '2026-08-28', '20:30').toISOString(),
      title: 'OTP login failures during SMS provider outage',
      severity: 'SEV1',
      services: ['auth-service', 'notification-service', 'sms-provider'],
      symptoms: 'OTP success fell to 60%; users never received the SMS.',
      rootCause: 'SMS provider outage: sends failed at the provider (sms_send_failures spiked).',
      resolution: 'Failed over to the secondary SMS provider.',
      tags: ['otp', 'login', 'sms', 'external'],
    });
    b.setIncident({
      title: 'OTP logins failing',
      reportedAt: (A ? ist(day, '11:20') : ist(day, '11:50')).toISOString(),
      reportedBy: 'On-call SRE',
      severity: 'SEV1',
      summary: A
        ? 'Many users cannot log in with OTP since about 10:40 IST; OTP success is down to ~70%. Probably the SMS provider again?'
        : 'OTP login success dropped to the mid-70s around 11:05 IST. Users say the code "doesn\'t work". SMS provider?',
      symptoms: ['OTP login failures', 'users report codes not working'],
      userImpact: 'About a quarter of logins fail.',
      affectedSurface: 'Login (OTP)',
      suspectedServices: ['sms-provider', 'notification-service'],
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
          'A failure inside auth-service OTP verification (unknown; its logs for the window are missing)',
          'SMS delivery problem (not supported: SMS sends are accepted normally and send failures are flat)',
        ],
        requiredEvidence: [
          { description: 'auth-service logs for the window (missing/incomplete)', match: { tool: 'query_logs', service: 'auth-service' } },
          { description: 'OTP success drop', match: { tool: 'query_metrics', service: 'auth-service', metric: 'otp_success_rate' } },
        ],
        keyCounterevidence: ['notification-service accepts OTP SMS normally and sms_send_failures is flat, so the SMS provider is not supported.'],
        redHerrings: A ? ['SMS provider (reporter suspicion)', 'OTP expiry change two days earlier', 'log shipper upgrade (explains missing logs, not failures)'] : ['SMS provider', 'cache failover blip at 11:02 IST'],
        scriptedFaults: A ? [] : ['query_logs on auth-service always returns partial results'],
        notes: 'A definite diagnosis is an unsupported diagnosis. The report should state the log gap.',
      },
    };
  },
};
