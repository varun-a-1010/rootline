import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s07 — Assistant quotes an old expense ratio.
 * Real cause: the monthly factsheet update never reached the knowledge index.
 * A: a strict schema-validation deploy in indexing-pipeline rejects the new factsheets (hourly
 *    retries keep failing). B: a job-schedule change means factsheet-sync never ran.
 * Trap: search itself is perfectly healthy; a model temperature change (A) / knowledge-index
 * deploy (B) invite blaming the assistant.
 */
export const s07: ScenarioDef = {
  id: 's07',
  slug: 'stale-factsheet',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-06' : '2026-09-08';
    const b = world('s07', variant, {
      window: A ? { from: ist(day, '10:00'), to: ist(day, '13:00') } : { from: ist(day, '11:00'), to: ist(day, '14:00') },
    });
    b.protect(['indexing-pipeline', 'knowledge-index', 'job-scheduler'], ist(A ? '2026-09-26' : '2026-08-29', '00:00'), b.window.to);
    const staleAsOf = A ? '2026-09-01' : '2026-08-01';
    const fund = A ? 'Kaveri Bluechip Fund - Direct Growth' : 'Northstar Flexi Cap - Direct';

    if (A) {
      b.change({
        at: ist('2026-09-30', '17:10'),
        service: 'indexing-pipeline',
        type: 'deploy',
        versionTo: '0.20.0',
        summary: 'release: strict schema validation for factsheet documents',
        author: 'p.nair',
        details: { pipeline: 'build-58899' },
      });
      // Hourly retries of the rejected October batch keep failing.
      for (let h = 0; h <= 8; h++) {
        const at = addMin(ist(day, '06:05'), h * 60);
        b.log({
          at,
          service: 'indexing-pipeline',
          sev: 'ERROR',
          msg: `factsheet batch 2026-10: 214 documents rejected by schema validation (unknown field 'ter_direct_pct'); moved to dead-letter queue (retry ${h + 41})`,
          fields: { job: 'factsheet-sync' },
        });
        b.effect({ service: 'indexing-pipeline', metric: 'ingest_errors', from: at, to: addMin(at, 1), op: 'set', value: 214 });
      }
      b.effect({
        service: 'indexing-pipeline',
        metric: 'queue_lag_s',
        from: b.dataFrom,
        op: 'fn',
        fn: (_v, t) => Math.round((t.getTime() - ist('2026-10-01', '07:00').getTime()) / 1000),
      });
      b.effect({ service: 'message-queue', metric: 'queue_depth', label: 'indexing', from: b.dataFrom, op: 'add', value: 214 });
      // Red herring: a model temperature change during the window.
      b.change({ at: ist(day, '10:20'), service: 'assistant-orchestrator', type: 'config', summary: 'LLM temperature 0.2 -> 0.4 for more natural answers', author: 's.kulkarni', details: { key: 'llm.temperature', from: 0.2, to: 0.4 } });
    } else {
      b.change({
        at: ist('2026-08-29', '16:30'),
        service: 'job-scheduler',
        type: 'job_schedule',
        summary: "calendar migration: factsheet-sync cron '0 7 1-3 * *' -> '0 7 31 * *'",
        author: 't.das',
        details: { job: 'factsheet-sync', from: '0 7 1-3 * *', to: '0 7 31 * *' },
      });
      b.log({
        at: ist(day, '09:00'),
        service: 'indexing-pipeline',
        sev: 'WARN',
        msg: 'content freshness check: newest factsheet batch in index is 2026-08 (expected 2026-09 by 2026-09-03)',
        fields: { job: 'freshness-check' },
      });
      b.change({ at: ist(day, '11:40'), service: 'knowledge-index', type: 'deploy', versionTo: '1.9.0', summary: 'release: hybrid search ranking', author: 'deploy-bot' });
    }

    // Retrieval works fine but returns last month's factsheet.
    b.logStream({
      service: 'assistant-orchestrator',
      from: b.dataFrom,
      to: b.window.to,
      perMin: 0.35,
      sev: 'INFO',
      msg: (r) => `retrieved factsheet "${r.pick([fund, fund, 'Sahyadri Midcap Opportunities - Direct', 'Gomti Liquid Fund - Direct'])}" (as_of=${staleAsOf}) score=${r.range(0.71, 0.93).toFixed(2)}`,
      fields: (r) => ({ trace_id: r.hex(16) }),
    });

    b.setIncident({
      title: 'Assistant quoting outdated expense ratios',
      reportedAt: ist(day, A ? '11:30' : '12:40').toISOString(),
      reportedBy: 'Support team lead',
      severity: 'SEV3',
      summary: A
        ? `Several users say the assistant quotes the old expense ratio for ${fund} (it says 0.62%; this month's factsheet says 0.55%). Search in the app works fine.`
        : `The assistant still gives last month's expense ratio and AUM for ${fund}. Search results look normal and fast.`,
      symptoms: ['assistant answers with outdated fund facts', 'search appears healthy'],
      userImpact: 'Users get outdated cost information for funds.',
      affectedSurface: 'Assistant chat (fund questions)',
      suspectedServices: ['assistant-orchestrator', 'llm-provider'],
      approxStart: ist(day, A ? '10:30' : '11:30').toISOString(),
    });

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: A ? ['indexing-pipeline'] : ['job-scheduler', 'indexing-pipeline'],
            causeTypes: A ? ['data_pipeline_failure', 'deployment_regression'] : ['config_change', 'data_pipeline_failure'],
            mechanism: A
              ? "The October factsheet batch was rejected by indexing-pipeline's new strict schema validation (deploy 0.20.0, 30 Sep), so the index still serves September factsheets."
              : 'A job-schedule change (cron typo) stopped factsheet-sync from running, so the September factsheets never reached the index.',
          },
        ],
        scoring: 'top1_any',
        partialCredit: [
          { components: ['knowledge-index'], causeTypes: ['data_pipeline_failure', 'cache_or_staleness'], credit: 0.5, reason: 'Right symptom location (stale index), wrong place for the failure.' },
        ],
        candidateCauses: [],
        requiredEvidence: A
          ? [
              { description: 'rejected factsheet batch', match: { tool: 'query_logs', service: 'indexing-pipeline', contains: 'rejected' } },
              { description: 'strict validation deploy', match: { tool: 'get_changes', service: 'indexing-pipeline' } },
            ]
          : [
              { description: 'factsheet-sync schedule change', match: { tool: 'get_changes', service: 'job-scheduler' } },
              { description: 'freshness check warning', match: { tool: 'query_logs', service: 'indexing-pipeline', contains: 'freshness' } },
            ],
        keyCounterevidence: [
          'knowledge-index latency and errors are normal: search works, it is serving old content.',
          `Retrieved factsheets carry as_of=${staleAsOf}.`,
        ],
        redHerrings: A ? ['assistant LLM temperature change at 10:20 IST', 'past incident: wrong exit load from a help-article typo'] : ['knowledge-index deploy at 11:40 IST'],
        scriptedFaults: [],
        notes: 'The pipeline failure happened days earlier; in-window evidence is retries, queue lag and as_of dates.',
      },
    };
  },
};
