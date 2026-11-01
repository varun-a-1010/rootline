import { z } from 'zod';
import { ChangeType, IsoTime, ServiceId, Severity } from './common.js';

/**
 * Tool inputs (agent-facing; these become function declarations) and the shared response
 * envelope (brief §7). The world id is never a parameter: the tool layer injects it.
 */

/** Structured log fields that can be filtered on or counted by. */
export const LOG_FIELDS = [
  'trace_id',
  'route',
  'status',
  'provider',
  'region',
  'version',
  'bank',
  'job',
  'endpoint',
  'error_code',
  'attempt',
  'model',
] as const;
export const LogField = z.enum(LOG_FIELDS);

export const QueryLogsInput = z.object({
  services: z.array(ServiceId).min(1).max(5).describe('Services whose logs to search (1-5).'),
  from: IsoTime.describe('Start of the time range (inclusive), ISO-8601 with offset.'),
  to: IsoTime.describe('End of the time range (exclusive), ISO-8601 with offset.'),
  severity: z.array(Severity).max(5).optional().describe('Only these severities.'),
  contains: z.string().min(2).max(200).optional().describe('Case-insensitive substring the message must contain.'),
  where: z
    .array(z.object({ field: LogField, value: z.string().max(200) }))
    .max(3)
    .optional()
    .describe('Structured-field equality filters (all must match).'),
  count_by: z
    .enum(['severity', 'service', 'message', ...LOG_FIELDS])
    .optional()
    .describe(
      'If set, return counts of matching lines grouped by this attribute (top 25) instead of the lines. "message" groups by message template (numbers and ids masked).',
    ),
  limit: z.number().int().min(1).max(100).optional().describe('Page size, max 100 (default 50).'),
  order: z.enum(['asc', 'desc']).optional().describe('Time order (default asc).'),
  cursor: z.string().max(200).optional().describe('nextCursor from a previous page of the same query.'),
});
export type QueryLogsInput = z.infer<typeof QueryLogsInput>;

export const Resolution = z.enum(['1m', '5m', '15m', '1h']);
export const QueryMetricsInput = z.object({
  service: ServiceId.describe('Service that owns the metric.'),
  metric: z.string().min(2).max(60).describe('Metric name, e.g. error_rate. Unknown names return the available list.'),
  from: IsoTime.describe('Start of the time range (inclusive).'),
  to: IsoTime.describe('End of the time range (exclusive).'),
  resolution: Resolution.optional().describe('Bucket size. Default: the finest that keeps the series within 120 points. At most 360 points per series.'),
  aggregation: z.enum(['avg', 'min', 'max']).optional().describe('How points are combined within a bucket (default avg). Count metrics are per-minute rates.'),
  group_by: z.string().max(40).optional().describe('Label to split the series by (e.g. bank, route). Without it you get the overall series.'),
});
export type QueryMetricsInput = z.infer<typeof QueryMetricsInput>;

export const GetChangesInput = z.object({
  services: z.array(ServiceId).max(10).optional().describe('Only changes to these services (default: all).'),
  from: IsoTime.describe('Start of the time range (inclusive).'),
  to: IsoTime.describe('End of the time range (exclusive).'),
  change_types: z.array(ChangeType).max(6).optional().describe('Only these change types.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max records (default 30).'),
});
export type GetChangesInput = z.infer<typeof GetChangesInput>;

export const GetDependenciesInput = z.object({
  service: ServiceId.describe('Service to start from.'),
  direction: z.enum(['downstream', 'upstream', 'both']).optional().describe('downstream = what it calls; upstream = what calls it (default both).'),
  depth: z.number().int().min(1).max(3).optional().describe('Hops to follow (default 1).'),
});
export type GetDependenciesInput = z.infer<typeof GetDependenciesInput>;

export const SearchIncidentsInput = z.object({
  services: z.array(ServiceId).max(10).optional().describe('Past incidents involving any of these services.'),
  text: z.string().min(2).max(200).optional().describe('Keywords matched against titles, symptoms, causes and tags.'),
  from: IsoTime.optional().describe('Only incidents opened after this time.'),
  to: IsoTime.optional().describe('Only incidents opened before this time.'),
  limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5).'),
});
export type SearchIncidentsInput = z.infer<typeof SearchIncidentsInput>;

export const TOOL_NAMES = ['query_logs', 'query_metrics', 'get_changes', 'get_dependencies', 'search_incidents'] as const;
export const ToolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolName>;

export const ToolErrorCode = z.enum(['timeout', 'unavailable', 'invalid_input', 'rate_limited']);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const ToolError = z.object({
  code: ToolErrorCode,
  retryable: z.boolean(),
  message: z.string(),
});
export type ToolError = z.infer<typeof ToolError>;

export const Completeness = z.enum(['complete', 'partial', 'unknown']);
export type Completeness = z.infer<typeof Completeness>;

export const ToolEnvelope = z.object({
  status: z.enum(['ok', 'partial', 'error']),
  tool: z.string(),
  request: z.record(z.string(), z.unknown()),
  source: z.string(),
  window: z.object({ from: z.string(), to: z.string() }).optional(),
  records: z.array(z.unknown()),
  completeness: Completeness,
  coverage: z
    .object({ requested: z.string(), returned: z.string(), fraction: z.number().optional() })
    .optional(),
  truncated: z.boolean(),
  nextCursor: z.string().optional(),
  error: ToolError.optional(),
  evidenceId: z.string().optional(),
  /** Short human-readable caveats (retention clamp, dropped records, ...). */
  notes: z.array(z.string()).optional(),
});
export type ToolEnvelope = z.infer<typeof ToolEnvelope>;
