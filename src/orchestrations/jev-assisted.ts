import type { TaskSpec } from '../contracts/agents.js';
import type { RunContext } from '../engine/context.js';
import { latestHypotheses } from '../engine/run-state.js';
import type { JevQuestion } from '../llm/jev.js';
import type { ToolCallResult } from '../tools/runner.js';
import { runFlow } from './flow.js';
import type { Orchestration } from './registry.js';

/**
 * D. Jev-assisted: the base arm (A or B, picked on dev scenarios) with Jev making small typed
 * decisions so Flash reads less:
 *   1. screening: records in large log/change/incident results are scored for relevance to the
 *      task question; low-relevance records are collapsed into a count with their ids (they
 *      stay in the ledger and remain citable);
 *   2. an evidence-vs-hypothesis grid after each reasoning step, for the critic and the next
 *      reasoning round; evidence neutral to every hypothesis is shown to later synthesis calls
 *      as an id only;
 *   3. a citation check: cited supporting evidence that Jev does not judge supportive is flagged.
 * Flash still writes plans, hypotheses, tool queries, the critic's decision and the report.
 */
export const SCREEN_MIN_RECORDS = 8;
export const SCREEN_KEEP_THRESHOLD = 0.25;
const GRID_NEUTRAL_COLLAPSE = 0.8;

export async function screenToolResult(ctx: RunContext, task: TaskSpec, result: ToolCallResult): Promise<Record<string, unknown>> {
  const view = result.modelView;
  const records = (view.records ?? []) as Array<Record<string, unknown>>;
  const screenable = ['query_logs', 'get_changes', 'search_incidents'].includes(result.tool) && !result.canonical.count_by;
  if (!screenable || records.length < SCREEN_MIN_RECORDS || !result.evidence) return view;
  const ids = records.map((r, i) => String(r.id ?? `#${i}`));
  const questions: Record<string, JevQuestion> = {};
  ids.forEach((id, i) => {
    questions[`r${i}`] = {
      type: 'noul',
      instructions: `Could record ${id} matter for this question: "${task.question}"? It matters if it could help support or rule out a cause of the incident.`,
      criteria: { true: 'could matter for the question', false: 'routine noise unrelated to the question' },
    };
  });
  const state = {
    incident: `${ctx.incident.title}. ${ctx.incident.summary}`,
    task_question: task.question,
    records: Object.fromEntries(records.map((r, i) => [ids[i]!, r])),
  };
  let answers;
  try {
    answers = (await ctx.jevDecide(task.id, 'screen', state, questions))?.answers;
  } catch (e) {
    ctx.log.emit('jev.decision', { kind: 'screen', summary: `screening unavailable (${e instanceof Error ? e.message.slice(0, 80) : 'error'}); all ${records.length} records shown`, details: { evidenceId: result.evidence.evidenceId } }, task.id);
    return view;
  }
  if (!answers) return view;
  const scored = records.map((r, i) => ({ r, id: ids[i]!, p: answers[`r${i}`]?.type === 'noul' ? (answers[`r${i}`] as { noul: number }).noul : 1 }));
  let keep = scored.filter((x) => x.p >= SCREEN_KEEP_THRESHOLD);
  if (keep.length < 3) keep = [...scored].sort((a, b) => b.p - a.p).slice(0, Math.min(3, scored.length));
  const keptIds = new Set(keep.map((x) => x.id));
  const collapsed = scored.filter((x) => !keptIds.has(x.id)).map((x) => x.id);
  ctx.log.emit(
    'jev.decision',
    {
      kind: 'screen',
      summary: `kept ${keep.length} of ${records.length} ${result.tool === 'query_logs' ? 'log lines' : 'records'} (${result.evidence.evidenceId})`,
      details: { evidenceId: result.evidence.evidenceId, kept: [...keptIds], collapsed, threshold: SCREEN_KEEP_THRESHOLD },
    },
    task.id,
  );
  if (collapsed.length === 0) return view;
  return {
    ...view,
    records: scored.filter((x) => keptIds.has(x.id)).map((x) => x.r),
    screened: {
      collapsed_count: collapsed.length,
      collapsed_ids: collapsed,
      note: `Records judged low-relevance by the screening model were collapsed. They remain in the ledger as part of ${result.evidence.evidenceId} and can be cited.`,
    },
  };
}

interface GridResult {
  text: string;
}

