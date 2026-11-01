import type { WorldData } from '../contracts/world.js';
import type { Db } from './client.js';

/** Message template: ids and numbers masked, so "count_by: message" groups similar lines. */
export function messageTemplate(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b[A-Z]{2,5}-\d{3,}\b/g, '<ref>')
    .replace(/\d+(\.\d+)?/g, '#');
}

const CHUNK = 4000;

async function bulk(db: Db, sql: string, columns: unknown[][]): Promise<void> {
  const n = columns[0]?.length ?? 0;
  for (let i = 0; i < n; i += CHUNK) {
    await db.query(
      sql,
      columns.map((c) => c.slice(i, i + CHUNK)),
    );
  }
}

export async function deleteWorld(db: Db, worldId: string): Promise<void> {
  for (const table of [
    'incident_reports',
    'services',
    'service_dependencies',
    'log_events',
    'metric_points',
    'change_events',
    'historical_incidents',
    'worlds',
  ]) {
    await db.query(`DELETE FROM ${table} WHERE world_id = $1`, [worldId]);
  }
}

/** Insert one world (replacing any previous copy). */
export async function loadWorld(db: Db, world: WorldData, fixtureHash: string): Promise<void> {
  const id = world.meta.worldId;
  await deleteWorld(db, id);
  await db.query(
    `INSERT INTO worlds (world_id, data_from, data_to, high_res_from, generator, fixture_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, world.meta.dataFrom, world.meta.dataTo, world.meta.highResFrom, world.meta.generator, fixtureHash],
  );
  await db.query(
    `INSERT INTO incident_reports (world_id, incident_id, title, reported_at, body) VALUES ($1, $2, $3, $4, $5)`,
    [id, world.incident.incidentId, world.incident.title, world.incident.reportedAt, JSON.stringify(world.incident)],
  );
  await bulk(
    db,
    `INSERT INTO services (world_id, service_id, kind, body)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[])`,
    [
      world.services.map(() => id),
      world.services.map((s) => s.id),
      world.services.map((s) => s.kind),
      world.services.map((s) => JSON.stringify(s)),
    ],
  );
  await bulk(
    db,
    `INSERT INTO service_dependencies (world_id, from_service, to_service, body)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[])`,
    [
      world.dependencies.map(() => id),
      world.dependencies.map((d) => d.from),
      world.dependencies.map((d) => d.to),
      world.dependencies.map((d) => JSON.stringify(d)),
    ],
  );
  await bulk(
    db,
    `INSERT INTO log_events (world_id, log_id, ts, source_timestamp, source_tz, service, severity, message, template, fields)
     SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::jsonb[])`,
    [
      world.logs.map(() => id),
      world.logs.map((l) => l.id),
      world.logs.map((l) => l.ts),
      world.logs.map((l) => l.sourceTimestamp),
      world.logs.map((l) => l.sourceTz),
      world.logs.map((l) => l.service),
      world.logs.map((l) => l.severity),
      world.logs.map((l) => l.message),
      world.logs.map((l) => messageTemplate(l.message)),
      world.logs.map((l) => JSON.stringify(l.fields)),
    ],
  );
  const mp = world.metrics.flatMap((series) => series.points.map(([t, v]) => ({ series, t, v })));
  await bulk(
    db,
    `INSERT INTO metric_points (world_id, service, metric, ts, value, label_key, label_value)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::float8[], $6::text[], $7::text[])`,
    [
      mp.map(() => id),
      mp.map((p) => p.series.s),
      mp.map((p) => p.series.m),
      mp.map((p) => p.t),
      mp.map((p) => p.v),
      mp.map((p) => p.series.lk ?? null),
      mp.map((p) => p.series.lv ?? null),
    ],
  );
  await bulk(
    db,
    `INSERT INTO change_events (world_id, change_id, ts, source_timestamp, source_tz, service, change_type, body)
     SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb[])`,
    [
      world.changes.map(() => id),
      world.changes.map((c) => c.id),
      world.changes.map((c) => c.ts),
      world.changes.map((c) => c.sourceTimestamp),
      world.changes.map((c) => c.sourceTz),
      world.changes.map((c) => c.service),
      world.changes.map((c) => c.type),
      world.changes.map((c) => JSON.stringify(c)),
    ],
  );
  for (const h of world.history) {
    await db.query(
      `INSERT INTO historical_incidents (world_id, incident_id, opened_at, services, search_text, body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        h.id,
        h.openedAt,
        h.services,
        [h.title, h.symptoms, h.rootCause, h.resolution, h.tags.join(' '), h.services.join(' ')].join(' \n ').toLowerCase(),
        JSON.stringify(h),
      ],
    );
  }
}

export async function loadedWorlds(db: Db): Promise<Array<{ worldId: string; fixtureHash: string }>> {
  const rows = await db.query<{ world_id: string; fixture_hash: string }>(
    'SELECT world_id, fixture_hash FROM worlds ORDER BY world_id',
  );
  return rows.map((r) => ({ worldId: r.world_id, fixtureHash: r.fixture_hash }));
}
