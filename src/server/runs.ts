import type { ArmId, RunEvent } from '../contracts/events.js';
import type { Db } from '../db/client.js';
import { DbRunStore, loadRunEvents } from '../engine/persistence.js';
import { newRunId, runInvestigation, type EngineSettings } from '../engine/run.js';
import { ARM_D_BASE } from '../orchestrations/jev-assisted.js';
import type { JevClient } from '../llm/jev.js';
import type { LlmProvider } from '../llm/types.js';

interface LiveRun {
  runId: string;
  events: RunEvent[];
  subscribers: Set<(e: RunEvent) => void>;
  ac: AbortController;
  done: boolean;
}

/** Starts live runs in-process and fans their events out to SSE subscribers. */
export class RunManager {
  private readonly live = new Map<string, LiveRun>();

  constructor(
    private readonly db: Db,
    private readonly providers: { llm: LlmProvider | null; jev: JevClient | null },
    private readonly settings: EngineSettings,
  ) {}

  canRun(arm: ArmId): string | null {
    if (!this.providers.llm) return 'the model provider is not configured on this server';
    if (arm === 'D' && !this.providers.jev) return 'arm D needs Jev, which is not configured on this server';
    return null;
  }

  start(worldId: string, arm: ArmId, armBase: 'A' | 'B' = ARM_D_BASE): string {
    const runId = newRunId();
    const run: LiveRun = { runId, events: [], subscribers: new Set(), ac: new AbortController(), done: false };
    this.live.set(runId, run);
    const store = new DbRunStore(this.db);
    runInvestigation({
      db: this.db,
      worldId,
      arm,
      armBase,
      llm: this.providers.llm!,
      jev: this.providers.jev,
      settings: this.settings,
      runId,
      store,
      signal: run.ac.signal,
      onEvent: (e) => {
        run.events.push(e);
        for (const s of run.subscribers) s(e);
      },
    })
      .catch((err) => console.error(`run ${runId} crashed:`, err))
      .finally(() => {
        run.done = true;
        for (const s of run.subscribers) s({ seq: -1, ts: Date.now(), runId, type: 'run.terminated', taskId: null, payload: {} } as unknown as RunEvent);
        // Keep finished runs in memory briefly for late subscribers; the database has them too.
        setTimeout(() => this.live.delete(runId), 10 * 60_000).unref();
      });
    return runId;
  }

  isLive(runId: string): boolean {
    const r = this.live.get(runId);
    return !!r && !r.done;
  }

  async events(runId: string, after = 0): Promise<RunEvent[]> {
    const r = this.live.get(runId);
    if (r) return r.events.filter((e) => e.seq > after);
    return loadRunEvents(this.db, runId, after);
  }

  subscribe(runId: string, fn: (e: RunEvent) => void): (() => void) | null {
    const r = this.live.get(runId);
    if (!r || r.done) return null;
    r.subscribers.add(fn);
    return () => r.subscribers.delete(fn);
  }

  cancel(runId: string): boolean {
    const r = this.live.get(runId);
    if (!r || r.done) return false;
    r.ac.abort();
    return true;
  }
}
