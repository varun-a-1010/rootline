import { SearchIncidentsInput } from '../contracts/tools.js';
import { queryHistory } from '../db/queries.js';
import { toUtcIso } from '../util/canonical.js';
import { uniqSorted } from './common.js';
import { ToolInputError, type ToolContext, type ToolDef, type ToolOutput } from './types.js';

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'not', 'our', 'has', 'have', 'into', 'after', 'when']);

export function searchTerms(text: string): string[] {
  return uniqSorted(
    text
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  ).slice(0, 12);
}

export const searchIncidents: ToolDef<SearchIncidentsInput> = {
  name: 'search_incidents',
  source: 'incident-history',
  description:
    'Search past incident reports (about 60 days) by services involved and/or keywords. Results are ranked by service overlap and keyword hits and include symptoms, the recorded root cause and the resolution. A past incident is a lead, not proof about the current one.',
  input: SearchIncidentsInput,

  canonicalize(input) {
    if (!input.services?.length && !input.text) {
      throw new ToolInputError('give at least one of "services" or "text"');
    }
    return {
      services: input.services?.length ? uniqSorted(input.services) : undefined,
      text: input.text ? searchTerms(input.text).join(' ') || undefined : undefined,
      from: input.from ? toUtcIso(input.from) : undefined,
      to: input.to ? toUtcIso(input.to) : undefined,
      limit: input.limit ?? 5,
    };
  },

  async execute(ctx: ToolContext, p): Promise<ToolOutput> {
    const services = (p.services as string[] | undefined) ?? null;
    const terms = p.text ? (p.text as string).split(' ') : null;
    const rows = await queryHistory(ctx.db, ctx.worldId, {
      services,
      terms,
      from: (p.from as string | undefined) ?? null,
      to: (p.to as string | undefined) ?? null,
    });
    const scored = rows
      .map((h) => {
        const hay = [h.title, h.symptoms, h.rootCause, h.resolution, h.tags.join(' ')].join(' ').toLowerCase();
        const svc = services ? h.services.filter((s) => services.includes(s)).length : 0;
        const hits = terms ? terms.filter((t) => hay.includes(t)).length : 0;
        return { h, score: svc * 2 + hits };
      })
      .sort((a, b) => b.score - a.score || b.h.openedAt.localeCompare(a.h.openedAt));
    const limit = p.limit as number;
    const page = scored.slice(0, limit);
    return {
      records: page.map((x) => x.h),
      modelRecords: page.map(({ h, score }) => ({
        id: h.id,
        opened: h.openedAt,
        resolved: h.resolvedAt,
        sev: h.severity,
        title: h.title,
        services: h.services,
        symptoms: h.symptoms,
        root_cause: h.rootCause,
        resolution: h.resolution,
        tags: h.tags,
        match_score: score,
      })),
      refs: page.map((x) => x.h.id),
      services: services ?? [],
      window: null,
      completeness: 'complete',
      truncated: scored.length > limit,
      notes: scored.length > limit ? [`${scored.length} incidents matched; showing the top ${limit}.`] : [],
    };
  },
};
