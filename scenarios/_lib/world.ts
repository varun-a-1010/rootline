import type { FaultProfile, FaultRule, TransientFault } from '../../src/contracts/faults.js';
import type {
  ChangeEvent,
  DependencyEdge,
  HistoricalIncident,
  IncidentReport,
  LogEvent,
  MetricSeries,
  ServiceInfo,
  WorldData,
} from '../../src/contracts/world.js';
import { sha256 } from '../../src/util/canonical.js';
import { baseDependencies, SERVICES, type MetricDef, type Profile, type ServiceDef } from './catalog.js';
import { HISTORY_POOL } from './history-pool.js';
import { Rng } from './rng.js';
import { DAY, HOUR, MIN, addMin, isoIst, istHour, istWeekday, naiveIst, naiveReadAsUtc } from './time.js';

export const GENERATOR = 'rootline-fixtures/v1';
const WORLD_ID_SALT = 'rootline-v1:opaque-world-ids';

export type LogTz = 'utc' | 'ist_offset' | 'naive_ist';
type Sev = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface MetricEffect {
  service: string;
  metric: string;
  /** Only this label value's series (labeled metrics). Omit: every series of the metric. */
  label?: string;
  from: Date;
  to?: Date;
  /** Minutes to ramp in from `from` (and out before `to`, if rampOutMin). */
  rampMin?: number;
  rampOutMin?: number;
  op: 'mul' | 'add' | 'set' | 'fn';
  value?: number;
  fn?: (v: number, t: Date, progress: number, r: Rng) => number;
  /** Relative noise added on 'set' values. */
  noise?: number;
}

export interface ScriptedLog {
  at: Date;
  service: string;
  sev: Sev;
  msg: string;
  fields?: Record<string, string | number>;
  tz?: LogTz;
}

export interface ScheduledJob {
  name: string;
  /** Service that does the work (gets the work logs). */
  service: string;
  atIst: string;
  durationMin: number;
  /** 'daily' or a weekday list (0 = Sunday). */
  days: 'daily' | number[];
  startMsg: (r: Rng) => string;
  endMsg: (r: Rng) => string;
  failMsgs?: (r: Rng) => Array<{ sev: Sev; msg: string; afterMin: number }>;
}

export interface WorldOptions {
  /** Evaluator key, e.g. "s01-A". Only used to derive seeds and the opaque id. */
  key: string;
  seed: string;
  window: { from: Date; to: Date };
  /** Hours of 5-minute rollup data before the high-resolution range (default 4). */
  preHours?: number;
  /** Restrict the catalog (small test worlds). */
  services?: string[];
  logScale?: number;
  historyCount?: number;
  routineChangesPerWeekday?: [number, number];
}

const AUTHORS = ['a.menon', 'r.iyer', 's.kulkarni', 'p.nair', 'k.reddy', 'm.bose', 'deploy-bot', 'v.rao', 'n.shah', 't.das'];

export class WorldBuilder {
  readonly rng: Rng;
  readonly worldId: string;
  readonly window: { from: Date; to: Date };
  readonly dataFrom: Date;
  readonly dataTo: Date;
  readonly highResFrom: Date;
  readonly services: ServiceDef[];
  readonly deps: DependencyEdge[];
  private readonly effects: MetricEffect[] = [];
  private readonly scripted: ScriptedLog[] = [];
  private readonly changeList: Array<ChangeEvent & { realAt: number }> = [];
  private readonly historyList: HistoricalIncident[] = [];
  private readonly faultRules: FaultRule[] = [];
  private transient: TransientFault[];
  private incident: IncidentReport | null = null;
  private readonly protectedRanges: Array<{ services: string[]; from: number; to: number }> = [];
  readonly jobs: ScheduledJob[];
  private readonly jobOutcomes = new Map<string, 'ok' | 'failed' | 'skipped'>();
  private readonly suppressions: Array<{ service: string; from: number; to: number; contains?: string; fraction: number }> = [];
  private readonly opts: Required<Pick<WorldOptions, 'preHours' | 'logScale' | 'historyCount' | 'routineChangesPerWeekday'>>;
  private changeSeq = 0;