export async function gradeEvidence(ctx: RunContext, task: TaskSpec, store: GridResult): Promise<void> {
  const s = ctx.state();
  const hs = latestHypotheses(s);
  const evidence = Object.values(s.evidence);
  if (hs.length === 0 || evidence.length === 0) return;
  const questions: Record<string, JevQuestion> = {};
  for (const e of evidence) {
    for (const h of hs) {
      questions[`${e.evidenceId}__${h.id}`] = {
        type: 'choice',
        instructions: `Does evidence ${e.evidenceId} support, contradict, or say nothing about hypothesis ${h.id}?`,
        criteria: { supports: 'it makes the hypothesis more likely', contradicts: 'it makes the hypothesis less likely', neutral: 'unrelated or uninformative for this hypothesis' },
      };
    }
  }
  const state = {
    incident: `${ctx.incident.title}. ${ctx.incident.summary}`,
    hypotheses: Object.fromEntries(hs.map((h) => [h.id, `${h.cause} [component ${h.component}, ${h.causeType}, onset ${h.onset ?? 'unknown'}]`])),
    evidence: Object.fromEntries(evidence.map((e) => [e.evidenceId, `${e.tool} ${JSON.stringify(e.request)} completeness=${e.completeness}: ${e.excerpt.slice(0, 700)}`])),
  };
  let answers;
  try {
    answers = (await ctx.jevDecide(task.id, 'grid', state, questions))?.answers;
  } catch (e) {
    ctx.log.emit('jev.decision', { kind: 'grid', summary: `grid unavailable (${e instanceof Error ? e.message.slice(0, 80) : 'error'})`, details: {} }, task.id);
    store.text = '';
    return;
  }
  if (!answers) return;
  const grid: Record<string, Record<string, { verdict: string; p: number }>> = {};
  const neutralEverywhere = new Map<string, boolean>();
  for (const [k, a] of Object.entries(answers)) {
    if (a.type !== 'choice') continue;
    const [ev, h] = k.split('__') as [string, string];
    (grid[h] ??= {})[ev] = { verdict: a.choice, p: a.probabilities?.[a.choice] ?? a.confidence ?? 0 };
    const neutral = a.choice === 'neutral' && (a.probabilities?.neutral ?? 0) >= GRID_NEUTRAL_COLLAPSE;
    neutralEverywhere.set(ev, (neutralEverywhere.get(ev) ?? true) && neutral);
  }
  const lines: string[] = [];
  for (const h of hs) {
    const row = grid[h.id] ?? {};
    const sup = Object.entries(row).filter(([, v]) => v.verdict === 'supports').map(([e]) => e);
    const con = Object.entries(row).filter(([, v]) => v.verdict === 'contradicts').map(([e]) => e);
    lines.push(`- ${h.id}: supports ${sup.join(', ') || 'none'}; contradicts ${con.join(', ') || 'none'}`);
  }
  ctx.log.emit(
    'jev.decision',
    { kind: 'grid', summary: `graded ${Object.keys(answers).length} evidence-hypothesis pairs: ${hs.map((h) => `${h.id} +${Object.values(grid[h.id] ?? {}).filter((v) => v.verdict === 'supports').length}/-${Object.values(grid[h.id] ?? {}).filter((v) => v.verdict === 'contradicts').length}`).join(', ')}`, details: { grid } },
    task.id,
  );
  // Citation check: cited supporting evidence that the grid does not judge supportive.
  const weak: Array<{ hypothesisId: string; evidenceId: string; verdict: string }> = [];
  let cited = 0;
  for (const h of hs) {
    for (const ev of h.supportingEvidence) {
      cited++;
      const v = grid[h.id]?.[ev];
      if (v && v.verdict !== 'supports') weak.push({ hypothesisId: h.id, evidenceId: ev, verdict: v.verdict });
    }
  }
  ctx.log.emit('jev.decision', { kind: 'citation_check', summary: `${weak.length} of ${cited} cited supports look weak`, details: { weak } }, task.id);
  // Evidence neutral to every hypothesis: later synthesis calls see only its id.
  for (const [ev, neutral] of neutralEverywhere) if (neutral) ctx.collapsedEvidence.add(ev);
  store.text = [
    'Evidence-vs-hypothesis grid from a separate decision model (a check, not a verdict):',
    ...lines,
    weak.length ? `Cited supports that look weak: ${weak.map((w) => `${w.hypothesisId}<-${w.evidenceId} (${w.verdict})`).join(', ')}` : 'No cited support looks weak.',
    ctx.collapsedEvidence.size ? `Evidence judged neutral to every hypothesis (shown as ids only in the ledger): ${[...ctx.collapsedEvidence].join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Arm D's base, picked on the dev scenarios before the prompt freeze (recorded in
 * eval/results/freeze.json). Every run that does not name a base uses it: the registered arm,
 * live runs from the server, the CLI and the evaluation runner.
 */
export const ARM_D_BASE: 'A' | 'B' = 'B';

export function jevAssisted(base: 'A' | 'B' = ARM_D_BASE): Orchestration {
  return {
    id: 'D',
    title: `Jev-assisted (${base === 'A' ? 'split by source' : 'causes first'})`,
    description: 'The base arm with Jev screening tool output, grading evidence against hypotheses and checking citations, so Flash reads less.',
    async run(ctx: RunContext) {
      const store: GridResult = { text: '' };
      ctx.toolViewHook = screenToolResult;
      await runFlow(ctx, {
        candidatesFirst: (ctx.config.armBase ?? base) === 'B',
        critic: true,
        afterReasoning: (c, t) => gradeEvidence(c, t, store),
        criticExtras: () => store.text,
        reasoningExtras: () => store.text,
      });
    },
  };
}
