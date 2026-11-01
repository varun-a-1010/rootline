import type { Label } from '../../eval/label-schema.js';
import { WorldBuilder, type WorldOptions } from './world.js';

export type Variant = 'A' | 'B';

/** Everything in a label except what the generator fills in. */
export type LabelBody = Omit<Label, 'scenario' | 'variant' | 'key' | 'worldId' | 'split' | 'title'>;

export interface ScenarioDef {
  id: string; // "s01"
  slug: string; // "stale-nav" — evaluator-facing only; never shipped to agents
  /** Variant A of these scenarios is the dev set; every B variant is held out. */
  dev: boolean;
  build(variant: Variant): { builder: WorldBuilder; label: LabelBody };
}

export function world(id: string, variant: Variant, opts: Omit<WorldOptions, 'key' | 'seed'> & { seedSuffix?: string }): WorldBuilder {
  return new WorldBuilder({ ...opts, key: `${id}-${variant}`, seed: `rootline/${id}/${variant}/${opts.seedSuffix ?? 'v1'}` });
}

/** Indian-style grouping for rupee amounts (12,34,567), deterministic (no locale APIs). */
export function inr(n: number): string {
  const s = Math.round(n).toString();
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}
