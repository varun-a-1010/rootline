import type { RunEvent } from '../contracts/events.js';
import { parseEvent } from '../contracts/events.js';
import type { Db } from '../db/client.js';
import type { RunLog } from './events.js';

/**
 * Persists a run's event log (and the derived run, evidence and attempt rows) to Postgres.
 * Writes are serialized in event order; flush() waits for them.
 */
export class DbRunStore {
  private chain: Promise<void> = Promise.resolve();
  private error: Error | null = null;

  constructor(private readonly db: Db) {}

  attach(log: RunLog): () => void {
    return log.on((e) => {
      this.chain = this.chain.then(() => this.write(e)).catch((err: Error) => {
        this.error ??= err;
      });
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.error) throw this.error;
  }

  private async write(e: RunEvent): Promise<void> {
    await this.db.query('INSERT INTO investigation_events (run_id, seq, ts, type, task_id, payload) VALUES ($1, $2, $3, $4, $5, $6)', [e.runId, e.seq, e.ts, e.type, e.taskId, JSON.stringify(e.payload)]);
    const p = e.payload as Record<string, any>;
    switch (e.type) {
      case 'run.created':
        await this.db.query(
          `INSERT INTO investigation_runs (run_id, world_id, incident_id, arm, status, started_at, meta) VALUES ($1, $2, $3, $4, 'running', to_timestamp($5 / 1000.0), $6)`,
          [e.runId, p.worldId, p.incident.incidentId, p.config.arm, e.ts, JSON.stringify({ config: p.config })],
        );
        break;
      case 'evidence.recorded':
        await this.db.query('INSERT INTO evidence_records (run_id, evidence_id, tool, body) VALUES ($1, $2, $3, $4)', [e.runId, p.evidenceId, p.tool, JSON.stringify(p)]);
        break;
      case 'tool.attempt':
        await this.db.query('INSERT INTO tool_attempts (run_id, attempt_id, tool, attempt, status, error_code, latency_ms, body) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [e.runId, p.attemptId, p.tool, p.attempt, p.status, p.errorCode, p.latencyMs, JSON.stringify(p)]);
        break;
      case 'report.ready':
        await this.db.query('UPDATE investigation_runs SET report = $2 WHERE run_id = $1', [e.runId, JSON.stringify(p.report)]);
        break;
      case 'run.terminated':
        await this.db.query('UPDATE investigation_runs SET status = $2, stop_reason = $3, ended_at = to_timestamp($4 / 1000.0) WHERE run_id = $1', [e.runId, p.status, p.stopReason, p.endedAt]);
        break;
      default:
        break;
    }
  }
}

/** Load and validate a persisted run's events, in order. */
export async function loadRunEvents(db: Db, runId: string, afterSeq = 0): Promise<RunEvent[]> {
  const rows = await db.query<{ seq: number; ts: string; type: string; task_id: string | null; payload: unknown }>(
    'SELECT seq, ts, type, task_id, payload FROM investigation_events WHERE run_id = $1 AND seq > $2 ORDER BY seq',
    [runId, afterSeq],
  );
  return rows.map((r) => parseEvent({ seq: Number(r.seq), ts: Number(r.ts), runId, type: r.type, taskId: r.task_id, payload: r.payload }));
}

export async function listRuns(db: Db, limit = 50): Promise<Array<Record<string, unknown>>> {
  return db.query(
    `SELECT run_id, world_id, incident_id, arm, status, stop_reason, started_at, ended_at, report->>'outcome' AS outcome
     FROM investigation_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
}
