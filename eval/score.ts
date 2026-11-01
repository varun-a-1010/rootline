import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '../src/contracts/agents.js';
import type { EvidenceRecord } from '../src/contracts/evidence.js';
import type { RunEvent } from '../src/contracts/events.js';
import { fold } from '../src/engine/run-state.js';
import { projectRoot } from '../src/util/paths.js';
import { Label } from './label-schema.js';
import type { RunFile } from './runner.js';

/**
 * Deterministic scoring (eval/rubric.md). Everything here is computed from the run's event log,
 * its report and the label; no model is involved.
 */
export interface CaseScore {
  file: string;
  key: string;
  scenario: string;
  variant: 'A' | 'B';
  arm: string;
  rep: number;
  split: 'dev' | 'heldout';
  expectedOutcome: 'conclusive' | 'inconclusive';
  status: string;
  outcome: string | null;
  stopReason: string | null;
  top: { component: string; causeType: string; confidence: number } | null;
  /** Conclusive labels: credit 0..1 (only when the report commits to conclusive). null for inconclusive labels. */
  rootCauseCredit: number | null;
  /** Conclusive labels: does the top hypothesis match, whatever the reported outcome? */
  topMatches: boolean | null;
  top2Hit: boolean | null;
  correctAbstention: boolean | null;
  unsupportedDiagnosis: boolean | null;
  falseAbstention: boolean | null;
  citations: { valid: number; invalid: number; factsWithoutEvidence: number; fabricatedRate: number | null };
  requiredEvidence: { total: number; found: number; recall: number | null; missing: string[] };
}

export function loadLabel(key: string): Label {
  return Label.parse(JSON.parse(readFileSync(join(projectRoot(), 'eval', 'labels', `${key}.json`), 'utf8')));
}

function matches(h: { component: string; causeType: string }, c: { components: readonly string[]; causeTypes: readonly string[] }): boolean {
  return c.components.includes(h.component) && c.causeTypes.includes(h.causeType);
}

/** Root-cause credit for a ranked hypothesis list against a conclusive label. */
export function rootCauseCredit(label: Label, ranked: Array<{ component: string; causeType: string }>): { credit: number; topMatches: boolean; top2Hit: boolean } {
  const [h1, h2] = ranked;
  const top2 = ranked.slice(0, 2);
  const top2Hit = top2.some((h) => label.acceptableCauses.some((c) => matches(h, c)));
  if (!h1) return { credit: 0, topMatches: false, top2Hit: false };
  const topMatches = label.acceptableCauses.some((c) => matches(h1, c));
  let credit = 0;
  if (label.scoring === 'top2_all') {
    const covered = label.acceptableCauses.filter((c) => top2.some((h) => matches(h, c)));
    if (covered.length === label.acceptableCauses.length && h2) {
      // Both causes must be covered by distinct hypotheses.
      const a = label.acceptableCauses.map((c) => top2.map((h, i) => (matches(h, c) ? i : -1)).filter((i) => i >= 0));
      const distinct = a.length === 2 ? a[0]!.some((i) => a[1]!.some((j) => j !== i)) : true;
      credit = distinct ? 1 : topMatches ? 0.5 : 0;
    } else credit = topMatches ? 0.5 : 0;
  } else {
    credit = topMatches ? 1 : 0;
  }
  if (credit === 0) {
    for (const p of label.partialCredit) if (matches(h1, p)) credit = Math.max(credit, p.credit);
  }
  return { credit, topMatches, top2Hit };
}

const CITE_FIELDS = new Set(['evidenceIds', 'supportingEvidence', 'contradictingEvidence']);
function countValidCitations(v: unknown): number {
  let n = 0;
  const walk = (x: unknown, key: string | null) => {
    if (Array.isArray(x)) {
      if (key && CITE_FIELDS.has(key)) n += x.filter((s) => typeof s === 'string' && /^ev_\d+$/.test(s)).length;
      else for (const y of x) walk(y, null);
    } else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk(v, null);
  return n;
}

export function requiredEvidenceFound(label: Label, evidence: EvidenceRecord[]): { found: number; missing: string[] } {
  const missing: string[] = [];
  let found = 0;
  for (const req of label.requiredEvidence) {
    const m = req.match;
    const ok = evidence.some(
      (e) =>
        e.tool === m.tool &&
        (!m.service || e.services.includes(m.service)) &&
        (!m.metric || e.request.metric === m.metric) &&
        (!m.contains || e.excerpt.toLowerCase().includes(m.contains.toLowerCase()) || JSON.stringify(e.request).toLowerCase().includes(m.contains.toLowerCase())) &&
        e.recordCount > 0,
    );
    if (ok) found++;
    else missing.push(req.description);
  }
  return { found, missing };
}

export function scoreRun(file: RunFile, fileName: string): CaseScore {
  const label = loadLabel(file.job.key);
  const events = file.events as RunEvent[];
  const s = fold(events);
  const report = file.report as Report | null;
  const outcome = report?.outcome ?? null;
  const ranked = (report?.hypotheses ?? []).filter((h) => h.status !== 'ruled_out').sort((a, b) => a.rank - b.rank);
  const top = ranked[0] ? { component: ranked[0].component, causeType: ranked[0].causeType, confidence: ranked[0].confidence } : null;
  const conclusiveLabel = label.expectedOutcome === 'conclusive';
  let rootCause: number | null = null;
  let topMatches: boolean | null = null;
  let top2Hit: boolean | null = null;
  if (conclusiveLabel) {
    const r = rootCauseCredit(label, ranked);
    rootCause = outcome === 'conclusive' ? r.credit : 0;
    topMatches = r.topMatches;
    top2Hit = r.top2Hit;
  }
  const invalid = s.citationInvalid.filter((c) => c.evidenceId !== '').length;
  const factsWithoutEvidence = s.citationInvalid.filter((c) => c.evidenceId === '').length;
  const valid = events.filter((e) => e.type === 'agent.output').reduce((n, e) => n + countValidCitations((e.payload as { output: unknown }).output), 0);
  const req = requiredEvidenceFound(label, Object.values(s.evidence));
  return {
    file: fileName,
    key: file.job.key,
    scenario: label.scenario,
    variant: label.variant,
    arm: file.job.arm,
    rep: file.job.rep,
    split: label.split,
    expectedOutcome: label.expectedOutcome,
    status: file.status,
    outcome,
    stopReason: s.stopReason,
    top,
    rootCauseCredit: rootCause,
    topMatches,
    top2Hit,
    // A code-built fallback report is not an agent's judgment, so it earns no abstention credit.
    correctAbstention: conclusiveLabel ? null : outcome === 'inconclusive' && report?.generatedBy !== 'code_fallback',
    unsupportedDiagnosis: conclusiveLabel ? null : outcome === 'conclusive',
    falseAbstention: conclusiveLabel ? outcome !== 'conclusive' : null,
    citations: { valid, invalid, factsWithoutEvidence, fabricatedRate: valid + invalid > 0 ? invalid / (valid + invalid) : null },
    requiredEvidence: { total: label.requiredEvidence.length, found: req.found, recall: label.requiredEvidence.length ? req.found / label.requiredEvidence.length : null, missing: req.missing },
  };
}
