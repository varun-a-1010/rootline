import './style.css';
import { mountFlow } from './flow';
import { esc, md } from './md';

/* Plain, no-framework UI. Everything shown comes from the API, which derives it from the run's
   event log; nothing is displayed that is not in the log. */

type Any = any;
const app = document.getElementById('app')!;
let cleanup: Array<() => void> = [];
let config: Any = null;

async function api(path: string, init?: RequestInit): Promise<Any> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  return body;
}

function h(html: string): void {
  app.innerHTML = html;
}

function badge(text: string, kind: 'ok' | 'warn' | 'bad' | '' = ''): string {
  return `<span class="badge ${kind ? `b-${kind}` : ''}">${esc(text)}</span>`;
}

function outcomeBadge(o: string | null | undefined): string {
  if (!o) return badge('running', 'warn');
  return badge(o, o === 'conclusive' ? 'ok' : o === 'inconclusive' ? 'warn' : 'bad');
}

async function route(): Promise<void> {
  for (const c of cleanup) c();
  cleanup = [];
  config ??= await api('/api/config');
  const hash = location.hash || '#/';
  const [, page, arg] = hash.match(/^#\/([^/]*)\/?(.*)$/) ?? [];
  try {
    if (!page) return await incidentsPage();
    if (page === 'run') return await runPage({ kind: 'live', id: decodeURIComponent(arg!) });
    if (page === 'eval-run') return await runPage({ kind: 'eval', id: decodeURIComponent(arg!) });
    if (page === 'eval') return await evalPage();
    if (page === 'eval-runs') return await evalRunsPage();
    if (page === 'about') return aboutPage();
    h('<p>Not found.</p>');
  } catch (e) {
    h(`<p class="err">${esc((e as Error).message)}</p>`);
  }
}

// ------------------------------------------------------------------------------ incidents

let selectedArm = 'A';
let selectedWorld: string | null = null;

async function incidentsPage(): Promise<void> {
  const [incidents, recent] = await Promise.all([api('/api/incidents'), api('/api/runs').catch(() => [])]);
  selectedWorld ??= incidents[0]?.worldId ?? null;
  const rows = incidents
    .map(
      (i: Any) =>
        `<tr class="click" data-w="${i.worldId}"><td><input type="radio" name="w" ${i.worldId === selectedWorld ? 'checked' : ''}></td><td>${esc(i.key ?? '')}</td><td>${esc(i.split ?? '')}</td><td><b>${esc(i.incident.title)}</b><div class="muted small">${esc(i.incident.summary)}</div></td><td>${esc(i.incident.severity)}</td><td class="small">${esc(i.incident.reportedBy)}</td></tr>`,
    )
    .join('');
  const arms = config.arms
    .map((a: Any) => `<div class="arm ${a.id === selectedArm ? 'sel' : ''}" data-arm="${a.id}"><b>${a.id}. ${esc(a.title)}</b><div class="muted small">${esc(a.description)}</div></div>`)
    .join('');
  const recentRows = recent
    .map((r: Any) => `<tr class="click" data-run="${r.run_id}"><td class="small">${esc(r.run_id)}</td><td>${esc(r.incident_id)}</td><td>${esc(r.arm)}</td><td>${esc(r.status)}</td><td>${outcomeBadge(r.outcome)}</td><td class="small">${esc(r.stop_reason ?? '')}</td></tr>`)
    .join('');
  h(`
    <h1>Synthetic incidents</h1>
    <p class="muted">A fictional Indian investing app with an AI assistant built in. Every service, user, bank and number is invented. Pick an incident and an orchestration, then watch the investigation. Recorded evaluation runs are under <a href="#/eval-runs">Recorded runs</a>.</p>
    <div class="panel">
      <h2 style="margin-top:0">Orchestration</h2>
      <div class="arms">${arms}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        ${config.accessCodeRequired ? '<input id="code" type="password" placeholder="Access code (live runs)" />' : ''}
        <button id="start">Start live investigation</button>
        <span id="msg" class="small muted"></span>
      </div>
    </div>
    <div class="panel"><table><thead><tr><th></th><th>Key</th><th>Split</th><th>Incident</th><th>Sev</th><th>Reported by</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${recent.length ? `<div class="panel"><h2 style="margin-top:0">Recent live runs</h2><table><thead><tr><th>Run</th><th>Incident</th><th>Arm</th><th>Status</th><th>Outcome</th><th>Stop</th></tr></thead><tbody>${recentRows}</tbody></table></div>` : ''}
  `);
  app.querySelectorAll<HTMLElement>('[data-w]').forEach((el) => (el.onclick = () => ((selectedWorld = el.dataset.w!), incidentsPage())));
  app.querySelectorAll<HTMLElement>('[data-arm]').forEach((el) => (el.onclick = () => ((selectedArm = el.dataset.arm!), incidentsPage())));
  app.querySelectorAll<HTMLElement>('[data-run]').forEach((el) => (el.onclick = () => (location.hash = `#/run/${el.dataset.run}`)));
  (document.getElementById('start') as HTMLButtonElement).onclick = async () => {
    const msg = document.getElementById('msg')!;
    try {
      msg.textContent = 'starting…';
      const code = (document.getElementById('code') as HTMLInputElement | null)?.value;
      const r = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: selectedWorld, arm: selectedArm, ...(code ? { accessCode: code } : {}) }) });
      location.hash = `#/run/${r.runId}`;
    } catch (e) {
      msg.textContent = (e as Error).message;
    }
  };
}

