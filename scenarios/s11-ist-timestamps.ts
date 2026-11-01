import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, fmtIst, ist, naiveReadAsUtc } from './_lib/time.js';

/**
 * s11 — Errors after a release, but the release seems to come after the failures.
 * Real cause: the release. Its deploy record comes from a legacy deployer that writes IST
 * wall-clock time without an offset; the change store read it as UTC, so the release appears
 * 5.5 h later than it happened. The logs' version field shows the new build running right
 * before the errors start.
 */
export const s11: ScenarioDef = {
  id: 's11',
  slug: 'ist-timestamps',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-20' : '2026-09-30';
    const svc = A ? 'mf-order-service' : 'kyc-service';
    const version = A ? '4.1.0' : '1.16.0';
    const releaseAt = A ? ist(day, '09:20') : ist(day, '11:05');
    const errorsFrom = addMin(releaseAt, 2);
    const shown = naiveReadAsUtc(releaseAt);
    const b = world('s11', variant, {
      window: A ? { from: ist(day, '08:30'), to: ist(day, '15:45') } : { from: ist(day, '10:30'), to: ist(day, '17:15') },
    });
    b.protect([svc], addMin(releaseAt, -24 * 60), b.window.to);

    b.change({
      at: releaseAt,
      service: svc,
      type: 'deploy',
      versionTo: version,
      summary: A ? 'release: nominee validation for SIP orders' : 'release: NRI/OCI residency types in KYC submission',
      author: 'deploy-bot',
      details: { deployer: 'legacy-jenkins-mum', pipeline: A ? 'build-60433' : 'build-59012' },
      naiveIst: true,
    });
    if (A) {
      b.effect({ service: svc, metric: 'error_rate', from: errorsFrom, rampMin: 3, op: 'add', value: 6 });
      b.effect({ service: svc, metric: 'order_success_rate', from: errorsFrom, rampMin: 3, op: 'set', value: 93.6, noise: 0.01 });
    } else {
      b.effect({ service: svc, metric: 'error_rate', from: errorsFrom, rampMin: 3, op: 'add', value: 9 });
      b.effect({ service: svc, metric: 'kyc_pending_count', from: errorsFrom, op: 'fn', fn: (v, t) => v + ((t.getTime() - errorsFrom.getTime()) / 60000) * 3.2 });
    }
    b.logStream({
      service: svc,
      from: errorsFrom,
      to: b.window.to,
      perMin: (t) => (A ? 3.5 : 2.5) * Math.max(0.4, b.factor('daytime', t)),
      sev: 'ERROR',
      msg: (r) =>
        A
          ? `SIP order failed: NullPointerException in FolioValidator.validateNominee (folio F-${r.int(10000000, 99999999)} has no nominee record)`
          : `KYC KY-${r.int(100000, 999999)} submit failed: serialization error: unknown enum value 'NRI_OCI' for field residency_type`,
      fields: (r) => ({ trace_id: r.hex(16), status: 500 }),
    });
    b.log({ at: addMin(releaseAt, 0.6), service: svc, sev: 'INFO', msg: `starting ${svc} ${version} (build ${A ? 'build-60433' : 'build-59012'})` });

    // Red herrings: an upstream that looks a little slow, and a reporter who ruled the release out.
    b.logStream({
      service: svc,
      from: addMin(releaseAt, -60),
      to: b.window.to,
      perMin: 0.4,
      sev: 'WARN',
      msg: (r) => (A ? `RTA acknowledgement slow (${r.int(1800, 3200)}ms)` : `kyc-agency submit slow (${r.int(2400, 3900)}ms)`),
      fields: (r) => ({ trace_id: r.hex(16), provider: A ? 'rta' : 'kyc-agency' }),
    });
    b.setIncident({
      title: A ? 'Fund order errors since morning' : 'KYC submissions failing',
      reportedAt: (A ? ist(day, '15:40') : ist(day, '17:05')).toISOString(),
      reportedBy: 'On-call SRE',
      severity: 'SEV2',
      summary: A
        ? `Fund orders (mostly SIPs) have been failing since about ${fmtIst(errorsFrom)}, roughly 6% errors. We checked the deploy log: the mf-order-service release ran at ${fmtIst(shown)}, after the errors began, so we've ruled it out. Suspect something upstream (RTA?).`
        : `KYC submissions failing for some users since about ${fmtIst(errorsFrom)}. The kyc-service release is logged at ${fmtIst(shown)}, hours after the failures started, so it's not the release. The KYC agency has been slow today.`,
      symptoms: A ? ['fund order errors ~6%', 'mostly SIP orders'] : ['KYC submissions fail for some users'],
      userImpact: A ? 'Some users cannot place fund orders.' : 'Some users cannot complete KYC.',
      affectedSurface: A ? 'Mutual fund orders' : 'KYC onboarding',
      suspectedServices: A ? ['mf-order-service', 'payment-service'] : ['kyc-service', 'kyc-agency'],
      approxStart: errorsFrom.toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: [svc],
            causeTypes: ['deployment_regression'],
            mechanism: `The ${svc} ${version} release at ${fmtIst(releaseAt)} introduced the errors that began two minutes later. Its deploy record was written in IST without an offset and indexed as UTC, so it appears at ${fmtIst(shown)}, after the errors.`,
          },
        ],
        scoring: 'top1_any',
        partialCredit: [
          { components: [svc], causeTypes: ['clock_or_timestamp_skew'], credit: 0.5, reason: 'Finds the timestamp skew but names it as the cause instead of the release.' },
        ],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'the release record (offset-less timestamp)', match: { tool: 'get_changes', service: svc } },
          { description: 'error logs carrying the new version', match: { tool: 'query_logs', service: svc, contains: A ? 'NullPointerException' : 'serialization error' } },
        ],
        keyCounterevidence: [
          `Error logs from ${fmtIst(errorsFrom)} carry version ${version}, so the new build was already running before the "${fmtIst(shown)}" deploy time.`,
          'The deploy record has no UTC offset (tz: none); read as IST it is 5.5 h earlier.',
        ],
        redHerrings: [A ? 'slow RTA acknowledgements' : 'slow KYC agency', 'reporter ruled the release out from the deploy log'],
        scriptedFaults: [],
        notes: 'The timeline itself is misleading.',
      },
    };
  },
};
