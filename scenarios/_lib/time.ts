/** Time helpers. Indian Standard Time is UTC+05:30 with no daylight saving. */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const IST_OFFSET_MS = 5.5 * HOUR;

/** A UTC instant from an IST calendar day ("2026-10-14") and wall-clock time ("09:15"). */
export function ist(day: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const [Y, M, D] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(Y, M - 1, D, h, m) - IST_OFFSET_MS);
}

export function addMin(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MIN);
}

/** IST wall-clock fractional hour of day (0-24) for an instant. */
export function istHour(d: Date): number {
  const ms = (d.getTime() + IST_OFFSET_MS) % DAY;
  return ms / HOUR;
}

/** Day of week in IST (0 = Sunday). */
export function istWeekday(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCDay();
}

/** "09:15 IST" */
export function fmtIst(d: Date): string {
  const w = new Date(d.getTime() + IST_OFFSET_MS);
  return `${String(w.getUTCHours()).padStart(2, '0')}:${String(w.getUTCMinutes()).padStart(2, '0')} IST`;
}

/** "14 Oct" (IST calendar day) */
export function fmtIstDay(d: Date): string {
  const w = new Date(d.getTime() + IST_OFFSET_MS);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${w.getUTCDate()} ${months[w.getUTCMonth()]}`;
}

/** ISO with an explicit +05:30 offset (a correct IST timestamp). */
export function isoIst(d: Date): string {
  const w = new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 23);
  return `${w}+05:30`;
}

/** IST wall-clock time with NO offset — what a misconfigured source writes. */
export function naiveIst(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 23);
}

/** The instant a log store gets when it reads a naive IST timestamp as UTC. */
export function naiveReadAsUtc(d: Date): Date {
  return new Date(d.getTime() + IST_OFFSET_MS);
}

export function floorMin(d: Date, stepMin = 1): Date {
  const step = stepMin * MIN;
  return new Date(Math.floor(d.getTime() / step) * step);
}
