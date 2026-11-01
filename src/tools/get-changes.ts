import { GetChangesInput } from '../contracts/tools.js';
import { queryChanges } from '../db/queries.js';
import { checkWindow, HOUR, validateRange, requireService, retentionNote, uniqSorted } from './common.js';
import type { ToolContext, ToolDef, ToolOutput } from './types.js';

/** Change history is retained for 10 days before the end of the world's data. */
export const CHANGE_RETENTION_MS = 10 * 24 * HOUR;

export const getChanges: ToolDef<GetChangesInput> = {
  name: 'get_changes',
  source: 'deploy-history',
  description:
    'List deployments, configuration changes, feature-flag changes, infrastructure changes, rollbacks and job-schedule changes in a time range (max 10 days), optionally for specific services and change types. Timestamps are returned as the source system recorded them.',
  input: GetChangesInput,

  canonicalize(input, ctx) {
    for (const s of input.services ?? []) requireService(ctx, s);
    return {
      services: input.services?.length ? uniqSorted(input.services) : undefined,
      ...validateRange(input.from, input.to, CHANGE_RETENTION_MS),
      change_types: input.change_types?.length ? uniqSorted(input.change_types) : undefined,
      limit: input.limit ?? 30,
    };
  },

  async execute(ctx: ToolContext, p): Promise<ToolOutput> {
    const retained = {
      from: new Date(Date.parse(ctx.world.dataTo) - CHANGE_RETENTION_MS).toISOString(),
      to: ctx.world.dataTo,
    };
    const w = checkWindow(p.from as string, p.to as string, CHANGE_RETENTION_MS, retained);
    const limit = p.limit as number;
    const rows =
      w.from === w.to
        ? []
        : await queryChanges(ctx.db, ctx.worldId, {
            services: (p.services as string[] | undefined) ?? null,
            from: w.from,
            to: w.to,
            types: (p.change_types as string[] | undefined) ?? null,
            limit,
          });
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const notes: string[] = [];
    const rn = retentionNote(w, retained);
    if (rn) notes.push(rn);
    if (more) notes.push(`more than ${limit} changes matched; narrow the range or filter by service/type.`);
    if (page.some((c) => c.sourceTz === null)) {
      notes.push('Some records come from a source that wrote timestamps without a UTC offset (tz: "none"); the change store indexed those as UTC.');
    }
    return {
      records: page,
      modelRecords: page.map((c) => ({
        id: c.id,
        t: c.sourceTimestamp,
        ...(c.sourceTz === null ? { tz: 'none' } : {}),
        svc: c.service,
        type: c.type,
        summary: c.summary,
        ...(c.versionFrom || c.versionTo ? { version: `${c.versionFrom ?? '?'} -> ${c.versionTo ?? '?'}` } : {}),
        author: c.author,
        status: c.status,
        ...(Object.keys(c.details).length ? { details: c.details } : {}),
      })),
      refs: page.map((c) => c.id),
      services: (p.services as string[] | undefined) ?? uniqSorted(page.map((c) => c.service)),
      window: { from: w.from, to: w.to },
      completeness: w.clamped ? 'partial' : 'complete',
      coverage: w.clamped
        ? { requested: `${w.requested.from}..${w.requested.to}`, returned: `${w.from}..${w.to}`, fraction: w.fraction }
        : undefined,
      truncated: more,
      notes,
    };
  },
};
