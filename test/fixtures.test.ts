import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Label } from '../eval/label-schema.js';
import { readManifest } from '../src/db/bootstrap.js';
import { openDb, type Db } from '../src/db/client.js';
import { fixturesDir, readIndex } from '../src/db/fixtures.js';
import { projectRoot } from '../src/util/paths.js';
import { corpusHash, generateAll } from '../scenarios/generate.js';
import { SCENARIOS } from '../scenarios/index.js';
import { reviewWorlds, type ReviewRow } from '../scenarios/review.js';

describe('synthetic corpus', () => {
  it('regenerates byte-for-byte (manifest hashes over uncompressed content)', () => {
    const manifest = readManifest()!;
    const worlds = generateAll();
    expect(worlds).toHaveLength(28);
    for (const w of worlds) expect(w.worldSha, w.key).toBe(manifest.worlds[w.worldId]?.sha256);
    expect(corpusHash(manifest.worlds)).toBe(manifest.corpusSha256);
  });

  it('index, labels and manifest agree; 14 scenarios x 2 variants; dev split is s01 s02 s04 s06 s12 s13 (A)', () => {
    const index = readIndex();
    const manifest = readManifest()!;
    expect(index.worlds).toHaveLength(28);
    for (const w of index.worlds) {
      expect(manifest.worlds[w.worldId]).toBeDefined();
      const label = Label.parse(JSON.parse(readFileSync(join(projectRoot(), 'eval', 'labels', `${w.key}.json`), 'utf8')));
      expect(label.worldId).toBe(w.worldId);
      expect(label.split).toBe(w.split);
      if (label.expectedOutcome === 'conclusive') expect(label.acceptableCauses.length).toBeGreaterThan(0);
      else expect(label.candidateCauses.length).toBeGreaterThanOrEqual(2);
    }
    expect(index.worlds.filter((w) => w.split === 'dev').map((w) => w.key).sort()).toEqual(['s01-A', 's02-A', 's04-A', 's06-A', 's12-A', 's13-A']);
  });

  it('agent-visible fixture files carry no evaluator content (keys, slugs, label text)', () => {
    const index = readIndex();
    const slugs = SCENARIOS.map((s) => s.slug);
    for (const w of index.worlds) {
      const dir = join(fixturesDir(), w.worldId);
      const text = [
        readFileSync(join(dir, 'world.json'), 'utf8'),
        gunzipSync(readFileSync(join(dir, 'logs.jsonl.gz'))).toString('utf8'),
      ].join('\n');
      expect(text, w.key).not.toMatch(/\bs\d{2}-[AB]\b/);
      for (const slug of slugs) expect(text.includes(slug), `${w.key} contains slug ${slug}`).toBe(false);
      expect(/red herring|\btrap\b|root cause:/i.test(text.replace(/"rootCause":/g, '')), w.key).toBe(false);
      const label = JSON.parse(readFileSync(join(projectRoot(), 'eval', 'labels', `${w.key}.json`), 'utf8')) as Label;
      for (const c of label.acceptableCauses) expect(text.includes(c.mechanism), w.key).toBe(false);
    }
  });
});

describe('evidence sufficiency (every labeled answer is reachable through the tools)', () => {
  let db: Db;
  let rows: ReviewRow[];
  beforeAll(async () => {
    db = await openDb();
    rows = await reviewWorlds(db);
  }, 180_000);
  afterAll(async () => {
    await db.close();
  });

  it('every required piece of evidence comes back (faults off), matching its expected content', () => {
    const required = rows.filter((r) => r.off.status !== '-');
    expect(required.length).toBeGreaterThanOrEqual(56);
    for (const r of required) {
      expect(r.off.status, `${r.key}: ${r.evidence}`).toBe('ok');
      expect(r.off.records, `${r.key}: ${r.evidence}`).toBeGreaterThan(0);
      if (r.off.containsHit !== null) expect(r.off.containsHit, `${r.key}: ${r.evidence}`).toBe(true);
    }
  });

  it('every scripted fault actually fires as an error or partial result', () => {
    const probes = rows.filter((r) => r.off.status === '-');
    expect(probes.length).toBeGreaterThanOrEqual(8);
    for (const p of probes) expect(p.on.error !== null || p.on.status === 'partial', `${p.key}: ${p.evidence}`).toBe(true);
  });
});
