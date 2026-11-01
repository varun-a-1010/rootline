import { GetDependenciesInput } from '../contracts/tools.js';
import type { DependencyEdge } from '../contracts/world.js';
import { getDependencyEdges } from '../db/queries.js';
import { requireService } from './common.js';
import type { ToolContext, ToolDef, ToolOutput } from './types.js';

export const getDependencies: ToolDef<GetDependenciesInput> = {
  name: 'get_dependencies',
  source: 'service-catalog',
  description:
    'Walk the service dependency graph from one service: downstream (what it calls), upstream (what calls it) or both, up to 3 hops. Returns edges with kind (sync/async/datastore/cache/external_api), criticality, configured timeout and retries, plus node metadata (internal/external, tier, team).',
  input: GetDependenciesInput,

  canonicalize(input, ctx) {
    requireService(ctx, input.service);
    return { service: input.service, direction: input.direction ?? 'both', depth: input.depth ?? 1 };
  },

  async execute(ctx: ToolContext, p): Promise<ToolOutput> {
    const start = p.service as string;
    const direction = p.direction as 'downstream' | 'upstream' | 'both';
    const depth = p.depth as number;
    const edges = await getDependencyEdges(ctx.db, ctx.worldId);
    const found = new Map<string, DependencyEdge & { hop: number }>();
    const walk = (dir: 'downstream' | 'upstream') => {
      let frontier = new Set([start]);
      const seen = new Set([start]);
      for (let hop = 1; hop <= depth; hop++) {
        const next = new Set<string>();
        for (const e of edges) {
          const [a, b] = dir === 'downstream' ? [e.from, e.to] : [e.to, e.from];
          if (!frontier.has(a)) continue;
          const key = `${e.from}->${e.to}`;
          if (!found.has(key)) found.set(key, { ...e, hop });
          if (!seen.has(b)) {
            seen.add(b);
            next.add(b);
          }
        }
        frontier = next;
      }
    };
    if (direction !== 'upstream') walk('downstream');
    if (direction !== 'downstream') walk('upstream');
    const list = [...found.values()].sort((x, y) => x.hop - y.hop || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
    const nodeIds = new Set<string>([start]);
    for (const e of list) {
      nodeIds.add(e.from);
      nodeIds.add(e.to);
    }
    const nodes = [...nodeIds].sort().map((id) => {
      const s = ctx.services.get(id);
      return s ? { id, kind: s.kind, tier: s.tier, team: s.team, description: s.description } : { id, kind: 'unknown' };
    });
    return {
      records: list,
      modelRecords: list.map((e) => ({
        from: e.from,
        to: e.to,
        hop: e.hop,
        kind: e.kind,
        critical: e.critical,
        ...(e.timeoutMs !== null ? { timeout_ms: e.timeoutMs } : {}),
        ...(e.retries !== null ? { retries: e.retries } : {}),
        ...(e.notes ? { notes: e.notes } : {}),
      })),
      refs: list.map((e) => `dep:${e.from}->${e.to}`),
      services: [...nodeIds].sort(),
      window: null,
      completeness: 'complete',
      truncated: false,
      notes: [],
      summary: { nodes },
    };
  },
};