  constructor(opts: WorldOptions) {
    this.rng = new Rng(opts.seed);
    this.worldId = `w_${sha256(`${WORLD_ID_SALT}:${opts.key}:${opts.seed}`).slice(0, 8)}`;
    this.window = opts.window;
    this.opts = {
      preHours: opts.preHours ?? 4,
      logScale: opts.logScale ?? 0.22,
      historyCount: opts.historyCount ?? 16,
      routineChangesPerWeekday: opts.routineChangesPerWeekday ?? [4, 8],
    };
    this.highResFrom = addMin(opts.window.from, -60);
    this.dataFrom = new Date(this.highResFrom.getTime() - this.opts.preHours * HOUR);
    this.dataTo = opts.window.to;
    const keep = opts.services ? new Set(opts.services) : null;
    this.services = SERVICES.filter((s) => !keep || keep.has(s.id));
    const ids = new Set(this.services.map((s) => s.id));
    this.deps = baseDependencies().filter((d) => ids.has(d.from) && ids.has(d.to));
    this.transient = [
      { p: 0.05, maxAttempt: 1, effect: { kind: 'timeout' } },
      { p: 0.04, maxAttempt: 2, effect: { kind: 'error', code: 'unavailable' } },
      { p: 0.04, tools: ['query_logs', 'query_metrics'], maxAttempt: 3, effect: { kind: 'partial', dropFraction: 0.15 } },
    ];
    this.jobs = defaultJobs();
  }

  // ------------------------------------------------------------------------- scenario API

  effect(e: MetricEffect): this {
    this.effects.push(e);
    return this;
  }

  log(l: ScriptedLog): this {
    this.scripted.push(l);
    return this;
  }

  /** A stream of similar lines: perMin may vary with time. */
  logStream(s: {
    service: string;
    from: Date;
    to: Date;
    perMin: number | ((t: Date) => number);
    sev: Sev;
    msg: (r: Rng, t: Date) => string;
    fields?: (r: Rng, t: Date) => Record<string, string | number>;
    tz?: LogTz;
  }): this {
    const r = this.rng.fork(`stream:${s.service}:${s.from.toISOString()}:${this.scripted.length}`);
    for (let t = s.from.getTime(); t < s.to.getTime(); t += MIN) {
      const at = new Date(t);
      const lambda = typeof s.perMin === 'number' ? s.perMin : s.perMin(at);
      const n = r.poisson(lambda);
      for (let i = 0; i < n; i++) {
        const when = new Date(t + Math.floor(r.next() * MIN));
        this.scripted.push({ at: when, service: s.service, sev: s.sev, msg: s.msg(r, when), fields: s.fields?.(r, when), tz: s.tz });
      }
    }
    return this;
  }

  change(c: {
    at: Date;
    service: string;
    type: ChangeEvent['type'];
    summary: string;
    author?: string;
    status?: ChangeEvent['status'];
    versionTo?: string | null;
    details?: ChangeEvent['details'];
    /** The source writes IST wall-clock without an offset; the store reads it as UTC. */
    naiveIst?: boolean;
  }): string {
    this.changeSeq += 1;
    const id = `CHG-${(48210 + this.changeSeq * 7 + this.rng.int(0, 6)).toString()}`;
    const indexed = c.naiveIst ? naiveReadAsUtc(c.at) : c.at;
    const versionFrom = c.type === 'deploy' || c.type === 'rollback' ? this.versionAt(c.service, c.at.getTime()) : null;
    this.changeList.push({
      id,
      ts: indexed.toISOString(),
      sourceTimestamp: c.naiveIst ? naiveIst(c.at) : c.at.toISOString(),
      sourceTz: c.naiveIst ? null : '+00:00',
      service: c.service,
      type: c.type,
      summary: c.summary,
      versionFrom,
      versionTo: c.versionTo ?? null,
      author: c.author ?? this.rng.pick(AUTHORS),
      status: c.status ?? 'completed',
      details: c.details ?? {},
      realAt: c.at.getTime(),
    });
    return id;
  }

  editDependency(from: string, to: string, patch: Partial<DependencyEdge>): this {
    const d = this.deps.find((x) => x.from === from && x.to === to);
    if (!d) throw new Error(`no dependency ${from} -> ${to}`);
    Object.assign(d, patch);
    return this;
  }

  addHistory(h: Omit<HistoricalIncident, 'id'> & { id?: string }): this {
    this.historyList.push({ id: h.id ?? `PIR-${2000 + this.historyList.length * 13 + this.rng.int(0, 9)}`, ...h } as HistoricalIncident);
    return this;
  }

  faultRule(rule: FaultRule): this {
    this.faultRules.push(rule);
    return this;
  }

  setTransient(t: TransientFault[]): this {
    this.transient = t;
    return this;
  }

