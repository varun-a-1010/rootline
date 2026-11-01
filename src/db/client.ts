import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { projectRoot } from '../util/paths.js';

/**
 * One tiny interface over two Postgres engines:
 *  - PGlite (in-process Postgres): the default for tests, local runs and reviewers.
 *  - node-postgres against DATABASE_URL (the Deltabase-hosted database).
 * The SQL is identical; only the transport differs.
 */
export interface Db {
  readonly kind: 'pglite' | 'pg';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function schemaSql(): string {
  return readFileSync(join(projectRoot(), 'src/db/schema.sql'), 'utf8');
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private readonly db: PGlite) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.db.query<T>(sql, params);
    return res.rows;
  }
  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

class PgDb implements Db {
  readonly kind = 'pg' as const;
  constructor(private readonly pool: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params);
    return res.rows as T[];
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface OpenDbOptions {
  /** A Postgres connection string. When set, PGlite is not used and no DDL is run. */
  url?: string;
  /** PGlite data directory, or 'memory' (default). */
  dataDir?: string;
}

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: 8 });
    // The schema on a DATABASE_URL database is owned by Deltabase; never run DDL here.
    return new PgDb(pool);
  }
  if (opts.dataDir && opts.dataDir !== 'memory') mkdirSync(opts.dataDir, { recursive: true });
  const pglite = opts.dataDir && opts.dataDir !== 'memory' ? new PGlite(opts.dataDir) : new PGlite();
  await pglite.waitReady;
  const db = new PgliteDb(pglite);
  await db.exec(schemaSql());
  return db;
}
