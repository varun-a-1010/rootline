import type {
  ChangeEvent,
  DependencyEdge,
  HistoricalIncident,
  IncidentReport,
  ServiceInfo,
  WorldMeta,
} from '../contracts/world.js';
import type { Db } from './client.js';

/**
 * The data layer: fixed, parameterized queries only. No caller ever supplies SQL, and every
 * query is scoped to one world.
 */

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface WorldRow {
  meta: WorldMeta;
  fixtureHash: string;
}

export async function getWorld(db: Db, worldId: string): Promise<WorldRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT world_id, data_from, data_to, high_res_from, generator, fixture_hash FROM worlds WHERE world_id = $1',
    [worldId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    meta: {
      worldId: String(r.world_id),
      dataFrom: iso(r.data_from),
      dataTo: iso(r.data_to),
      highResFrom: iso(r.high_res_from),
      generator: String(r.generator),
    },
    fixtureHash: String(r.fixture_hash),
  };
}

export async function getIncident(db: Db, worldId: string): Promise<IncidentReport | null> {
  const rows = await db.query<{ body: IncidentReport }>('SELECT body FROM incident_reports WHERE world_id = $1', [worldId]);
  return rows[0]?.body ?? null;
}

export async function listIncidents(db: Db): Promise<Array<{ worldId: string; incident: IncidentReport }>> {
  const rows = await db.query<{ world_id: string; body: IncidentReport }>(
    'SELECT world_id, body FROM incident_reports ORDER BY reported_at',
  );
  return rows.map((r) => ({ worldId: r.world_id, incident: r.body }));
}

export async function getServices(db: Db, worldId: string): Promise<ServiceInfo[]> {
  const rows = await db.query<{ body: ServiceInfo }>(
    'SELECT body FROM services WHERE world_id = $1 ORDER BY service_id',
    [worldId],
  );
  return rows.map((r) => r.body);
}

export async function getDependencyEdges(db: Db, worldId: string): Promise<DependencyEdge[]> {
  const rows = await db.query<{ body: DependencyEdge }>(
    'SELECT body FROM service_dependencies WHERE world_id = $1 ORDER BY from_service, to_service',
    [worldId],
  );
  return rows.map((r) => r.body);
}

// ------------------------------------------------------------------------------------- logs

export interface LogFilter {
  services: string[];
  from: string;
  to: string;
  severities: string[] | null;
  contains: string | null;
  where: Array<{ field: string; value: string }>;
}

export interface LogRow {
  id: string;
  ts: string;
  sourceTimestamp: string;
  sourceTz: string | null;
  service: string;
  severity: string;
  message: string;
  fields: Record<string, string | number>;
}

const LOG_WHERE = `
  world_id = $1 AND service = ANY($2::text[]) AND ts >= $3 AND ts < $4
  AND ($5::text[] IS NULL OR severity = ANY($5::text[]))
  AND ($6::text IS NULL OR position(lower($6::text) in lower(message)) > 0)
  AND ($7::text IS NULL OR fields->>$7::text = $8::text)
  AND ($9::text IS NULL OR fields->>$9::text = $10::text)
  AND ($11::text IS NULL OR fields->>$11::text = $12::text)`;

function logParams(worldId: string, f: LogFilter): unknown[] {
  const w = [0, 1, 2].flatMap((i) => [f.where[i]?.field ?? null, f.where[i]?.value ?? null]);
  return [worldId, f.services, f.from, f.to, f.severities, f.contains, ...w];
}

/** Keyset-paginated log page. Returns up to limit+1 rows so the caller can detect more. */
export async function queryLogPage(
  db: Db,
  worldId: string,
  f: LogFilter,
  page: { limit: number; order: 'asc' | 'desc'; after: { ts: string; id: string } | null },
): Promise<LogRow[]> {
  const asc = page.order === 'asc';
  const sql = `
    SELECT log_id, ts, source_timestamp, source_tz, service, severity, message, fields
    FROM log_events
    WHERE ${LOG_WHERE}
      AND ($13::timestamptz IS NULL OR (ts, log_id) ${asc ? '>' : '<'} ($13::timestamptz, $14::text))
    ORDER BY ts ${asc ? 'ASC' : 'DESC'}, log_id ${asc ? 'ASC' : 'DESC'}
    LIMIT $15`;
  const rows = await db.query<Record<string, unknown>>(sql, [
    ...logParams(worldId, f),
    page.after?.ts ?? null,
    page.after?.id ?? null,
    page.limit + 1,
  ]);
  return rows.map((r) => ({
    id: String(r.log_id),
    ts: iso(r.ts),
    sourceTimestamp: String(r.source_timestamp),
    sourceTz: (r.source_tz as string | null) ?? null,
    service: String(r.service),
    severity: String(r.severity),
    message: String(r.message),
    fields: r.fields as Record<string, string | number>,
  }));
}

/** Column expression per count_by option. A fixed whitelist: no caller-supplied SQL. */
const COUNT_EXPR: Record<string, string> = {
  severity: 'severity',
  service: 'service',
  message: 'template',
};

