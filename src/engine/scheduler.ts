import type { TaskSpec } from '../contracts/agents.js';

export type TaskOutcome = 'completed' | 'failed';

/**
 * A task DAG with a bounded concurrent ready set. A dependency is satisfied when its task is
 * terminal (completed or failed), so a failed specialist never blocks reasoning. Strategies
 * add tasks over time (follow-up rounds); runUntilIdle returns when nothing is pending or
 * running.
 */
export class Scheduler {
  private readonly specs = new Map<string, TaskSpec>();
  private readonly status = new Map<string, 'pending' | 'running' | TaskOutcome>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly concurrency: number,
    private readonly exec: (spec: TaskSpec) => Promise<TaskOutcome>,
    private readonly signal: AbortSignal,
  ) {}

  add(spec: TaskSpec): void {
    if (this.specs.has(spec.id)) throw new Error(`duplicate task id ${spec.id}`);
    this.specs.set(spec.id, spec);
    this.status.set(spec.id, 'pending');
  }

  outcome(id: string): 'pending' | 'running' | TaskOutcome | undefined {
    return this.status.get(id);
  }

  private ready(): TaskSpec[] {
    const out: TaskSpec[] = [];
    for (const [id, st] of this.status) {
      if (st !== 'pending') continue;
      const spec = this.specs.get(id)!;
      const depsDone = spec.dependsOn.every((d) => {
        const s = this.status.get(d);
        return s === 'completed' || s === 'failed' || s === undefined; // unknown deps never block
      });
      if (depsDone) out.push(spec);
    }
    return out;
  }

  async runUntilIdle(): Promise<void> {
    for (;;) {
      if (!this.signal.aborted) {
        for (const spec of this.ready()) {
          if (this.running.size >= this.concurrency) break;
          this.status.set(spec.id, 'running');
          const p = this.exec(spec)
            .catch((): TaskOutcome => 'failed')
            .then((o) => {
              this.status.set(spec.id, o);
              this.running.delete(spec.id);
            });
          this.running.set(spec.id, p);
        }
      }
      if (this.running.size === 0) {
        // Aborted: mark everything still pending as failed so callers see terminal states.
        if (this.signal.aborted) for (const [id, st] of this.status) if (st === 'pending') this.status.set(id, 'failed');
        return;
      }
      await Promise.race(this.running.values());
    }
  }
}
