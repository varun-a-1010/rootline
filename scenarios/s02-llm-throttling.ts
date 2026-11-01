import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s02 — Assistant replies take 20 s or more.
 * Real cause: the LLM provider throttles us (429 quota exceeded); retries with backoff stretch
 * every answer. Trap (A): a knowledge-index rebuild at the same time also looks slow.
 * Trap (B): an assistant-orchestrator prompt deploy minutes after the 429s begin.
 */
export const s02: ScenarioDef = {
  id: 's02',
  slug: 'llm-throttling',
  dev: true,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-07' : '2026-09-16';
    const onset = A ? ist(day, '11:20') : ist(day, '20:05');
    const b = world('s02', variant, {
      window: A ? { from: ist(day, '10:30'), to: ist(day, '13:00') } : { from: ist(day, '19:15'), to: ist(day, '21:45') },
    });
    b.protect(['assistant-orchestrator', 'knowledge-index', 'indexing-pipeline'], addMin(onset, -240), b.window.to);
    const quotaMsg = A ? 'quota exceeded: tokens per minute, limit=200000' : 'quota exceeded: requests per minute, limit=1500';
    const model = A ? 'lumen-large-2026-08' : 'lumen-large-2026-08';

    // The mechanism: 429s from the provider, retries with backoff, long answers, some failures.
    b.effect({ service: 'assistant-orchestrator', metric: 'rate_limited_count', from: onset, rampMin: 4, op: 'set', value: A ? 64 : 48, noise: 0.25 });
    b.effect({ service: 'assistant-orchestrator', metric: 'retry_count', from: onset, rampMin: 4, op: 'set', value: A ? 58 : 44, noise: 0.2 });
    b.effect({ service: 'assistant-orchestrator', metric: 'llm_latency_p95_ms', from: onset, rampMin: 6, op: 'mul', value: A ? 4.4 : 3.9 });
    b.effect({ service: 'assistant-orchestrator', metric: 'latency_p95_ms', from: onset, rampMin: 6, op: 'mul', value: A ? 3.9 : 3.5 });
    b.effect({ service: 'assistant-orchestrator', metric: 'latency_p50_ms', from: onset, rampMin: 6, op: 'mul', value: A ? 2.8 : 2.5 });
    b.effect({ service: 'assistant-orchestrator', metric: 'error_rate', from: onset, rampMin: 6, op: 'add', value: A ? 5.5 : 4 });
    b.effect({ service: 'assistant-orchestrator', metric: 'llm_tokens_per_min', from: onset, rampMin: 3, op: 'mul', value: A ? 0.78 : 0.86 });
    b.logStream({
      service: 'assistant-orchestrator',
      from: onset,
      to: b.window.to,
      perMin: A ? 9 : 7,
      sev: 'WARN',
      msg: (r) => `llm-provider returned 429 Too Many Requests (${quotaMsg}); retrying in ${r.int(2, 8)}s (attempt ${r.int(1, 2)}/3)`,
      fields: (r) => ({ trace_id: r.hex(16), provider: 'llm-provider', status: 429, model }),
    });
    b.logStream({
      service: 'assistant-orchestrator',
      from: addMin(onset, 2),
      to: b.window.to,
      perMin: A ? 1.6 : 1.2,
      sev: 'ERROR',
      msg: (r) => `conversation c_${r.hex(8)} failed: llm-provider 429 after 3 attempts; returned fallback message`,
      fields: (r) => ({ trace_id: r.hex(16), provider: 'llm-provider', status: 429, model }),
    });
    b.logStream({
      service: 'assistant-orchestrator',
      from: onset,
      to: b.window.to,
      perMin: 2.5,
      sev: 'INFO',
      msg: (r) => `conversation c_${r.hex(8)} turn ${r.int(1, 5)} answered in ${r.int(14000, 31000)}ms (tokens in=${r.int(1500, 6000)} out=${r.int(80, 600)})`,
      fields: (r) => ({ trace_id: r.hex(16), provider: 'llm-provider', model }),
    });

    if (A) {
      // Red herring: a knowledge-index rebuild that also looks slow.
      const rebuild = ist(day, '11:00');
      b.change({ at: rebuild, service: 'knowledge-index', type: 'infra', summary: 'full index rebuild started (embedding model refresh)', author: 'p.nair', details: { build: 4121 } });
      b.effect({ service: 'knowledge-index', metric: 'latency_p95_ms', from: rebuild, to: ist(day, '12:45'), rampMin: 10, rampOutMin: 10, op: 'mul', value: 4.2 });
      b.effect({ service: 'knowledge-index', metric: 'latency_p50_ms', from: rebuild, to: ist(day, '12:45'), rampMin: 10, rampOutMin: 10, op: 'mul', value: 2.6 });
      b.effect({ service: 'indexing-pipeline', metric: 'docs_ingested_per_min', from: rebuild, to: ist(day, '12:45'), op: 'set', value: 210, noise: 0.15 });
      b.logStream({
        service: 'knowledge-index',
        from: rebuild,
        to: ist(day, '12:45'),
        perMin: 0.6,
        sev: 'WARN',
        msg: (r) => `serving build 4120 while build 4121 warms; cold cache for ${r.int(20, 45)}% of queries`,
        fields: (r) => ({ trace_id: r.hex(16) }),
      });
      b.logStream({
        service: 'indexing-pipeline',
        from: rebuild,
        to: ist(day, '12:45'),
        perMin: 0.25,
        sev: 'INFO',
        msg: (r) => `index build 4121: ${r.int(5, 95)}% of documents embedded`,
      });
      b.logStream({
        service: 'assistant-orchestrator',
        from: rebuild,
        to: b.window.to,
        perMin: 1.2,
        sev: 'INFO',
        msg: (r) => `retrieved ${r.int(3, 8)} passages from knowledge-index in ${r.int(90, 420)}ms`,
        fields: (r) => ({ trace_id: r.hex(16) }),
      });
      b.addHistory({
        openedAt: ist('2026-09-02', '15:10').toISOString(),
        resolvedAt: ist('2026-09-02', '16:20').toISOString(),
        title: 'Assistant slow while knowledge index rebuilt',
        severity: 'SEV3',
        services: ['assistant-orchestrator', 'knowledge-index'],
        symptoms: 'Assistant answers took 8-10 s during an index rebuild.',
        rootCause: 'Index rebuild ran on the serving nodes; search p95 rose to 2.5 s and the assistant waited on retrieval.',
        resolution: 'Rebuilds now run on separate nodes.',
        tags: ['assistant', 'latency', 'index', 'rebuild'],
      });
      b.setIncident({
        title: 'Assistant replies taking 20+ seconds',
        reportedAt: ist(day, '11:55').toISOString(),
        reportedBy: 'Assistant team on-call',
        severity: 'SEV2',
        summary:
          "Since about 11:20 IST assistant replies take 20 seconds or more and some conversations end with 'Something went wrong'. We also kicked off a knowledge index rebuild at 11:00 IST today.",
        symptoms: ['assistant replies take 20 s or more', 'some conversations fail with a generic error'],
        userImpact: 'Users wait 20-30 s for answers; a few percent get an error.',
        affectedSurface: 'Assistant chat',
        suspectedServices: ['assistant-orchestrator', 'knowledge-index'],
        approxStart: onset.toISOString(),
      });
    } else {
      // Red herring: a prompt-template deploy a few minutes after the 429s begin.
      const deployAt = ist(day, '20:12');
      b.change({ at: deployAt, service: 'assistant-orchestrator', type: 'deploy', versionTo: '0.43.0', summary: 'release: prompt template update (richer portfolio summaries)', author: 's.kulkarni', details: { pipeline: 'build-61102' } });
      b.effect({ service: 'assistant-orchestrator', metric: 'llm_tokens_per_min', from: deployAt, rampMin: 5, op: 'mul', value: 1.12 });
      b.addHistory({
        openedAt: ist('2026-08-19', '18:40').toISOString(),
        resolvedAt: ist('2026-08-19', '19:30').toISOString(),
        title: 'Assistant latency regression after prompt template change',
        severity: 'SEV3',
        services: ['assistant-orchestrator'],
        symptoms: 'Assistant p95 latency doubled after a release.',
        rootCause: 'New prompt template tripled input tokens per turn.',
        resolution: 'Rolled back the template; trimmed context.',
        tags: ['assistant', 'latency', 'deploy', 'prompt'],
      });
      b.setIncident({
        title: 'Assistant very slow this evening',
        reportedAt: ist(day, '20:40').toISOString(),
        reportedBy: 'Support duty manager',
        severity: 'SEV2',
        summary:
          'Evening peak: users say the assistant takes 20-30 seconds to answer and sometimes gives up. Started a little after 20:00 IST. The assistant team shipped a prompt update this evening.',
        symptoms: ['assistant answers take 20-30 s', 'occasional failed answers'],
        userImpact: 'Slow or failed assistant answers during the evening peak.',
        affectedSurface: 'Assistant chat',
        suspectedServices: ['assistant-orchestrator'],
        approxStart: ist(day, '20:05').toISOString(),
      });
    }

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['llm-provider', 'assistant-orchestrator'],
            causeTypes: ['rate_limiting_or_quota'],
            mechanism: `The LLM provider started rejecting our calls with 429 (${quotaMsg}); the orchestrator retries with backoff, so answers take 20 s+ and some fail.`,
          },
        ],
        scoring: 'top1_any',
        partialCredit: [
          { components: ['llm-provider'], causeTypes: ['upstream_dependency_degradation'], credit: 0.5, reason: 'Right dependency, but misses that it is quota throttling.' },
        ],
        candidateCauses: [],
        requiredEvidence: [
          { description: '429 quota errors from the LLM provider', match: { tool: 'query_logs', service: 'assistant-orchestrator', contains: '429' } },
          { description: 'rate-limited call count', match: { tool: 'query_metrics', service: 'assistant-orchestrator', metric: 'rate_limited_count' } },
        ],
        keyCounterevidence: A
          ? ['knowledge-index p95 rose only to ~0.35 s and retrieval logs show passages returned in well under 0.5 s, which cannot explain 20 s answers.']
          : ['The 429s began at ~20:05 IST, before the 20:12 IST prompt deploy; tokens per turn rose only ~12% after it.'],
        redHerrings: A ? ['knowledge-index rebuild at 11:00 IST', 'past incident: assistant slow during index rebuild'] : ['assistant-orchestrator deploy 0.43.0 at 20:12 IST', 'past incident: prompt template latency regression'],
        scriptedFaults: [],
        notes: 'Background transient tool faults only.',
      },
    };
  },
};
