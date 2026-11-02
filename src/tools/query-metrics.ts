import { QueryMetricsInput } from '../contracts/tools.js';
import { metricLabelKeys, metricNames, queryMetricBuckets } from '../db/queries.js';
import { checkWindow, HOUR, validateRange, requireService, retentionNote, round } from './common.js';
import { ToolInputError, type ToolContext, type ToolDef, type ToolOutput } from './types.js';

const RES_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 } as const;
type Res = keyof typeof RES_SECONDS;
const DEFAULT_MAX_POINTS = 60;
const HARD_MAX_POINTS = 360;

interface Series {
  labels: Record<string, string>;
  unit: string;
  resolution: Res;
  points: Array<[string, number]>;
}

function stats(points: Array<[string, number]>) {
  if (points.length === 0) return null;
  let min = points[0]![1];
  let max = min;
  let maxAt = points[0]![0];
  let minAt = maxAt;
  let sum = 0;
  for (const [t, v] of points) {
    sum += v;
    if (v > max) [max, maxAt] = [v, t];
    if (v < min) [min, minAt] = [v, t];
  }
  return {
    n: points.length,
    first: round(points[0]![1]),
    last: round(points[points.length - 1]![1]),
    mean: round(sum / points.length),
    min: round(min),
    min_at: minAt,
    max: round(max),
    max_at: maxAt,
  };
}

const shortTs = (iso: string) => iso.slice(0, 16) + 'Z';

export const queryMetrics: ToolDef<QueryMetricsInput> = {
  name: 'query_metrics',
  source: 'metrics-store',
  description:
    'Fetch one metric time series for a service over a time range (max 24 h), bucketed at a resolution (1m/5m/15m/1h) with avg/min/max. Optionally split by one label (group_by, e.g. bank or route). Returns points plus summary stats (first/last/mean/min/max and when). Data older than the high-resolution retention exists only as 5-minute rollups.',
  input: QueryMetricsInput,

  canonicalize(input, ctx) {
    requireService(ctx, input.service);
    return {
      service: input.service,
      metric: input.metric,
      ...validateRange(input.from, input.to, 24 * HOUR),
      resolution: input.resolution,
      aggregation: input.aggregation ?? 'avg',
      group_by: input.group_by,
    };
  },

  async execute(ctx: ToolContext, p): Promise<ToolOutput> {
    const service = p.service as string;
    const metric = p.metric as string;
    const info = ctx.services.get(service)!;
    const known = await metricNames(ctx.db, ctx.worldId, service);
    if (!known.includes(metric)) {
      throw new ToolInputError(
        `service ${service} has no metric "${metric}". Available: ${known.length ? known.join(', ') : '(none — this service is observed through its callers)'}`,
      );
    }
    const groupBy = (p.group_by as string | undefined) ?? null;
    if (groupBy) {
      const keys = await metricLabelKeys(ctx.db, ctx.worldId, service, metric);
      if (!keys.includes(groupBy)) {
        throw new ToolInputError(
          `metric ${service}/${metric} cannot be grouped by "${groupBy}". Available labels: ${keys.length ? keys.join(', ') : '(none)'}`,
        );
      }
    }
    const retained = { from: ctx.world.dataFrom, to: ctx.world.dataTo };
    const w = checkWindow(p.from as string, p.to as string, 24 * HOUR, retained);
    const notes: string[] = [];
    const rn = retentionNote(w, retained);
    if (rn) notes.push(rn);

    const spanS = (Date.parse(w.to) - Date.parse(w.from)) / 1000;
    let res: Res;
    const requested = p.resolution as Res | undefined;
    if (requested) {
      res = requested;
      const order: Res[] = ['1m', '5m', '15m', '1h'];
      while (spanS / RES_SECONDS[res] > HARD_MAX_POINTS && res !== '1h') res = order[order.indexOf(res) + 1]!;
      if (res !== requested) notes.push(`resolution ${requested} would exceed ${HARD_MAX_POINTS} points; used ${res}.`);
    } else {
      res = (['1m', '5m', '15m', '1h'] as Res[]).find((r) => spanS / RES_SECONDS[r] <= DEFAULT_MAX_POINTS) ?? '1h';
    }
    if (Date.parse(w.from) < Date.parse(ctx.world.highResFrom) && RES_SECONDS[res] < 300) {
      notes.push(`before ${ctx.world.highResFrom} only 5-minute rollups exist, so points there are 5 minutes apart.`);
    }

    const buckets =
      w.from === w.to
        ? []
        : await queryMetricBuckets(ctx.db, ctx.worldId, {
            service,
            metric,
            from: w.from,
            to: w.to,
            bucketSeconds: RES_SECONDS[res],
            agg: p.aggregation as 'avg' | 'min' | 'max',
            labelKey: groupBy,
          });
    const unit = info.metrics.find((m) => m.name === metric)?.unit ?? '';
    const byLabel = new Map<string, Series>();
    for (const b of buckets) {
      const key = b.label ?? '';
      let s = byLabel.get(key);
      if (!s) {
        s = { labels: groupBy && b.label !== null ? { [groupBy]: b.label } : {}, unit, resolution: res, points: [] };
        byLabel.set(key, s);
      }
      s.points.push([b.ts, b.value]);
    }
    const series = [...byLabel.values()];
    if (series.length === 0) notes.push('no data points in range.');
    return {
      records: series,
      modelRecords: series.map((s) => ({
        labels: s.labels,
        unit: s.unit,
        resolution: s.resolution,
        stats: stats(s.points),
        points: s.points.map(([t, v]) => [shortTs(t), round(v)]),
      })),
      refs: series.map((s) => seriesKey(service, metric, s.labels)),
      services: [service],
      window: { from: w.from, to: w.to },
      completeness: w.clamped ? 'partial' : 'complete',
      coverage: w.clamped
        ? { requested: `${w.requested.from}..${w.requested.to}`, returned: `${w.from}..${w.to}`, fraction: w.fraction }
        : undefined,
      truncated: false,
      notes,
    };
  },

  /** Partial results for metrics drop points within each series, not whole series. */
  drop(out, keep) {
    const records = (out.records as Series[]).map((s, i) => ({
      ...s,
      points: s.points.filter(([t]) => keep(`${out.refs[i]}@${t}`)),
    }));
    return {
      ...out,
      records,
      modelRecords: records.map((s) => ({
        labels: s.labels,
        unit: s.unit,
        resolution: s.resolution,
        stats: stats(s.points),
        points: s.points.map(([t, v]) => [shortTs(t), round(v)]),
      })),
    };
  },
};

export function seriesKey(service: string, metric: string, labels: Record<string, string>): string {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `metric:${service}/${metric}${l ? `{${l}}` : ''}`;
}