  setIncident(i: Omit<IncidentReport, 'incidentId' | 'window'> & { window?: IncidentReport['window'] }): this {
    const n = parseInt(sha256(`incident:${this.worldId}`).slice(0, 6), 16) % 9000 + 1000;
    this.incident = {
      incidentId: `INC-${n}`,
      window: i.window ?? { from: this.window.from.toISOString(), to: this.window.to.toISOString() },
      ...i,
    };
    return this;
  }

  /** No routine (background) changes for these services in this range. */
  protect(services: string[], from: Date, to: Date): this {
    this.protectedRanges.push({ services, from: from.getTime(), to: to.getTime() });
    return this;
  }

  /** Override one run of a scheduled job (keyed by its IST start instant). */
  jobOutcome(name: string, start: Date, outcome: 'ok' | 'failed' | 'skipped'): this {
    this.jobOutcomes.set(`${name}@${start.getTime()}`, outcome);
    return this;
  }

  /**
   * Remove background (non-scripted) log lines: logs that never arrived, or chatter a scenario
   * replaces with its own lines. fraction < 1 removes that share, chosen deterministically.
   */
  suppressLogs(x: { service: string; from: Date; to: Date; contains?: string; fraction?: number }): this {
    this.suppressions.push({ service: x.service, from: x.from.getTime(), to: x.to.getTime(), contains: x.contains, fraction: x.fraction ?? 1 });
    return this;
  }

  addJob(job: ScheduledJob): this {
    this.jobs.push(job);
    return this;
  }

  /** The version a service was running at an instant (real time). */
  versionAt(service: string, at: number): string {
    const def = this.services.find((s) => s.id === service);
    let v = def?.version ?? '1.0.0';
    for (const c of [...this.changeList].sort((a, b) => a.realAt - b.realAt)) {
      if (c.service !== service || c.realAt > at) continue;
      if ((c.type === 'deploy' || c.type === 'rollback') && c.versionTo && c.status !== 'failed') v = c.versionTo;
    }
    return v;
  }

  nextVersion(service: string, at: Date, kind: 'patch' | 'minor' = 'patch'): string {
    const cur = this.versionAt(service, at.getTime());
    const [a, b, c] = cur.split('.').map((x) => parseInt(x, 10) || 0) as [number, number, number];
    return kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
  }

  // ---------------------------------------------------------------------------------- build