// ------------------------------------------------------------------------------ run view

interface Source {
  kind: 'live' | 'eval';
  id: string;
}

let tab = 'report';

async function runPage(src: Source): Promise<void> {
  const base = src.kind === 'live' ? `/api/runs/${encodeURIComponent(src.id)}` : `/api/eval/runs/${encodeURIComponent(src.id)}`;
  h(`<div id="hdr" class="panel">Loading…</div>
     <div class="grid2">
       <div><iframe id="flow" class="flow" title="Agentflow"></iframe><div id="flowNote" class="small muted"></div></div>
       <div class="panel"><div class="tabs" id="tabs"></div><div id="body"></div></div>
     </div>`);
  const flow = mountFlow(document.getElementById('flow') as HTMLIFrameElement, config.flowViewerUrl, (note) => (document.getElementById('flowNote')!.textContent = note));
  cleanup.push(flow.destroy);
  let state: Any = null;
  let live = false;
  let wasLive = false;
  const render = () => {
    if (!state) return;
    renderHeader(state, live, src);
    renderTabs(state);
  };
  const refresh = async () => {
    const r = await api(base);
    state = r.state;
    live = !!r.live;
    const f = await api(`${base}/flow`);
    const title = state.incident?.title ?? 'Investigation';
    const subtitle = `Arm ${state.config?.arm ?? '?'} · ${state.incident?.incidentId ?? ''}`;
    const terminal = state.report ? { status: (state.status === 'completed' ? 'ok' : 'failed') as 'ok' | 'failed', summary: `${state.report.outcome}: ${state.report.rootCauseStatement}` } : null;
    if (live) {
      flow.live(title, subtitle, f.nodes);
      wasLive = true;
    } else if (wasLive && terminal) flow.finish(title, subtitle, f.nodes, terminal);
    else flow.replay(title, subtitle, f.replay, terminal);
    render();
  };
  await refresh();
  if (src.kind === 'live' && live) {
    const es = new EventSource(`${base}/events?after=0`);
    let timer: number | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = window.setTimeout(refresh, 400);
    };
    es.onmessage = kick;
    for (const t of ['task.started', 'task.completed', 'task.failed', 'tool.result', 'hypotheses.updated', 'critic.decided', 'report.ready', 'run.terminated', 'jev.decision']) es.addEventListener(t, kick);
    es.addEventListener('end', () => {
      es.close();
      setTimeout(refresh, 300);
    });
    cleanup.push(() => es.close());
  }
}

function usage(state: Any) {
  const ok = state.llmCalls.filter((c: Any) => c.status === 'ok');
  const sum = (k: string) => (ok.some((c: Any) => !c.usage || c.usage[k] === null) ? 'unknown' : ok.reduce((n: number, c: Any) => n + c.usage[k], 0).toLocaleString());
  return { input: sum('input'), output: sum('output'), thinking: sum('thinking'), cached: sum('cached') };
}

