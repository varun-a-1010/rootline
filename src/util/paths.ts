import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** The repository root (the nearest ancestor directory holding package.json). */
export function projectRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate project root');
    dir = parent;
  }
  cached = dir;
  return dir;
}