  build(): { world: WorldData; faults: FaultProfile } {
    if (!this.incident) throw new Error('incident report not set');
    this.routineChanges();
    const jobRuns = this.jobRuns();
    const metrics = this.buildMetrics(jobRuns);
    const logs = this.buildLogs(jobRuns);
    const history = this.buildHistory();
    const services: ServiceInfo[] = this.services.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      team: s.team,
      tier: s.tier,
      description: s.description,
      metrics: s.metrics.map((m) => ({ name: m.name, unit: m.unit, description: m.description, labels: m.labels ? [m.labels.key] : [] })),
    }));
    const changes = this.changeList
      .map(({ realAt: _r, ...c }) => c)
      .filter((c) => Date.parse(c.ts) <= this.dataTo.getTime())
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    const world: WorldData = {
      meta: {
        worldId: this.worldId,
        dataFrom: this.dataFrom.toISOString(),
        dataTo: this.dataTo.toISOString(),
        highResFrom: this.highResFrom.toISOString(),
        generator: GENERATOR,
      },
      incident: this.incident,
      services,
      dependencies: [...this.deps].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
      changes,
      history,
      logs,
      metrics,
    };
    const faults: FaultProfile = {
      seed: sha256(`faults:${this.worldId}`).slice(0, 16),
      latency: { minMs: 50, maxMs: 400 },
      transient: this.transient,
      rules: this.faultRules,
    };
    return { world, faults };
  }

  // ------------------------------------------------------------------------ traffic shape

  factor(profile: Profile, t: Date): number {
    const h = istHour(t);
    const wd = istWeekday(t);
    const weekend = wd === 0 || wd === 6;
    const daytime = (): number => {
      if (h < 6) return 0.08;
      if (h < 9) return 0.08 + ((h - 6) / 3) * 0.9;
      if (h < 11) return 1.1;
      if (h < 17) return 0.9;
      if (h < 19) return 0.8;
      if (h < 22) return 1.15;
      return 1.15 - ((h - 22) / 2) * 0.95;
    };
    const market = (): number => {
      if (weekend) return 0.03;
      if (h < 8.5) return 0.04;
      if (h < 9) return 0.1 + (h - 8.5) * 0.6;
      if (h < 9.25) return 0.55;
      if (h < 9.8) return 1.1 + 2.2 * Math.exp(-((h - 9.25) * 60) / 7);
      if (h < 12.5) return 1.0;
      if (h < 13.5) return 0.85;
      if (h < 15.0) return 1.0;
      if (h < 15.5) return 1.3;
      if (h < 16) return 0.3;
      return 0.06;
    };
    switch (profile) {
      case 'market':
        return market();
      case 'daytime':
        return daytime();
      case 'assistant':
        return daytime() * (h >= 19 && h < 23 ? 1.2 : 1);
      case 'investor':
        return Math.max(0.08, 0.65 * daytime() + 0.45 * Math.min(market(), 2.4));
      case 'flat':
        return 0.9 + 0.1 * Math.sin((h / 24) * 2 * Math.PI);
      case 'sip_batch':
        if (h >= 6 && h < 8) return 2.6;
        if (h >= 8 && h < 8.5) return 1.2;
        return h >= 9 && h < 18 ? 0.3 : 0.08;
      case 'payout_batch':
        if ((h >= 10 && h < 10.4) || (h >= 14 && h < 14.4)) return 2.5;
        return h >= 9 && h < 18 ? 0.35 : 0.1;
      case 'nightly':
        return 0.5;
    }
  }

  // -------------------------------------------------------------------------------- metrics

  /** Timestamps for metric points: 5-minute rollups before highResFrom, per-minute after. */
  private grid(): Date[] {
    const out: Date[] = [];
    for (let t = this.dataFrom.getTime(); t < this.highResFrom.getTime(); t += 5 * MIN) out.push(new Date(t));
    for (let t = this.highResFrom.getTime(); t <= this.dataTo.getTime() - MIN; t += MIN) out.push(new Date(t));
    return out;
  }

  private baseValue(def: MetricDef, profile: Profile, t: Date, r: Rng, share: number, labelMul: number, jobRuns: JobRun[]): number {
    const f = this.factor(profile, t);
    const noise = def.noise;
    switch (def.kind) {
      case 'rate':
        return Math.max(0, def.base * share * f * (1 + r.normal(0, noise ?? 0.04)));
      case 'count': {
        const lambda = def.base * share * f;
        return lambda < 40 ? r.poisson(lambda) : Math.max(0, lambda * (1 + r.normal(0, noise ?? 0.04)));
      }
      case 'pct_error':
        return Math.max(0, def.base * labelMul * (1 + 0.25 * Math.max(0, f - 1)) * (1 + r.normal(0, noise ?? 0.18)));
      case 'pct_success':
        return Math.min(100, 100 - (100 - def.base) * labelMul * (1 + r.normal(0, noise ?? 0.12)));
      case 'latency':
        return Math.max(0.1, def.base * labelMul * (1 + (def.load ?? 0.2) * (f - 1)) * (1 + r.normal(0, noise ?? 0.06)));
      case 'gauge':
        return Math.max(0, def.base * labelMul * (1 + (def.load ?? 0) * (f - 1)) * (1 + r.normal(0, noise ?? 0.03)));
      case 'constant':
        return def.base;
      case 'age': {
        // Seconds since the last successful nav-import finished.
        const done = jobRuns
          .filter((j) => j.job.name === 'nav-import' && j.outcome === 'ok' && j.end.getTime() <= t.getTime())
          .map((j) => j.end.getTime());
        const last = done.length ? Math.max(...done) : t.getTime() - 9 * HOUR;
        return Math.round((t.getTime() - last) / 1000);
      }
    }
  }

  private buildMetrics(jobRuns: JobRun[]): MetricSeries[] {
    const grid = this.grid();
    const out: MetricSeries[] = [];
    for (const svc of this.services) {
      for (const def of svc.metrics) {
        const r = this.rng.fork(`metric:${svc.id}:${def.name}`);
        const effects = this.effects.filter((e) => e.service === svc.id && e.metric === def.name);
        const apply = (label: string | null, t: Date, v: number): number => {
          let x = v;
          for (const e of effects) {
            if (e.label !== undefined && e.label !== label) continue;
            const p = progress(e, t);
            if (p <= 0) continue;
            switch (e.op) {
              case 'mul':
                x = x * (1 + ((e.value ?? 1) - 1) * p);
                break;
              case 'add':
                x = x + (e.value ?? 0) * p;
                break;
              case 'set': {
                const target = (e.value ?? 0) * (1 + (e.noise ? r.normal(0, e.noise) : 0));
                x = x * (1 - p) + target * p;
                break;
              }
              case 'fn':
                x = e.fn!(x, t, p, r);
                break;
            }
          }
          if (def.kind === 'pct_success' || def.kind === 'pct_error' || def.unit === '%') x = Math.min(100, Math.max(0, x));
          if (def.kind === 'count' || def.kind === 'rate' || def.kind === 'latency' || def.kind === 'gauge') x = Math.max(0, x);
          return x;
        };
        const fmt = (v: number) => Number(v.toPrecision(5));
        if (!def.labels) {
          out.push({ s: svc.id, m: def.name, points: grid.map((t) => [t.toISOString(), fmt(apply(null, t, this.baseValue(def, svc.profile, t, r, 1, 1, jobRuns)))]) });
          continue;
        }
        const { key, values } = def.labels;
        const weights = def.labels.weights ?? values.map(() => 1 / values.length);
        const additive = def.kind === 'rate' || def.kind === 'count';
        const perLabel = values.map((lv, i) => {
          const lr = r.fork(lv);
          const labelMul = additive ? 1 : 0.8 + lr.next() * 0.45;
          return grid.map((t) => apply(lv, t, this.baseValue(def, svc.profile, t, lr, additive ? weights[i]! : 1, labelMul, jobRuns)));
        });
        const agg = grid.map((t, k) => {
          let v = 0;
          for (let i = 0; i < values.length; i++) v += additive ? perLabel[i]![k]! : weights[i]! * perLabel[i]![k]!;
          return [t.toISOString(), fmt(v)] as [string, number];
        });
        out.push({ s: svc.id, m: def.name, points: agg });
        values.forEach((lv, i) => {
          out.push({ s: svc.id, m: def.name, lk: key, lv, points: grid.map((t, k) => [t.toISOString(), fmt(perLabel[i]![k]!)]) });
        });
      }
    }
    return out.sort((a, b) => a.s.localeCompare(b.s) || a.m.localeCompare(b.m) || (a.lv ?? '').localeCompare(b.lv ?? ''));
  }

  // ----------------------------------------------------------------------------------- jobs

  private jobRuns(): JobRun[] {
    const runs: JobRun[] = [];
    // Look back far enough for the newest nav-import before dataFrom.
    const startDay = new Date(this.dataFrom.getTime() - 2 * DAY);
    for (let d = startDay.getTime(); d <= this.dataTo.getTime() + DAY; d += DAY) {
      const istDay = new Date(d + 5.5 * HOUR).toISOString().slice(0, 10);
      for (const job of this.jobs) {
        const [hh, mm] = job.atIst.split(':').map(Number) as [number, number];
        const start = new Date(Date.UTC(+istDay.slice(0, 4), +istDay.slice(5, 7) - 1, +istDay.slice(8, 10), hh, mm) - 5.5 * HOUR);
        if (job.days !== 'daily' && !job.days.includes(istWeekday(start))) continue;
        if (start.getTime() > this.dataTo.getTime()) continue;
        const outcome = this.jobOutcomes.get(`${job.name}@${start.getTime()}`) ?? 'ok';
        runs.push({ job, start, end: addMin(start, job.durationMin), outcome });
      }
    }
    return runs.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  // ----------------------------------------------------------------------------------- logs

  private stamp(at: Date, tz: LogTz): { ts: string; sourceTimestamp: string; sourceTz: string | null } {
    if (tz === 'naive_ist') return { ts: naiveReadAsUtc(at).toISOString(), sourceTimestamp: naiveIst(at), sourceTz: null };
    if (tz === 'ist_offset') return { ts: at.toISOString(), sourceTimestamp: isoIst(at), sourceTz: '+05:30' };
    return { ts: at.toISOString(), sourceTimestamp: at.toISOString(), sourceTz: '+00:00' };
  }

  private buildLogs(jobRuns: JobRun[]): LogEvent[] {
    const r = this.rng.fork('logs');
    const logs: LogEvent[] = [];
    const ids = new Set<string>();
    const newId = () => {
      let id: string;
      do id = `lg_${r.hex(10)}`;
      while (ids.has(id));
      ids.add(id);
      return id;
    };
    const svcTz = new Map(this.services.map((s) => [s.id, s.logTz as LogTz]));
    const push = (at: Date, service: string, sev: Sev, message: string, fields: Record<string, string | number>, tz?: LogTz) => {
      if (at.getTime() < this.dataFrom.getTime() || at.getTime() >= this.dataTo.getTime()) return;
      const st = this.stamp(at, tz ?? svcTz.get(service) ?? 'utc');
      // A misread (naive) timestamp can land after the end of the data: no query could reach it.
      if (Date.parse(st.ts) >= this.dataTo.getTime()) return;
      const f: Record<string, string | number> = { ...fields };
      if (f.version === undefined && service !== 'cache' && service !== 'database' && service !== 'message-queue') {
        f.version = this.versionAt(service, at.getTime());
      }
      logs.push({ id: newId(), ...st, service, severity: sev, message, fields: f });
    };

    // Background chatter.
    for (const svc of this.services) {
      if (svc.logDensity <= 0 || svc.logs.length === 0) continue;
      const sr = r.fork(svc.id);
      const weights = svc.logs.map((tpl) => [tpl, tpl.w] as const);
      for (let t = this.dataFrom.getTime(); t < this.dataTo.getTime(); t += MIN) {
        const at = new Date(t);
        const outside = t < this.highResFrom.getTime();
        const lambda = svc.logDensity * this.opts.logScale * this.factor(svc.profile, at) * (outside ? 0.3 : 1);
        const n = sr.poisson(lambda);
        for (let i = 0; i < n; i++) {
          const tpl = sr.weighted(weights);
          const when = new Date(t + Math.floor(sr.next() * MIN));
          push(when, svc.id, tpl.sev, tpl.msg(sr), tpl.fields ? tpl.fields(sr) : {});
        }
      }
    }

    // Scheduled jobs.
    const jr = r.fork('jobs');
    for (const run of jobRuns) {
      const has = (id: string) => this.services.some((s) => s.id === id);
      const runId = `run_${jr.hex(8)}`;
      if (has('job-scheduler')) push(run.start, 'job-scheduler', 'INFO', `job ${run.job.name} started (${runId})`, { job: run.job.name });
      if (run.outcome === 'skipped') continue;
      if (has(run.job.service)) push(addMin(run.start, 0.2), run.job.service, 'INFO', run.job.startMsg(jr), { job: run.job.name });
      if (run.outcome === 'ok') {
        if (has(run.job.service)) push(addMin(run.end, -0.1), run.job.service, 'INFO', run.job.endMsg(jr), { job: run.job.name });
        if (has('job-scheduler')) push(run.end, 'job-scheduler', 'INFO', `job ${run.job.name} finished ok in ${run.job.durationMin * 60}s (${runId})`, { job: run.job.name });
      } else {
        for (const f of run.job.failMsgs?.(jr) ?? []) {
          if (has(run.job.service)) push(addMin(run.start, f.afterMin), run.job.service, f.sev, f.msg, { job: run.job.name });
        }
        if (has('job-scheduler')) push(run.end, 'job-scheduler', 'ERROR', `job ${run.job.name} failed (${runId}); exit code 1`, { job: run.job.name });
      }
    }

    // Suppressions apply to background and job lines only.
    const sr = r.fork('suppress');
    const kept = logs.filter((l) => {
      const at = Date.parse(l.ts);
      for (const x of this.suppressions) {
        if (l.service !== x.service || at < x.from || at >= x.to) continue;
        if (x.contains && !l.message.includes(x.contains)) continue;
        if (x.fraction >= 1 || sr.next() < x.fraction) return false;
      }
      return true;
    });
    logs.length = 0;
    logs.push(...kept);

    // Scenario lines.
    for (const s of this.scripted) push(s.at, s.service, s.sev, s.msg, s.fields ?? {}, s.tz);

    return logs.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  }

  // -------------------------------------------------------------------------------- changes

  private isProtected(service: string, at: number): boolean {
    return this.protectedRanges.some((p) => p.services.includes(service) && at >= p.from && at <= p.to);
  }

  private routineChanges(): void {
    const r = this.rng.fork('routine-changes');
    const internal = this.services.filter((s) => s.kind === 'internal' && !['cache', 'database', 'message-queue'].includes(s.id));
    if (internal.length === 0) return;
    const from = this.dataTo.getTime() - 10 * DAY;
    const events: Array<{ at: Date; svc: ServiceDef; type: ChangeEvent['type'] }> = [];
    for (let d = from; d < this.dataTo.getTime(); d += DAY) {
      const day = new Date(d);
      const wd = istWeekday(day);
      const weekend = wd === 0 || wd === 6;
      const [lo, hi] = this.opts.routineChangesPerWeekday;
      const n = weekend ? r.int(0, 1) : r.int(lo, hi);
      const dayStartIst = Math.floor((d + 5.5 * HOUR) / DAY) * DAY - 5.5 * HOUR;
      for (let i = 0; i < n; i++) {
        const hourIst = r.chance(0.85) ? r.range(10.5, 19) : r.range(20, 23.5);
        const at = new Date(dayStartIst + hourIst * HOUR);
        if (at.getTime() >= this.dataTo.getTime() || at.getTime() < from) continue;
        events.push({ at, svc: r.pick(internal), type: r.weighted([['deploy', 0.6], ['config', 0.2], ['feature_flag', 0.15], ['infra', 0.05]] as const) });
      }
    }
    // A few unrelated changes inside the incident window (realistic noise).
    const inWindow = r.int(1, 3);
    for (let i = 0; i < inWindow; i++) {
      const at = new Date(this.window.from.getTime() + r.range(0.1, 0.9) * (this.window.to.getTime() - this.window.from.getTime()));
      events.push({ at, svc: r.pick(internal), type: r.weighted([['deploy', 0.5], ['config', 0.3], ['feature_flag', 0.2]] as const) });
    }
    // Services the scenario deploys keep a scenario-controlled version chain.
    const scripted = new Set(this.changeList.filter((c) => c.type === 'deploy' || c.type === 'rollback').map((c) => c.service));
    for (const ev of events.sort((a, b) => a.at.getTime() - b.at.getTime())) {
      if (this.isProtected(ev.svc.id, ev.at.getTime())) continue;
      const s = ev.svc.id;
      if (ev.type === 'deploy' && scripted.has(s)) continue;
      if (ev.type === 'deploy') {
        const minor = r.chance(0.25);
        this.change({
          at: ev.at,
          service: s,
          type: 'deploy',
          versionTo: this.nextVersion(s, ev.at, minor ? 'minor' : 'patch'),
          summary: r.pick(DEPLOY_SUMMARIES),
          author: r.chance(0.4) ? 'deploy-bot' : r.pick(AUTHORS),
          details: { pipeline: `build-${r.int(10000, 99999)}`, canary: r.chance(0.6) ? '10% for 15m, promoted' : 'none' },
        });
      } else if (ev.type === 'config') {
        const c = r.pick(CONFIG_CHANGES);
        this.change({ at: ev.at, service: s, type: 'config', summary: c.summary, details: c.details(r) });
      } else if (ev.type === 'feature_flag') {
        const flag = r.pick(FLAGS);
        const from = r.pick([0, 5, 10, 25, 50]);
        this.change({ at: ev.at, service: s, type: 'feature_flag', summary: `flag ${flag} rollout ${from}% -> ${Math.min(100, from * 2 + 5)}%`, details: { flag, from_pct: from, to_pct: Math.min(100, from * 2 + 5) } });
      } else {
        this.change({ at: ev.at, service: s, type: 'infra', summary: r.pick(INFRA_CHANGES), details: {} });
      }
    }
  }

  // -------------------------------------------------------------------------------- history

  private buildHistory(): HistoricalIncident[] {
    const r = this.rng.fork('history');
    const ids = new Set(this.services.map((s) => s.id));
    const pool = r.shuffle(HISTORY_POOL.filter((h) => h.services.every((s) => ids.has(s))));
    const chosen = pool.slice(0, Math.min(this.opts.historyCount, pool.length));
    const out: HistoricalIncident[] = [...this.historyList];
    for (const h of chosen) {
      const opened = new Date(this.dataFrom.getTime() - r.range(2, 60) * DAY);
      opened.setUTCMinutes(0, 0, 0);
      out.push({
        id: `PIR-${1000 + r.int(0, 899)}`,
        openedAt: opened.toISOString(),
        resolvedAt: addMin(opened, h.durationMin).toISOString(),
        title: h.title,
        severity: h.severity,
        services: h.services,
        symptoms: h.symptoms,
        rootCause: h.rootCause,
        resolution: h.resolution,
        tags: h.tags,
      });
    }
    const seen = new Set<string>();
    for (const h of out) {
      while (seen.has(h.id)) h.id = `PIR-${1000 + r.int(0, 8999)}`;
      seen.add(h.id);
    }
    return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }
}

