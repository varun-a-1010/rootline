import { z } from 'zod';

/** ISO-8601 timestamp with an explicit offset (Z or ±HH:MM). Query parameters must carry one. */
export const IsoTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/,
    'must be ISO-8601 with an explicit offset, e.g. 2026-10-14T03:45:00Z or 2026-10-14T09:15:00+05:30',
  )
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a valid timestamp');
export type IsoTime = z.infer<typeof IsoTime>;

export const ServiceId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/, 'service ids are lowercase kebab-case, e.g. order-service');
export type ServiceId = z.infer<typeof ServiceId>;

export const TimeWindow = z.object({ from: IsoTime, to: IsoTime });
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Severity = z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
export type Severity = z.infer<typeof Severity>;

/** Cause taxonomy (brief §8). Generic and scenario-independent; used by every arm. */
export const CauseType = z.enum([
  'deployment_regression',
  'config_change',
  'upstream_dependency_degradation',
  'rate_limiting_or_quota',
  'capacity_saturation',
  'cache_or_staleness',
  'data_pipeline_failure',
  'retry_or_idempotency_bug',
  'clock_or_timestamp_skew',
  'infrastructure_failure',
  'unknown',
]);
export type CauseType = z.infer<typeof CauseType>;

export const ChangeType = z.enum(['deploy', 'config', 'feature_flag', 'infra', 'rollback', 'job_schedule']);
export type ChangeType = z.infer<typeof ChangeType>;
