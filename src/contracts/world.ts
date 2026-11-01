import { z } from 'zod';
import { ChangeType, IsoTime, ServiceId, Severity, TimeWindow } from './common.js';

/**
 * The on-disk fixture format for one world (fixtures/v1/<worldId>/...).
 * A world is a self-contained partition of synthetic operational data. The world id is opaque.
 */

export const WorldMeta = z.object({
  worldId: z.string().regex(/^w_[0-9a-f]{8}$/),
  dataFrom: IsoTime,
  dataTo: IsoTime,
  /** Metrics are per-minute inside this range and 5-minute rollups outside it. */
  highResFrom: IsoTime,
  generator: z.string(),
});
export type WorldMeta = z.infer<typeof WorldMeta>;

export const IncidentReport = z.object({
  incidentId: z.string(),
  title: z.string(),
  reportedAt: IsoTime,
  reportedBy: z.string(),
  severity: z.enum(['SEV1', 'SEV2', 'SEV3']),
  /** Free text as the reporter wrote it. Times are quoted in IST. Never states the cause. */
  summary: z.string(),
  symptoms: z.array(z.string()),
  userImpact: z.string(),
  affectedSurface: z.string(),
  /** What the reporter believes is affected: a starting point, not a finding. */
  suspectedServices: z.array(ServiceId),
  approxStart: IsoTime,
  window: TimeWindow,
});
export type IncidentReport = z.infer<typeof IncidentReport>;

export const MetricInfo = z.object({
  name: z.string(),
  unit: z.string(),
  description: z.string(),
  /** Label keys this metric can be grouped by (at most one at a time). */
  labels: z.array(z.string()),
});
export type MetricInfo = z.infer<typeof MetricInfo>;

export const ServiceInfo = z.object({
  id: ServiceId,
  name: z.string(),
  kind: z.enum(['internal', 'external']),
  team: z.string(),
  tier: z.number().int().min(1).max(3),
  description: z.string(),
  metrics: z.array(MetricInfo),
});
export type ServiceInfo = z.infer<typeof ServiceInfo>;

export const DependencyEdge = z.object({
  from: ServiceId,
  to: ServiceId,
  kind: z.enum(['sync', 'async', 'datastore', 'cache', 'external_api']),
  critical: z.boolean(),
  timeoutMs: z.number().int().nullable(),
  retries: z.number().int().nullable(),
  notes: z.string().nullable(),
});
export type DependencyEdge = z.infer<typeof DependencyEdge>;

export const LogFieldValue = z.union([z.string(), z.number()]);
export const LogEvent = z.object({
  id: z.string(),
  /** The log store's indexed time (UTC). For sources without an offset the ingest pipeline assumed UTC. */
  ts: IsoTime,
  /** Exactly what the source emitted. */
  sourceTimestamp: z.string(),
  /** The offset the source declared ("+00:00", "+05:30"), or null if the source had none. */
  sourceTz: z.string().nullable(),
  service: ServiceId,
  severity: Severity,
  message: z.string(),
  fields: z.record(z.string(), LogFieldValue),
});
export type LogEvent = z.infer<typeof LogEvent>;

/**
 * One metric series as stored in metrics.jsonl.gz (one line per series; the loader expands
 * it into metric_points rows). lk/lv: optional single label. A series with no label is the
 * overall series for that metric.
 */
export const MetricSeries = z.object({
  s: ServiceId,
  m: z.string(),
  lk: z.string().optional(),
  lv: z.string().optional(),
  points: z.array(z.tuple([IsoTime, z.number()])),
});
export type MetricSeries = z.infer<typeof MetricSeries>;

export const ChangeEvent = z.object({
  id: z.string(),
  ts: IsoTime,
  sourceTimestamp: z.string(),
  sourceTz: z.string().nullable(),
  service: ServiceId,
  type: ChangeType,
  summary: z.string(),
  versionFrom: z.string().nullable(),
  versionTo: z.string().nullable(),
  author: z.string(),
  status: z.enum(['completed', 'rolled_back', 'failed', 'in_progress']),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

export const HistoricalIncident = z.object({
  id: z.string(),
  openedAt: IsoTime,
  resolvedAt: IsoTime,
  title: z.string(),
  severity: z.enum(['SEV1', 'SEV2', 'SEV3']),
  services: z.array(ServiceId),
  symptoms: z.string(),
  rootCause: z.string(),
  resolution: z.string(),
  tags: z.array(z.string()),
});
export type HistoricalIncident = z.infer<typeof HistoricalIncident>;

/** world.json: the small tables. Large tables live in gzipped JSONL beside it. */
export const WorldFile = z.object({
  meta: WorldMeta,
  incident: IncidentReport,
  services: z.array(ServiceInfo),
  dependencies: z.array(DependencyEdge),
  changes: z.array(ChangeEvent),
  history: z.array(HistoricalIncident),
});
export type WorldFile = z.infer<typeof WorldFile>;

/** Everything the loader needs for one world. */
export interface WorldData extends WorldFile {
  logs: LogEvent[];
  metrics: MetricSeries[];
}
