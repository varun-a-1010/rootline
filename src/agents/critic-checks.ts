import type { Hypothesis } from '../contracts/agents.js';
import type { RunState } from '../engine/run-state.js';

export interface CriticCheck {
  check: string;
  status: 'pass' | 'flag';
  detail: string;
}

const CHRONOLOGY_TOLERANCE_MS = 5 * 60_000;

/**
 * Deterministic checks run before the critic model (brief §6). Their results go to the model;
 * the model still makes the decision.
 */
export function criticChecks(s: RunState, hypotheses: Hypothesis[]): CriticCheck[] {
  const out: CriticCheck[] = [];
  const incident = s.incident!;
  const symptomStart = Date.parse(incident.approxStart);

  // 1. Citation validity (invalid ids were reported and removed by the agents).
  const invalid = s.citationInvalid.filter((c) => c.agent === 'reasoning');
  out.push({
    check: 'citation_validity',
    status: invalid.length ? 'flag' : 'pass',
    detail: invalid.length ? `${invalid.length} cited id(s) did not exist in the ledger and were removed: ${[...new Set(invalid.map((c) => c.evidenceId))].slice(0, 8).join(', ')}` : 'all cited evidence ids exist in the ledger',
  });

  // 2. Chronology: the hypothesized cause starts after the symptom.
  const late = hypotheses.filter((h) => h.onset && Date.parse(h.onset) > symptomStart + CHRONOLOGY_TOLERANCE_MS);
  out.push({
    check: 'chronology',
    status: late.length ? 'flag' : 'pass',
    detail: late.length
      ? late.map((h) => `${h.id} onset ${h.onset} is after the reported symptom start ${incident.approxStart}`).join('; ')
      : `no hypothesis onset is after the reported symptom start (${incident.approxStart}); ${hypotheses.filter((h) => !h.onset).length} hypothesis(es) have no onset`,
  });

  // 3. High confidence resting on partial evidence or on services whose tools failed.
  const failedServices = new Set<string>();
  for (const r of s.toolResults.filter((x) => x.status === 'error')) {
    const c = r.canonical;
    if (Array.isArray(c.services)) for (const x of c.services as string[]) failedServices.add(x);
    if (typeof c.service === 'string') failedServices.add(c.service);
  }
  const over = hypotheses.filter((h) => {
    if (h.confidence < 0.8) return false;
    const partial = h.supportingEvidence.some((id) => s.evidence[id]?.completeness !== 'complete');
    return partial || failedServices.has(h.component);
  });
  out.push({
    check: 'overconfidence_on_partial_or_failed',
    status: over.length ? 'flag' : 'pass',
    detail: over.length
      ? over.map((h) => `${h.id} has confidence ${h.confidence} but relies on partial evidence or on ${h.component}, for which tool calls failed`).join('; ')
      : 'no high-confidence hypothesis rests on partial evidence or failed tools',
  });

  // 4. No contradicting evidence considered while the ledger holds evidence.
  const ledgerSize = Object.keys(s.evidence).length;
  const top = hypotheses[0];
  const noCounter = top && ledgerSize > 0 && hypotheses.every((h) => h.contradictingEvidence.length === 0);
  out.push({
    check: 'counterevidence_considered',
    status: noCounter ? 'flag' : 'pass',
    detail: noCounter ? `no hypothesis lists contradicting evidence although the ledger holds ${ledgerSize} records` : 'contradicting evidence is considered',
  });

  // 5. Top-two confidence gap.
  const [a, b] = [...hypotheses].sort((x, y) => y.confidence - x.confidence);
  const gap = a && b ? a.confidence - b.confidence : null;
  out.push({
    check: 'top_two_gap',
    status: gap !== null && gap < 0.1 ? 'flag' : 'pass',
    detail: gap === null ? 'only one hypothesis' : `top-two confidence gap ${gap.toFixed(2)} (${a!.id} vs ${b!.id})`,
  });
  return out;
}
