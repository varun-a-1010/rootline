import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectRoot } from '../src/util/paths.js';

/**
 * Evaluation isolation (brief §13): nothing under src/ may import scenarios/ or eval/, and
 * src/ must not contain world ids or scenario keys (no hardcoded answers).
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('evaluation isolation', () => {
  const root = projectRoot();
  const srcFiles = walk(join(root, 'src')).filter((f) => /\.(ts|md|sql)$/.test(f));

  it('no file under src/ imports scenarios/ or eval/', () => {
    const offenders: string[] = [];
    for (const f of srcFiles.filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) continue;
        const target = relative(root, resolve(dirname(f), spec));
        if (target.startsWith('scenarios') || target.startsWith('eval')) offenders.push(`${relative(root, f)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/ contains no world ids or scenario keys', () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const text = readFileSync(f, 'utf8');
      if (/\bw_[0-9a-f]{8}\b/.test(text)) offenders.push(`${relative(root, f)}: world id`);
      if (/\bs\d{2}-[AB]\b/.test(text)) offenders.push(`${relative(root, f)}: scenario key`);
    }
    expect(offenders).toEqual([]);
  });
});
