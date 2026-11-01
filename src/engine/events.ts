import { EVENT_PAYLOADS, type EventPayload, type EventType, type RunEvent } from '../contracts/events.js';

export type EventListener = (e: RunEvent) => void;

/**
 * Append-only, validated event log for one run. Sequence numbers are dense from 1. Listeners
 * (persistence, SSE, Agentflow) see every event in order.
 */
export class RunLog {
  readonly events: RunEvent[] = [];
  private readonly listeners: EventListener[] = [];

  constructor(
    readonly runId: string,
    private readonly now: () => number = Date.now,
  ) {}

  on(l: EventListener): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit<T extends EventType>(type: T, payload: EventPayload<T>, taskId: string | null = null): RunEvent<T> {
    const schema = EVENT_PAYLOADS[type];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`invalid ${type} payload: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const e: RunEvent<T> = { seq: this.events.length + 1, ts: this.now(), runId: this.runId, type, taskId, payload: parsed.data as EventPayload<T> };
    this.events.push(e as RunEvent);
    for (const l of this.listeners) l(e as RunEvent);
    return e;
  }
}