interface JobRun {
  job: ScheduledJob;
  start: Date;
  end: Date;
  outcome: 'ok' | 'failed' | 'skipped';
}

function progress(e: MetricEffect, t: Date): number {
  const x = t.getTime();
  if (x < e.from.getTime()) return 0;
  if (e.to && x >= e.to.getTime()) return 0;
  let p = 1;
  if (e.rampMin && e.rampMin > 0) p = Math.min(1, (x - e.from.getTime()) / (e.rampMin * MIN));
  if (e.to && e.rampOutMin && e.rampOutMin > 0) p = Math.min(p, (e.to.getTime() - x) / (e.rampOutMin * MIN));
  return Math.max(0, p);
}

function defaultJobs(): ScheduledJob[] {
  return [
    {
      name: 'nav-import',
      service: 'market-data-service',
      atIst: '23:30',
      durationMin: 6,
      days: [1, 2, 3, 4, 5],
      startMsg: () => 'nav-import: downloading NAV file from amfi-nav-feed',
      endMsg: (r) => `nav-import: ${r.int(14100, 14400)} scheme NAVs updated; publishing to cache`,
    },
    {
      name: 'reconciliation',
      service: 'payment-service',
      atIst: '02:00',
      durationMin: 25,
      days: 'daily',
      startMsg: () => 'reconciliation: matching yesterday\'s settlements',
      endMsg: (r) => `reconciliation: ${r.int(40000, 90000)} transactions matched, ${r.int(0, 4)} exceptions`,
    },
    {
      name: 'sip-debit-batch',
      service: 'debit-worker',
      atIst: '06:00',
      durationMin: 120,
      days: [1, 2, 3, 4, 5],
      startMsg: (r) => `sip-debit-batch: ${r.int(140000, 180000)} instalments due today; presenting debits`,
      endMsg: (r) => `sip-debit-batch: completed, ${r.int(97, 99)}% confirmed`,
    },
    {
      name: 'payout-batch-am',
      service: 'payout-service',
      atIst: '10:00',
      durationMin: 14,
      days: [1, 2, 3, 4, 5],
      startMsg: (r) => `payout batch started: ${r.int(1800, 3200)} redemptions queued`,
      endMsg: (r) => `payout batch completed: ${r.int(1800, 3200)} payouts sent`,
    },
    {
      name: 'payout-batch-pm',
      service: 'payout-service',
      atIst: '14:00',
      durationMin: 14,
      days: [1, 2, 3, 4, 5],
      startMsg: (r) => `payout batch started: ${r.int(1500, 2600)} redemptions queued`,
      endMsg: (r) => `payout batch completed: ${r.int(1500, 2600)} payouts sent`,
    },
  ];
}

