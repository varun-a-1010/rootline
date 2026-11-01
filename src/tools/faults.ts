import type { FaultEffect, FaultMatch, FaultProfile } from '../contracts/faults.js';
import { hashUnit } from '../util/canonical.js';

/**
 * Deterministic fault injection at the tool boundary.
 *
 * A decision depends only on (profile seed, tool, canonical request, attempt number). It
 * never depends on call order or on which arm is running, so every arm meets exactly the same
 * faults for the same logical request. The profile is never visible to agents.
 */
export interface FaultDecision {
  latencyMs: number;
  effect: FaultEffect | null;
  ruleId: string | null;
}

export class FaultInjector {
  constructor(readonly profile: FaultProfile) {}

  decide(tool: string, canonical: Record<string, unknown>, fingerprint: string, attempt: number): FaultDecision {
    const { seed, latency } = this.profile;
    let latencyMs = Math.round(latency.minMs + hashUnit(seed, 'latency', tool, fingerprint, attempt) * (latency.maxMs - latency.minMs));

    for (const rule of this.profile.rules) {
      if (rule.tool !== tool) continue;
      if (rule.attempts !== 'all' && !rule.attempts.includes(attempt)) continue;
      if (!matches(rule.match, canonical)) continue;
      if (rule.effect.kind === 'latency') {
        latencyMs += rule.effect.ms;
        continue; // latency stacks with other effects
      }
      return { latencyMs, effect: rule.effect, ruleId: rule.id };
    }
    for (let i = 0; i < this.profile.transient.length; i++) {
      const t = this.profile.transient[i]!;
      if (t.tools && !t.tools.includes(tool)) continue;
      if (attempt > t.maxAttempt) continue;
      if (hashUnit(seed, 'transient', i, tool, fingerprint, attempt) < t.p) {
        if (t.effect.kind === 'latency') {
          latencyMs += t.effect.ms;
          continue;
        }
        return { latencyMs, effect: t.effect, ruleId: `transient#${i}` };
      }
    }
    return { latencyMs, effect: null, ruleId: null };
  }
}

function requestServices(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(c.services)) out.push(...(c.services as string[]));
  if (typeof c.service === 'string') out.push(c.service);
  return out;
}

export function matches(m: FaultMatch, c: Record<string, unknown>): boolean {
  if (m.servicesAny) {
    const svcs = requestServices(c);
    if (!svcs.some((s) => m.servicesAny!.includes(s))) return false;
  }
  if (m.metricsAny) {
    if (typeof c.metric !== 'string' || !m.metricsAny.includes(c.metric)) return false;
  }
  if (m.windowOverlaps) {
    if (typeof c.from !== 'string' || typeof c.to !== 'string') return false;
    const f = Date.parse(c.from);
    const t = Date.parse(c.to);
    if (!(f < Date.parse(m.windowOverlaps.to) && t > Date.parse(m.windowOverlaps.from))) return false;
  }
  if (m.textAny) {
    const text = `${typeof c.contains === 'string' ? c.contains : ''} ${typeof c.text === 'string' ? c.text : ''}`.toLowerCase();
    if (!m.textAny.some((x) => text.includes(x.toLowerCase()))) return false;
  }
  return true;
}
