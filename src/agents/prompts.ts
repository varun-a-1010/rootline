import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../util/canonical.js';
import { projectRoot } from '../util/paths.js';

export type PromptName = 'objective' | 'orchestrator' | 'observability' | 'dependency' | 'candidates' | 'reasoning' | 'critic' | 'reporting' | 'baseline';

const dir = () => join(projectRoot(), 'src', 'agents', 'prompts');
let cache: Record<string, string> | null = null;

function all(): Record<string, string> {
  if (!cache) {
    cache = {};
    for (const f of readdirSync(dir()).filter((x) => x.endsWith('.md')).sort()) cache[f.replace(/\.md$/, '')] = readFileSync(join(dir(), f), 'utf8').trim();
  }
  return cache;
}

export function prompt(name: PromptName): string {
  const p = all()[name];
  if (!p) throw new Error(`missing prompt ${name}`);
  return p;
}

/** System prompt for a role: the shared objective plus the role prompt. */
export function systemPrompt(role: Exclude<PromptName, 'objective'>): string {
  return `${prompt('objective')}\n\n${prompt(role)}`;
}

/** Hash of every prompt file (recorded with every run; frozen before held-out evaluation). */
export function promptHash(): string {
  const p = all();
  return sha256(Object.keys(p).sort().map((k) => `${k}\n${p[k]}`).join('\n---\n')).slice(0, 16);
}