function renderHeader(state: Any, live: boolean, src: Source): void {
  const u = usage(state);
  const dur = state.endedAt ? `${((state.endedAt - state.startedAt) / 1000).toFixed(1)} s` : 'running';
  const el = document.getElementById('hdr')!;
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h1 style="margin:0">${esc(state.incident?.title ?? '')}</h1>
      ${outcomeBadge(state.report?.outcome ?? (live ? null : state.outcome))}
      ${state.stopReason ? badge(`stop: ${state.stopReason}`) : ''}
      ${live ? '<button class="secondary" id="cancel">Cancel</button>' : ''}
    </div>
    <div class="meta" style="margin-top:8px">
      <span><b>Arm</b> ${esc(state.config?.arm ?? '')}${state.config?.armBase ? ` (base ${esc(state.config.armBase)})` : ''}</span>
      <span><b>${src.kind === 'live' ? 'Run' : 'Recorded run'}</b> ${esc(src.id)}</span>
      <span><b>Duration</b> ${dur}</span>
      <span><b>Tool calls</b> ${state.toolResults.length} (${state.attempts.length} attempts)</span>
      <span><b>Model calls</b> ${state.llmCalls.filter((c: Any) => c.attempt === 1).length}</span>
      <span><b>Tokens</b> in ${u.input} · out ${u.output} · thinking ${u.thinking} · cached ${u.cached}</span>
      ${state.jevCalls.length ? `<span><b>Jev calls</b> ${state.jevCalls.length}</span>` : ''}
      <span><b>Model</b> ${esc(state.config?.model ?? '')} (${esc(state.config?.thinkingLevel ?? '')})</span>
    </div>
    <details class="small" style="margin-top:8px"><summary>Incident report</summary><p>${esc(state.incident?.summary ?? '')}</p><p class="muted">Window ${esc(state.incident?.window.from ?? '')} – ${esc(state.incident?.window.to ?? '')}</p></details>`;
  const c = document.getElementById('cancel');
  if (c) c.onclick = () => fetch(`/api/runs/${encodeURIComponent(src.id)}/cancel`, { method: 'POST' });
}

function evLinks(ids: string[] | undefined): string {
  return (ids ?? []).map((id) => `<a class="ev" href="javascript:void 0" data-ev="${esc(id)}">${esc(id)}</a>`).join(' ');
}

function renderTabs(state: Any): void {
  const tabs: Array<[string, string]> = [
    ['report', 'Report'],
    ['hyp', `Hypotheses (${state.hypothesisVersions.length})`],
    ['critic', `Critic (${state.criticDecisions.length})`],
    ['evidence', `Evidence (${Object.keys(state.evidence).length})`],
    ['tasks', `Tasks (${state.taskOrder.length})`],
    ['timeline', 'Timeline'],
  ];
  document.getElementById('tabs')!.innerHTML = tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('');
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.onclick = () => ((tab = b.dataset.tab!), renderTabs(state))));
  const body = document.getElementById('body')!;
  if (tab === 'report') body.innerHTML = state.markdown ? `<div class="md">${md(state.markdown)}</div>` : '<p class="muted">No report yet.</p>';
  if (tab === 'hyp') {
    body.innerHTML =
      [...state.hypothesisVersions]
        .reverse()
        .map(
          (v: Any) =>
            `<h3>Version ${v.version} (round ${v.round})</h3>${v.hypotheses
              .map(
                (x: Any) =>
                  `<div class="hyp ${x.rank === 1 ? 'top' : ''}"><b>${esc(x.id)}</b> #${x.rank} <code>${esc(x.component)}</code> ${esc(x.causeType)} · confidence ${x.confidence}<div>${esc(x.cause)}</div><div class="small">onset ${esc(x.onset ?? 'unknown')} · supports ${evLinks(x.supportingEvidence) || '–'} · contradicts ${evLinks(x.contradictingEvidence) || '–'}</div><div class="small muted">${esc(x.confidenceRationale)}</div></div>`,
              )
              .join('')}${v.dropped.length ? `<div class="small muted">Dropped: ${v.dropped.map((d: Any) => `${esc(d.id)} (${esc(d.reason)})`).join('; ')}</div>` : ''}`,
        )
        .join('') || '<p class="muted">No hypotheses yet.</p>';
  }
  if (tab === 'critic') {
    body.innerHTML =
      state.criticDecisions
        .map((d: Any, i: number) => {
          const checks = state.criticChecks[i]?.checks ?? [];
          return `<h3>Round ${d.round + 1}: ${badge(d.decision, d.decision === 'accept' ? 'ok' : d.decision === 'investigate' ? 'warn' : 'bad')}</h3>
            <p>${esc(d.rationale)}</p>
            <div class="small">${checks.map((c: Any) => `${badge(c.check, c.status === 'pass' ? 'ok' : 'warn')} ${esc(c.detail)}`).join('<br>')}</div>
            ${d.objections.length ? `<ul>${d.objections.map((o: Any) => `<li><b>${esc(o.hypothesisId)}</b> ${esc(o.type)}: ${esc(o.detail)} ${evLinks(o.evidenceIds)}</li>`).join('')}</ul>` : ''}
            ${d.followUps.length ? `<div class="small"><b>Requested follow-ups</b><ul>${d.followUps.map((f: Any) => `<li>${esc(f.role)} · <code>${esc(f.tool)}</code> ${esc(f.purpose)}</li>`).join('')}</ul></div>` : ''}`;
        })
        .join('') +
        (state.followupsScheduled.length ? `<h3>Scheduled</h3><ul class="small">${state.followupsScheduled.map((f: Any) => `<li>${esc(f.taskId)}: ${esc(f.followUp.tool)} — ${esc(f.followUp.purpose)}</li>`).join('')}</ul>` : '') +
        (state.followupsRejected.length ? `<h3>Rejected by code</h3><ul class="small">${state.followupsRejected.map((f: Any) => `<li>${esc(f.followUp.tool)}: ${esc(f.reason)}</li>`).join('')}</ul>` : '') || '<p class="muted">No critic decisions (arm C and the baseline have no critic).</p>';
  }
  if (tab === 'evidence') {
    body.innerHTML = `<input id="evf" placeholder="Filter (tool, service, text)" style="width:100%;margin-bottom:8px" />
      <div class="small muted" style="margin-bottom:6px">Failed calls are gaps, not evidence: ${state.toolResults.filter((r: Any) => r.status === 'error').length} failed, ${state.toolResults.filter((r: Any) => r.status === 'partial').length} partial, ${state.attempts.length - state.toolResults.length} retries.</div>
      <div id="evlist"></div>`;
    const list = () => {
      const q = (document.getElementById('evf') as HTMLInputElement).value.toLowerCase();
      const cards = state.toolResults
        .filter((r: Any) => !q || JSON.stringify(r).toLowerCase().includes(q) || (r.evidenceId && JSON.stringify(state.evidence[r.evidenceId]).toLowerCase().includes(q)))
        .map((r: Any) => {
          const e = r.evidenceId ? state.evidence[r.evidenceId] : null;
          return `<div class="ev-card" id="card-${esc(r.evidenceId ?? r.callId)}"><div>${e ? `<b>${esc(e.evidenceId)}</b>` : badge('no evidence', 'bad')} <code>${esc(r.tool)}</code> ${badge(r.status, r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'warn' : 'bad')} ${r.attempts > 1 ? badge(`${r.attempts} attempts`, 'warn') : ''} <span class="small muted">task ${esc(r.taskId ?? '')}</span></div>
            <div class="small"><code>${esc(JSON.stringify(r.canonical))}</code></div>
            ${r.error ? `<div class="small err">${esc(r.error.code)}: ${esc(r.error.message)}</div>` : ''}
            ${e ? `<details><summary class="small">${e.recordCount} records${e.truncated ? ' (truncated)' : ''}${e.notes.length ? ` · ${esc(e.notes.join(' | '))}` : ''}</summary><pre>${esc(e.excerpt)}</pre></details>` : ''}</div>`;
        })
        .join('');
      document.getElementById('evlist')!.innerHTML = cards || '<p class="muted">No tool calls yet.</p>';
    };
    (document.getElementById('evf') as HTMLInputElement).oninput = list;
    list();
  }
  if (tab === 'tasks') {
    body.innerHTML = `<table><thead><tr><th>Task</th><th>Role</th><th>Round</th><th>Status</th><th>Question / summary</th></tr></thead><tbody>${state.taskOrder
      .map((id: string) => {
        const t = state.tasks[id];
        return `<tr><td>${esc(id)}</td><td>${esc(t.role)}</td><td>${t.round}</td><td>${badge(t.status, t.status === 'completed' ? (t.hadGaps ? 'warn' : 'ok') : t.status === 'failed' ? 'bad' : 'warn')}</td><td>${esc(t.question)}<div class="small muted">${esc(t.summary ?? t.error ?? '')}</div></td></tr>`;
      })
      .join('')}</tbody></table>`;
  }
  if (tab === 'timeline') {
    const t0 = state.startedAt;
    const items: Array<[number, string]> = [];
    for (const id of state.taskOrder) {
      const t = state.tasks[id];
      if (t.startedAt) items.push([t.startedAt, `${id} start ${t.role}`]);
      for (const [ts, c] of t.captions) items.push([ts, `${id}   ${c}`]);
      if (t.endedAt) items.push([t.endedAt, `${id} ${t.status} ${t.role}`]);
    }
    for (const d of state.criticDecisions) items.push([d.ts, `critic: ${d.decision}`]);
    items.sort((a, b) => a[0] - b[0]);
    body.innerHTML = `<div class="timeline">${items.map(([ts, s]) => `<div>+${((ts - t0) / 1000).toFixed(1)}s ${esc(s)}</div>`).join('')}</div>`;
  }
  body.querySelectorAll<HTMLElement>('[data-ev]').forEach(
    (a) =>
      (a.onclick = () => {
        tab = 'evidence';
        renderTabs(state);
        const card = document.getElementById(`card-${a.dataset.ev}`);
        card?.classList.add('hl');
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card?.querySelector('details')?.setAttribute('open', '');
      }),
  );
}

// ------------------------------------------------------------------------------ evaluation

async function evalPage(): Promise<void> {
  let s: Any;
  try {
    s = await api('/api/eval/summary');
  } catch {
    h('<h1>Evaluation</h1><p class="muted">No evaluation results have been recorded yet.</p>');
    return;
  }
  const arms = Object.keys(s.byArm);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const row = (name: string, f: (a: Any) => string) => `<tr><td>${name}</td>${arms.map((a) => `<td>${f(s.byArm[a])}</td>`).join('')}</tr>`;
  const cases = [...new Set(s.cases.map((c: Any) => c.key))] as string[];
  h(`<h1>Evaluation</h1>
    <p class="muted">Generated from <code>eval/results/summary.json</code>. Method: <a href="/docs/evaluation.md">docs/evaluation.md</a>. ${s.freeze ? `Prompt freeze ${esc(s.freeze.promptHash)}; arm D base ${esc(s.freeze.armDBase)}.` : ''} ${s.runs.included} runs included; est. spend $${s.spendUsdAllRecordedRuns}.</p>
    <div class="panel"><table><thead><tr><th>Metric</th>${arms.map((a) => `<th>Arm ${a}</th>`).join('')}</tr></thead><tbody>
      ${row('Runs', (a) => a.runs)}
      ${row('Root-cause accuracy', (a) => `${a.rootCause.credit} / ${a.rootCause.conclusiveCases} (${pct(a.rootCause.accuracy)})`)}
      ${row('Top-2 hit', (a) => `${a.rootCause.top2Hits} / ${a.rootCause.conclusiveCases}`)}
      ${row('Correct abstentions', (a) => `${a.inconclusiveHandling.correctAbstentions} / ${a.inconclusiveHandling.inconclusiveCases}`)}
      ${row('Unsupported diagnoses', (a) => a.inconclusiveHandling.unsupportedDiagnoses)}
      ${row('False abstentions', (a) => a.rootCause.falseAbstentions)}
      ${row('Fabricated-citation rate', (a) => pct(a.grounding.fabricatedCitationRate))}
      ${row('Required-evidence recall', (a) => pct(a.grounding.requiredEvidenceRecall))}
      ${row('Tool calls / run', (a) => a.toolCalls.mean)}
      ${row('Latency s (mean)', (a) => a.latencyS.mean)}
      ${row('Input tokens / run', (a) => a.tokensPerRun.input.mean ?? 'unknown')}
      ${row('Output + thinking / run', (a) => String(a.tokensPerRun.output.mean === null ? 'unknown' : Math.round(a.tokensPerRun.output.mean + a.tokensPerRun.thinking.mean)))}
      ${row('Est. cost / run', (a) => `$${a.costUsd.mean}`)}
    </tbody></table></div>
    <div class="panel"><h2 style="margin-top:0">Per case</h2><table><thead><tr><th>Case</th><th>Split</th><th>Expected</th>${arms.map((a) => `<th>Arm ${a}</th>`).join('')}</tr></thead><tbody>
      ${cases
        .sort()
        .map((k) => {
          const any = s.cases.find((c: Any) => c.key === k);
          return `<tr><td>${esc(k)}</td><td>${esc(any.split)}</td><td>${esc(any.expectedOutcome)}</td>${arms
            .map((a) => {
              const cs = s.cases.filter((c: Any) => c.key === k && c.arm === a);
              return `<td>${cs.map((c: Any) => `<a href="#/eval-run/${encodeURIComponent(c.file)}">${c.expectedOutcome === 'inconclusive' ? (c.correctAbstention ? '✓' : '✗') : c.rootCauseCredit === 1 ? '✓' : c.rootCauseCredit ? '½' : '✗'}</a>`).join(' ') || '–'}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('')}
    </tbody></table></div>`);
}

async function evalRunsPage(): Promise<void> {
  const runs = await api('/api/eval/runs');
  h(`<h1>Recorded evaluation runs</h1><p class="muted">Every evaluation run's full event log and report (<code>eval/runs/</code>). Click to replay.</p>
    <div class="panel"><table><thead><tr><th>File</th><th>Arm</th><th>Status</th><th>Outcome</th><th>Stop</th><th>Tools</th><th>Latency</th><th>Est. $</th></tr></thead><tbody>
    ${runs.map((r: Any) => `<tr class="click" data-f="${esc(r.file)}"><td>${esc(r.file)}</td><td>${esc(r.job.arm)}</td><td>${esc(r.status)}</td><td>${outcomeBadge(r.outcome)}</td><td class="small">${esc(r.stopReason ?? '')}</td><td>${r.toolCalls ?? ''}</td><td>${r.latencyMs ? `${(r.latencyMs / 1000).toFixed(0)} s` : ''}</td><td>${r.costUsd?.toFixed(3) ?? ''}</td></tr>`).join('')}
    </tbody></table></div>`);
  app.querySelectorAll<HTMLElement>('[data-f]').forEach((el) => (el.onclick = () => (location.hash = `#/eval-run/${encodeURIComponent(el.dataset.f!)}`)));
}

function aboutPage(): void {
  h(`<h1>About Rootline</h1>
    <div class="panel md">
      <p>Rootline is a multi-agent incident investigator: an orchestrator plans, observability and dependency specialists query tools in parallel, a reasoning agent ranks competing hypotheses, a critic challenges them and requests follow-up checks, and a reporting agent writes an evidence-cited report that can be inconclusive. It is compared with a single-agent baseline using the same tools.</p>
      <ul>
        <li><a href="/docs/architecture.md">Architecture</a> · <a href="/docs/evaluation.md">Evaluation</a> · <a href="/docs/scenarios.md">Scenarios</a> · <a href="/docs/technical-note.md">Technical note</a> · <a href="/docs/limitations.md">Limitations</a></li>
        <li><a href="/downloads/fixtures-v1.zip">Download the synthetic corpus</a> (labels included, marked evaluator-only)</li>
        <li>The graph panel is the separately hosted Agentflow viewer; it only displays what the run's events say.</li>
      </ul>
    </div>`);
}

window.addEventListener('hashchange', route);
route();
