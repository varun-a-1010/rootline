import { describe, expect, it } from 'vitest';
import type { Label } from '../eval/label-schema.js';
import { requiredEvidenceFound, rootCauseCredit } from '../eval/score.js';
import type { EvidenceRecord } from '../src/contracts/evidence.js';

const base: Omit<Label, 'acceptableCauses' | 'scoring' | 'partialCredit'> = {
  scenario: 'sX', variant: 'A', key: 'sX-A', worldId: 'w_00000000', split: 'heldout', title: 't', expectedOutcome: 'conclusive',
  candidateCauses: [], requiredEvidence: [], keyCounterevidence: [], redHerrings: [], scriptedFaults: [], notes: '',
};

describe('deterministic scoring is stable', () => {
  const single: Label = {
    ...base,
    acceptableCauses: [{ id: 'c1', components: ['a', 'b'], causeTypes: ['config_change'], mechanism: 'm' }],
    scoring: 'top1_any',
    partialCredit: [{ components: ['a'], causeTypes: ['capacity_saturation'], credit: 0.5, reason: 'r' }],
  };
  it('top1_any: full, partial and no credit; top-2 hit', () => {
    expect(rootCauseCredit(single, [{ component: 'b', causeType: 'config_change' }])).toEqual({ credit: 1, topMatches: true, top2Hit: true });
    expect(rootCauseCredit(single, [{ component: 'a', causeType: 'capacity_saturation' }]).credit).toBe(0.5);
    expect(rootCauseCredit(single, [{ component: 'z', causeType: 'config_change' }, { component: 'a', causeType: 'config_change' }])).toEqual({ credit: 0, topMatches: false, top2Hit: true });
    expect(rootCauseCredit(single, []).credit).toBe(0);
  });

  const two: Label = {
    ...base,
    acceptableCauses: [
      { id: 'c1', components: ['u'], causeTypes: ['capacity_saturation'], mechanism: 'm1' },
      { id: 'c2', components: ['u', 'cache'], causeTypes: ['cache_or_staleness'], mechanism: 'm2' },
    ],
    scoring: 'top2_all',
    partialCredit: [],
  };
  it('top2_all: both causes in the top two -> 1; one at the top -> 0.5; the same hypothesis cannot cover both', () => {
    expect(rootCauseCredit(two, [{ component: 'u', causeType: 'capacity_saturation' }, { component: 'cache', causeType: 'cache_or_staleness' }]).credit).toBe(1);
    expect(rootCauseCredit(two, [{ component: 'cache', causeType: 'cache_or_staleness' }, { component: 'x', causeType: 'unknown' }]).credit).toBe(0.5);
    expect(rootCauseCredit(two, [{ component: 'x', causeType: 'unknown' }, { component: 'u', causeType: 'capacity_saturation' }]).credit).toBe(0);
  });

  it('required evidence matches tool, service, metric and content, and ignores empty results', () => {
    const label: Label = { ...single, requiredEvidence: [
      { description: 'logs', match: { tool: 'query_logs', service: 'svc', contains: 'lock' } },
      { description: 'metric', match: { tool: 'query_metrics', service: 'svc', metric: 'm' } },
    ] };
    const ev = (o: Partial<EvidenceRecord>): EvidenceRecord => ({ evidenceId: 'ev_1', tool: 'query_logs', callId: 'c', request: {}, services: ['svc'], window: null, retrievedAt: 0, completeness: 'complete', recordCount: 3, truncated: false, sourceRefs: [], excerpt: '', notes: [], taskId: null, agent: null, ...o });
    expect(requiredEvidenceFound(label, [ev({ excerpt: 'waiting for LOCK' }), ev({ tool: 'query_metrics', request: { metric: 'm' } })]).found).toBe(2);
    expect(requiredEvidenceFound(label, [ev({ excerpt: 'waiting for lock', recordCount: 0 })]).missing).toEqual(['logs', 'metric']);
  });
});
