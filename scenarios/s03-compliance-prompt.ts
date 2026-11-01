import { world, type ScenarioDef } from './_lib/scenario.js';
import { addMin, ist } from './_lib/time.js';

/**
 * s03 — Assistant started giving direct "buy this fund" advice.
 * Real cause: a change to the compliance filter's advice detection (A: prompt rewrite,
 * B: threshold raise) made it stop blocking direct advice. Trap (A): the LLM provider moved
 * the model alias to a new version the same morning. Trap (B): an assistant prompt deploy
 * 25 minutes earlier.
 */
export const s03: ScenarioDef = {
  id: 's03',
  slug: 'compliance-prompt',
  dev: false,
  build(variant) {
    const A = variant === 'A';
    const day = A ? '2026-10-08' : '2026-09-24';
    const changeAt = A ? ist(day, '13:52') : ist(day, '11:40');
    const b = world('s03', variant, {
      window: A ? { from: ist(day, '12:30'), to: ist(day, '16:00') } : { from: ist(day, '10:30'), to: ist(day, '14:00') },
    });
    b.protect(['compliance-filter', 'assistant-orchestrator'], addMin(changeAt, -300), b.window.to);

    b.change(
      A
        ? {
            at: changeAt,
            service: 'compliance-filter',
            type: 'config',
            summary: 'advice-detection prompt rules-v32: shortened instructions, merged examples (cut classifier latency)',
            author: 'n.shah',
            details: { key: 'advice_detector.prompt', from: 'rules-v31', to: 'rules-v32' },
          }
        : {
            at: changeAt,
            service: 'compliance-filter',
            type: 'config',
            summary: 'advice_score_threshold 0.55 -> 0.85 (reduce false positives on educational answers)',
            author: 'n.shah',
            details: { key: 'advice_detector.threshold', from: 0.55, to: 0.85 },
          },
    );
    // The filter stops blocking advice.
    b.effect({ service: 'compliance-filter', metric: 'block_rate', from: changeAt, rampMin: 3, op: 'set', value: A ? 0.15 : 0.3, noise: 0.3 });
    if (A) b.effect({ service: 'compliance-filter', metric: 'latency_p50_ms', from: changeAt, rampMin: 3, op: 'mul', value: 0.7 });
    b.suppressLogs({ service: 'compliance-filter', from: changeAt, to: b.window.to, contains: 'answer blocked' });
    b.log({
      at: addMin(changeAt, 0.5),
      service: 'compliance-filter',
      sev: 'INFO',
      msg: A ? 'loaded advice-detection prompt rules-v32 (1120 tokens, previously 2840)' : 'config reloaded: advice_score_threshold=0.85',
    });
    b.logStream({
      service: 'compliance-filter',
      from: addMin(changeAt, 1),
      to: b.window.to,
      perMin: 0.5,
      sev: 'INFO',
      msg: (r) => `answer checked: pass (advice_score=${(A ? r.range(0.58, 0.81) : r.range(0.6, 0.84)).toFixed(2)})`,
      fields: (r) => ({ trace_id: r.hex(16) }),
    });

    if (A) {
      // Red herring: the provider moved the model alias earlier the same day.
      const modelSwitch = ist(day, '10:31');
      b.suppressLogs({ service: 'assistant-orchestrator', from: modelSwitch, to: b.window.to, contains: 'answered in' });
      b.log({
        at: modelSwitch,
        service: 'assistant-orchestrator',
        sev: 'WARN',
        msg: "llm-provider: model alias lumen-large now resolves to lumen-large-2026-10 (provider notes: 'more helpful, more direct answers')",
        fields: { provider: 'llm-provider', model: 'lumen-large-2026-10' },
      });
      b.logStream({
        service: 'assistant-orchestrator',
        from: modelSwitch,
        to: b.window.to,
        perMin: (t) => 0.75 * b.factor('assistant', t),
        sev: 'INFO',
        msg: (r) => `conversation c_${r.hex(8)} turn ${r.int(1, 6)} answered in ${r.int(1200, 6000)}ms (tokens in=${r.int(1500, 6000)} out=${r.int(80, 600)})`,
        fields: (r) => ({ trace_id: r.hex(16), provider: 'llm-provider', model: 'lumen-large-2026-10' }),
      });
      b.addHistory({
        openedAt: ist('2026-08-12', '12:00').toISOString(),
        resolvedAt: ist('2026-08-12', '17:30').toISOString(),
        title: 'Assistant answers too direct after LLM model update',
        severity: 'SEV3',
        services: ['assistant-orchestrator', 'llm-provider'],
        symptoms: 'Answers phrased as strong suggestions ("you should switch") after a provider model update.',
        rootCause: 'New model version followed tone instructions less strictly.',
        resolution: 'System prompt tightened; compliance filter caught the rest.',
        tags: ['assistant', 'llm', 'model-update', 'advice'],
      });
      b.setIncident({
        title: 'Assistant giving direct buy recommendations',
        reportedAt: ist(day, '15:10').toISOString(),
        reportedBy: 'Compliance officer',
        severity: 'SEV1',
        summary:
          'Since this afternoon several users received direct "you should buy this fund" recommendations from the assistant (screenshots in the ticket, first one around 14:00 IST). We cannot give investment advice. Note: the LLM provider rolled out a new model version today.',
        symptoms: ['assistant recommends specific funds to buy', 'advice not blocked'],
        userImpact: 'Regulatory exposure: users receive investment advice we are not licensed to give.',
        affectedSurface: 'Assistant chat',
        suspectedServices: ['assistant-orchestrator', 'llm-provider'],
        approxStart: ist(day, '14:00').toISOString(),
      });
    } else {
      // Red herring: an assistant prompt deploy 25 minutes earlier.
      const deployAt = ist(day, '11:15');
      b.change({ at: deployAt, service: 'assistant-orchestrator', type: 'deploy', versionTo: '0.43.0', summary: 'release: new conversational tone prompt (warmer, more decisive phrasing)', author: 's.kulkarni', details: { pipeline: 'build-60871' } });
      b.addHistory({
        openedAt: ist('2026-07-30', '13:00').toISOString(),
        resolvedAt: ist('2026-07-30', '18:00').toISOString(),
        title: 'Assistant tone change produced advice-like phrasing',
        severity: 'SEV3',
        services: ['assistant-orchestrator'],
        symptoms: 'Users read "consider increasing your SIP" as advice.',
        rootCause: 'Prompt tone change; compliance filter allowed borderline phrasing.',
        resolution: 'Prompt wording adjusted.',
        tags: ['assistant', 'prompt', 'tone', 'advice'],
      });
      b.setIncident({
        title: 'Assistant recommending specific funds to buy',
        reportedAt: ist(day, '13:05').toISOString(),
        reportedBy: 'Compliance officer',
        severity: 'SEV1',
        summary:
          'Users are getting replies like "buy Northstar Flexi Cap now" from the assistant since late morning (around 11:45 IST). The assistant team shipped a new prompt this morning.',
        symptoms: ['assistant gives direct buy recommendations'],
        userImpact: 'Regulatory exposure from unlicensed investment advice.',
        affectedSurface: 'Assistant chat',
        suspectedServices: ['assistant-orchestrator'],
        approxStart: ist(day, '11:45').toISOString(),
      });
    }

    return {
      builder: b,
      label: {
        expectedOutcome: 'conclusive',
        acceptableCauses: [
          {
            id: 'c1',
            components: ['compliance-filter'],
            causeTypes: ['config_change', 'deployment_regression'],
            mechanism: A
              ? 'A compliance-filter config change at 13:52 IST (advice-detection prompt rules-v32) weakened advice detection; the block rate fell from ~2% to ~0.15% and direct advice passed through.'
              : 'A compliance-filter config change at 11:40 IST (advice_score_threshold 0.55 -> 0.85) stopped blocking direct advice; the block rate collapsed.',
          },
        ],
        scoring: 'top1_any',
        partialCredit: [],
        candidateCauses: [],
        requiredEvidence: [
          { description: 'compliance-filter config change', match: { tool: 'get_changes', service: 'compliance-filter' } },
          { description: 'block rate drop', match: { tool: 'query_metrics', service: 'compliance-filter', metric: 'block_rate' } },
        ],
        keyCounterevidence: A
          ? ['The model alias moved at 10:31 IST but the block rate stayed ~2% until the 13:52 IST compliance change.']
          : ['The block rate stayed ~2% for 25 minutes after the 11:15 IST prompt deploy and only collapsed at the 11:40 IST threshold change.'],
        redHerrings: A ? ['LLM model alias moved to lumen-large-2026-10 at 10:31 IST', 'past incident: answers too direct after model update'] : ['assistant-orchestrator tone-prompt deploy at 11:15 IST'],
        scriptedFaults: [],
        notes: 'The filter, not the generator, is the control that failed.',
      },
    };
  },
};
