import { QueryLogsInput } from '../contracts/tools.js';
import { countLogs, queryLogPage, type LogFilter } from '../db/queries.js';
import { canonicalJson, sha256 } from '../util/canonical.js';
import { checkWindow, HOUR, validateRange, requireService, retentionNote, uniqSorted } from './common.js';
import { ToolInputError, type ToolContext, type ToolDef, type ToolOutput } from './types.js';

interface Cursor {
  ts: string;
  id: string;
  q: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.ts !== 'string' || typeof c.id !== 'string' || typeof c.q !== 'string') throw new Error('shape');
    return c;
  } catch {
    throw new ToolInputError('cursor is not valid; pass nextCursor exactly as returned by the previous page');
  }
}

export const queryLogs: ToolDef<QueryLogsInput> = {
  name: 'query_logs',
  source: 'logs-store',
  description:
    'Search structured application logs for 1-5 services in a time range (max 24 h). Filter by severity, message substring and structured fields; page with nextCursor (max 100 lines per page), or set count_by to get counts grouped by severity/service/message template/field instead of lines. Timestamps are returned exactly as the source wrote them; time filters use the log store index.',
  input: QueryLogsInput,

  canonicalize(input, ctx) {
    for (const s of input.services) requireService(ctx, s);
    return {
      services: uniqSorted(input.services),
      ...validateRange(input.from, input.to, 24 * HOUR),
      severity: input.severity ? uniqSorted(input.severity) : undefined,
      contains: input.contains?.trim().toLowerCase(),
      where: input.where ? [...input.where].sort((a, b) => a.field.localeCompare(b.field)) : undefined,
      count_by: input.count_by,
      limit: input.count_by ? undefined : (input.limit ?? 50),
      order: input.count_by ? undefined : (input.order ?? 'asc'),
      cursor: input.cursor,
    };
  },

  async execute(ctx: ToolContext, p): Promise<ToolOutput> {
    const services = p.services as string[];
    const retained = { from: ctx.world.dataFrom, to: ctx.world.dataTo };
    const w = checkWindow(p.from as string, p.to as string, 24 * HOUR, retained);
    const filter: LogFilter = {
      services,
      from: w.from,
      to: w.to,
      severities: (p.severity as string[] | undefined) ?? null,
      contains: (p.contains as string | undefined) ?? null,
      where: (p.where as Array<{ field: string; value: string }> | undefined) ?? [],
    };
    const notes: string[] = [];
    const rn = retentionNote(w, retained);
    if (rn) notes.push(rn);
    const base = {
      services,
      window: { from: w.from, to: w.to },
      completeness: w.clamped ? ('partial' as const) : ('complete' as const),
      coverage: w.clamped
        ? { requested: `${w.requested.from}..${w.requested.to}`, returned: `${w.from}..${w.to}`, fraction: w.fraction }
        : undefined,
    };

    if (p.count_by) {
      const by = p.count_by as string;
      const res = w.from === w.to ? { total: 0, groups: [] } : await countLogs(ctx.db, ctx.worldId, filter, by);
      return {
        ...base,
        records: res.groups,
        modelRecords: res.groups.map((g) => ({ [by]: g.key, count: g.count, first: g.firstTs, last: g.lastTs })),
        refs: res.groups.map((g) => `logcount:${services.join('+')}:${by}=${g.key}`),
        truncated: res.groups.length >= 25,
        notes,
        summary: { total_matching_lines: res.total, groups_shown: res.groups.length },
      };
    }

    const limit = p.limit as number;
    const order = p.order as 'asc' | 'desc';
    const queryKey = sha256(canonicalJson({ ...p, cursor: undefined })).slice(0, 12);
    let after: { ts: string; id: string } | null = null;
    if (p.cursor) {
      const c = decodeCursor(p.cursor as string);
      if (c.q !== queryKey) throw new ToolInputError('cursor belongs to a different query; reuse it only with identical filters');
      after = { ts: c.ts, id: c.id };
    }
    const rows = w.from === w.to ? [] : await queryLogPage(ctx.db, ctx.worldId, filter, { limit, order, after });
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    if (page.some((r) => r.sourceTz === null)) {
      notes.push('Some records come from a source that wrote timestamps without a UTC offset (tz: "none"); the log store indexed those as UTC.');
    }
    return {
      ...base,
      records: page,
      modelRecords: page.map((r) => ({
        id: r.id,
        t: r.sourceTimestamp,
        ...(r.sourceTz === null ? { tz: 'none' } : {}),
        svc: r.service,
        sev: r.severity,
        msg: r.message,
        ...r.fields,
      })),
      refs: page.map((r) => r.id),
      truncated: more,
      nextCursor: more && last ? encodeCursor({ ts: last.ts, id: last.id, q: queryKey }) : undefined,
      notes,
    };
  },
};
