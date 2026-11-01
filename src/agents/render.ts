import type { Findings, Hypothesis } from '../contracts/agents.js';
import type { EvidenceRecord } from '../contracts/evidence.js';
import type { DependencyEdge, IncidentReport, ServiceInfo } from '../contracts/world.js';
import type { RunContext } from '../engine/context.js';
import type { RunState } from '../engine/run-state.js';

/** Compact renderings of run state for model input. */

const IST_MS = 5.5 * 3_600_000;
export function istLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_MS);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} IST`;
}

export function renderIncident(i: IncidentReport): string {
  return [
    `Incident ${i.incidentId} (${i.severity}): ${i.title}`,
    `Reported ${istLabel(i.reportedAt)} by ${i.reportedBy}.`,
    `Report: ${i.summary}`,
    `Symptoms: ${i.symptoms.join('; ')}`,
    `User impact: ${i.userImpact}`,
    `Affected surface: ${i.affectedSurface}`,
    `Reporter suspects: ${i.suspectedServices.join(', ') || '(none)'}`,
    `Approximate start: ${i.approxStart} (${istLabel(i.approxStart)})`,
    `Investigation window: ${i.window.from} to ${i.window.to} (UTC; ${istLabel(i.window.from)} to ${istLabel(i.window.to)}). "Now" is the end of the window.`,
  ].join('\n');
}

export function renderCatalog(services: ServiceInfo[]): string {
  return services
    .map((s) => `- ${s.id} [${s.kind}, tier ${s.tier}, ${s.team}]: ${s.description}${s.metrics.length ? ` Metrics: ${s.metrics.map((m) => (m.labels.length ? `${m.name}(by ${m.labels.join('/')})` : m.name)).join(', ')}.` : ''}`)
    .join('\n');
}

export function renderDependencies(edges: DependencyEdge[]): string {
  return edges
    .map((e) => `- ${e.from} -> ${e.to} (${e.kind}${e.critical ? ', critical' : ''}${e.timeoutMs !== null ? `, timeout ${e.timeoutMs}ms` : ''}${e.retries !== null ? `, retries ${e.retries}` : ''}${e.notes ? `; ${e.notes}` : ''})`)
    .join('\n');
}

export function renderBudget(ctx: RunContext): string {
  const r = ctx.budget.remaining();
  return `Run budget remaining: ${r.toolCalls} tool calls, ${r.llmCalls} model calls, ${Math.round(r.msLeft / 1000)} s.`;
}

/** The evidence ledger: one block per record, with a bounded excerpt. */
export function renderLedger(records: EvidenceRecord[], excerptChars = 1400, collapsed: ReadonlySet<string> = new Set()): string {
  if (records.length === 0) return '(no evidence recorded yet)';
  return records
    .map((e) => {
      if (collapsed.has(e.evidenceId)) return `[${e.evidenceId}] ${e.tool} (judged neutral to every hypothesis; excerpt omitted, still citable)`;
      const req = JSON.stringify(e.request);
      const ex = e.excerpt.length > excerptChars ? e.excerpt.slice(0, excerptChars) + ' …' : e.excerpt;
      return `[${e.evidenceId}] ${e.tool} ${req}\n  completeness=${e.completeness} records=${e.recordCount}${e.truncated ? ' (truncated)' : ''}${e.notes.length ? ` notes: ${e.notes.join(' | ')}` : ''}\n  ${ex.replace(/\n/g, '\n  ')}`;
    })
    .join('\n');
}

export function renderToolFailures(s: RunState): string {
  const failed = s.toolResults.filter((r) => r.status === 'error');
  if (failed.length === 0) return '(none)';
  return failed.map((r) => `- ${r.tool} ${JSON.stringify(r.canonical)}: ${r.error?.code} after ${r.attempts} attempt(s)`).join('\n');
}

export function renderFindings(s: RunState): string {
  const out: string[] = [];
  for (const id of s.taskOrder) {
    const t = s.tasks[id]!;
    if (t.role !== 'observability' && t.role !== 'dependency') continue;
    const f: Findings | undefined = s.findings[id];
    out.push(`## ${id} (${t.role}, round ${t.round}): ${t.question}`);
    if (t.status === 'failed') {
      out.push(`  FAILED: ${t.error ?? 'unknown error'}`);
      continue;
    }
    if (!f) {
      out.push('  (no findings)');
      continue;
    }
    out.push(`  Summary: ${f.summary}`);
    for (const o of f.observations) out.push(`  - [${o.kind}] ${o.statement} ${o.evidenceIds.length ? `(${o.evidenceIds.join(', ')})` : '(no evidence)'}`);
    for (const g of f.gaps) out.push(`  - GAP (${g.cause}): ${g.description}`);
  }
  return out.join('\n') || '(no specialist findings)';
}

export function renderHypotheses(hs: Hypothesis[]): string {
  if (hs.length === 0) return '(none yet)';
  return hs
    .map(
      (h) =>
        `${h.id} (rank ${h.rank}, confidence ${h.confidence}): ${h.cause}\n  component=${h.component} causeType=${h.causeType} onset=${h.onset ?? 'unknown'}\n  supporting: ${h.supportingEvidence.join(', ') || '-'} | contradicting: ${h.contradictingEvidence.join(', ') || '-'}\n  assumptions: ${h.assumptions.join('; ') || '-'}\n  missing: ${h.missingEvidence.join('; ') || '-'}`,
    )
    .join('\n');
}
