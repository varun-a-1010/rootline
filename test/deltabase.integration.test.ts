import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import { readFaults, readIndex } from '../src/db/fixtures.js';
import { DbRunStore, loadRunEvents } from '../src/engine/persistence.js';
import { fold } from '../src/engine/run-state.js';
import { runInvestigation } from '../src/engine/run.js';
import '../src/orchestrations/all.js';
import { brain } from './helpers/brain.js';
import { SETTINGS } from './helpers/engine.js';

/**
 * Against a real Postgres (DATABASE_URL), with scripted models. Skipped by `npm test`, which
 * never touches the network. Run with ROOTLINE_INTEGRATION_DB=1 and DATABASE_URL set.
 * It removes the rows it writes.
 */
describe.skipIf(!process.env.ROOTLINE_INTEGRATION_DB || !process.env.DATABASE_URL)('hosted database integration', () => {
  it('arms A and E run end to end on DATABASE_URL, and persisted events replay to the live state', async () => {
    const db = await openDb({ url: process.env.DATABASE_URL });
    const worldId = readIndex().worlds.find((w) => w.key === 's04-A')!.worldId;
    const runIds: string[] = [];
    try {
      for (const arm of ['A', 'E'] as const) {
        const store = new DbRunStore(db);
        const r = await runInvestigation({ db, worldId, arm, llm: brain({ criticDecisions: ['accept'] }), settings: { ...SETTINGS, deadlineMs: 120_000 }, store, faults: { ...readFaults(worldId), latency: { minMs: 0, maxMs: 2 } }, toolBackoffMs: 1 });
        runIds.push(r.runId);
        expect(r.report).toBeTruthy();
        expect(r.state.status, arm).toBe('completed');
        expect(Object.keys(r.state.evidence).length, arm).toBeGreaterThan(0);
        const persisted = await loadRunEvents(db, r.runId);
        expect(persisted).toHaveLength(r.events.length);
        expect(fold(persisted, r.runId)).toEqual(r.state);
        const rows = await db.query<{ status: string }>('SELECT status FROM investigation_runs WHERE run_id = $1', [r.runId]);
        expect(rows[0]?.status).toBe('completed');
      }
    } finally {
      for (const id of runIds) {
        for (const t of ['investigation_events', 'evidence_records', 'tool_attempts', 'investigation_runs']) await db.query(`DELETE FROM ${t} WHERE run_id = $1`, [id]);
      }
      await db.close();
    }
  }, 180_000);
});
