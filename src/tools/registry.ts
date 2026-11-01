import type { ToolName } from '../contracts/tools.js';
import { getServices, getWorld } from '../db/queries.js';
import type { Db } from '../db/client.js';
import { getChanges } from './get-changes.js';
import { getDependencies } from './get-dependencies.js';
import { queryLogs } from './query-logs.js';
import { queryMetrics } from './query-metrics.js';
import { searchIncidents } from './search-incidents.js';
import type { ToolContext, ToolDef } from './types.js';

export const TOOLS: Record<ToolName, ToolDef> = {
  query_logs: queryLogs,
  query_metrics: queryMetrics,
  get_changes: getChanges,
  get_dependencies: getDependencies,
  search_incidents: searchIncidents,
};

/** Which tools each role may call (code-enforced authorization). */
export const ROLE_TOOLS = {
  observability: ['query_logs', 'query_metrics'],
  dependency: ['get_changes', 'get_dependencies', 'search_incidents'],
  baseline: ['query_logs', 'query_metrics', 'get_changes', 'get_dependencies', 'search_incidents'],
} as const satisfies Record<string, readonly ToolName[]>;

export async function createToolContext(db: Db, worldId: string): Promise<ToolContext> {
  const w = await getWorld(db, worldId);
  if (!w) throw new Error(`world ${worldId} is not loaded`);
  const services = await getServices(db, worldId);
  return { db, worldId, world: w.meta, services: new Map(services.map((s) => [s.id, s])) };
}