const DEPLOY_SUMMARIES = [
  'routine release: dependency bumps and logging tweaks',
  'release: minor UI copy endpoints and metrics labels',
  'release: refactor request validation',
  'release: performance improvements to serialization',
  'release: add tracing spans to outbound calls',
  'release: fix pagination edge case',
  'release: upgrade HTTP client library',
  'release: feature work behind a disabled flag',
];

const CONFIG_CHANGES: Array<{ summary: string; details: (r: Rng) => Record<string, string | number | boolean> }> = [
  { summary: 'log level for module http.client: INFO -> DEBUG -> INFO', details: () => ({ key: 'logging.http_client', value: 'INFO' }) },
  { summary: 'autoscaling: max replicas raised', details: (r) => ({ key: 'autoscaling.max_replicas', from: 12, to: 12 + r.int(2, 6) }) },
  { summary: 'metrics scrape interval adjusted', details: () => ({ key: 'telemetry.scrape_interval_s', from: 30, to: 15 }) },
  { summary: 'alert threshold tuned', details: (r) => ({ key: 'alerts.error_rate_pct', from: 2, to: 2 + r.int(1, 2) }) },
  { summary: 'cache TTL for static content raised', details: () => ({ key: 'cache.static_ttl_s', from: 300, to: 600 }) },
];

const FLAGS = ['new_watchlist_ui', 'portfolio_insights_v2', 'sip_step_up', 'assistant_followup_suggestions', 'faster_kyc_flow', 'order_ticket_redesign'];
const INFRA_CHANGES = ['node pool OS image patched', 'TLS certificates rotated', 'service mesh sidecar upgraded', 'log shipper agent upgraded'];
