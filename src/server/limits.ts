/**
 * Live runs spend real model money: limit them per IP and per day. Recorded runs and eval
 * results are always browsable without limits.
 */
export class RunLimiter {
  private readonly byIp = new Map<string, number[]>();
  private day = '';
  private today = 0;

  constructor(
    private readonly perIpPerHour: number,
    private readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns null if allowed (and records the run), or the reason it is refused. */
  take(ip: string): string | null {
    const t = this.now();
    const d = new Date(t).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.today = 0;
    }
    if (this.today >= this.perDay) return `the daily limit of ${this.perDay} live runs is reached; recorded runs remain browsable`;
    const recent = (this.byIp.get(ip) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= this.perIpPerHour) return `at most ${this.perIpPerHour} live runs per hour per address`;
    recent.push(t);
    this.byIp.set(ip, recent);
    this.today += 1;
    return null;
  }
}