export async function countLogs(
  db: Db,
  worldId: string,
  f: LogFilter,
  by: string,
): Promise<{ total: number; groups: Array<{ key: string; count: number; firstTs: string; lastTs: string }> }> {
  const expr = COUNT_EXPR[by] ?? 'fields->>$13::text';
  const params = [...logParams(worldId, f), COUNT_EXPR[by] ? null : by];
  const groups = await db.query<Record<string, unknown>>(
    `SELECT ${expr} AS k, count(*)::int AS n, min(ts) AS first_ts, max(ts) AS last_ts
     FROM log_events WHERE ${LOG_WHERE} AND ($13::text IS NULL OR $13::text IS NOT NULL)
     GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 25`,
    params,
  );
  const total = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM log_events WHERE ${LOG_WHERE} AND ($13::text IS NULL OR $13::text IS NOT NULL)`,
    params,
  );
  return {
    total: total[0]?.n ?? 0,
    groups: groups.map((g) => ({
      key: g.k === null ? '(none)' : String(g.k),
      count: Number(g.n),
      firstTs: iso(g.first_ts),
      lastTs: iso(g.last_ts),
    })),
  };
}

// ---------------------------------------------------------------------------------- metrics

export async function metricNames(db: Db, worldId: string, service: string): Promise<string[]> {
  const rows = await db.query<{ metric: string }>(
    'SELECT DISTINCT metric FROM metric_points WHERE world_id = $1 AND service = $2 ORDER BY metric',
    [worldId, service],
  );
  return rows.map((r) => r.metric);
}

export async function metricLabelKeys(db: Db, worldId: string, service: string, metric: string): Promise<string[]> {
  const rows = await db.query<{ label_key: string }>(
    `SELECT DISTINCT label_key FROM metric_points
     WHERE world_id = $1 AND service = $2 AND metric = $3 AND label_key IS NOT NULL ORDER BY label_key`,
    [worldId, service, metric],
  );
  return rows.map((r) => r.label_key);
}

export interface MetricBucket {
  ts: string;
  value: number;
  label: string | null;
  points: number;
}

/**
 * Bucketed series. labelKey null = the overall (unlabeled) series; otherwise one series per
 * value of that label.
 */
export async function queryMetricBuckets(
  db: Db,
  worldId: string,
  q: { service: string; metric: string; from: string; to: string; bucketSeconds: number; agg: 'avg' | 'min' | 'max'; labelKey: string | null },
): Promise<MetricBucket[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT date_bin(make_interval(secs => $6::int), ts, TIMESTAMPTZ '2000-01-01T00:00:00Z') AS b,
            label_value AS lv,
            CASE $8::text WHEN 'min' THEN min(value) WHEN 'max' THEN max(value) ELSE avg(value) END AS v,
            count(*)::int AS n
     FROM metric_points
     WHERE world_id = $1 AND service = $2 AND metric = $3 AND ts >= $4 AND ts < $5
       AND (($7::text IS NULL AND label_key IS NULL) OR label_key = $7::text)
     GROUP BY 1, 2 ORDER BY 2 NULLS FIRST, 1`,
    [worldId, q.service, q.metric, q.from, q.to, q.bucketSeconds, q.labelKey, q.agg],
  );
  return rows.map((r) => ({
    ts: iso(r.b),
    value: Number(r.v),
    label: (r.lv as string | null) ?? null,
    points: Number(r.n),
  }));
}

// ---------------------------------------------------------------------------------- changes

export async function queryChanges(
  db: Db,
  worldId: string,
  q: { services: string[] | null; from: string; to: string; types: string[] | null; limit: number },
): Promise<ChangeEvent[]> {
  const rows = await db.query<{ body: ChangeEvent }>(
    `SELECT body FROM change_events
     WHERE world_id = $1 AND ts >= $2 AND ts < $3
       AND ($4::text[] IS NULL OR service = ANY($4::text[]))
       AND ($5::text[] IS NULL OR change_type = ANY($5::text[]))
     ORDER BY ts, change_id LIMIT $6`,
    [worldId, q.from, q.to, q.services, q.types, q.limit + 1],
  );
  return rows.map((r) => r.body);
}

// --------------------------------------------------------------------------------- history

export async function queryHistory(
  db: Db,
  worldId: string,
  q: { services: string[] | null; terms: string[] | null; from: string | null; to: string | null },
): Promise<HistoricalIncident[]> {
  const rows = await db.query<{ body: HistoricalIncident }>(
    `SELECT body FROM historical_incidents
     WHERE world_id = $1
       AND ($2::timestamptz IS NULL OR opened_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR opened_at < $3::timestamptz)
       AND (
         ($4::text[] IS NULL AND $5::text[] IS NULL)
         OR ($4::text[] IS NOT NULL AND services && $4::text[])
         OR ($5::text[] IS NOT NULL AND EXISTS (
               SELECT 1 FROM unnest($5::text[]) AS term WHERE position(term in search_text) > 0))
       )
     ORDER BY opened_at DESC`,
    [worldId, q.from, q.to, q.services, q.terms],
  );
  return rows.map((r) => r.body);
}
