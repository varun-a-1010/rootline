-- Rootline schema (the one schema). Applied by the app on PGlite; on a DATABASE_URL database
-- (Deltabase) the structure is applied through the Deltabase schema workflow instead.

-- ---------------------------------------------------------------- world tables (synthetic data)
CREATE TABLE IF NOT EXISTS worlds (
  world_id       text PRIMARY KEY,
  data_from      timestamptz NOT NULL,
  data_to        timestamptz NOT NULL,
  high_res_from  timestamptz NOT NULL,
  generator      text NOT NULL,
  fixture_hash   text NOT NULL,
  loaded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_reports (
  world_id     text PRIMARY KEY,
  incident_id  text NOT NULL UNIQUE,
  title        text NOT NULL,
  reported_at  timestamptz NOT NULL,
  body         jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  world_id    text NOT NULL,
  service_id  text NOT NULL,
  kind        text NOT NULL,
  body        jsonb NOT NULL,
  PRIMARY KEY (world_id, service_id)
);

CREATE TABLE IF NOT EXISTS service_dependencies (
  world_id      text NOT NULL,
  from_service  text NOT NULL,
  to_service    text NOT NULL,
  body          jsonb NOT NULL,
  PRIMARY KEY (world_id, from_service, to_service)
);

CREATE TABLE IF NOT EXISTS log_events (
  world_id          text NOT NULL,
  log_id            text NOT NULL,
  ts                timestamptz NOT NULL,
  source_timestamp  text NOT NULL,
  source_tz         text,
  service           text NOT NULL,
  severity          text NOT NULL,
  message           text NOT NULL,
  template          text NOT NULL,
  fields            jsonb NOT NULL,
  PRIMARY KEY (world_id, log_id)
);
CREATE INDEX IF NOT EXISTS log_events_lookup ON log_events (world_id, service, ts);

CREATE TABLE IF NOT EXISTS metric_points (
  world_id     text NOT NULL,
  service      text NOT NULL,
  metric       text NOT NULL,
  ts           timestamptz NOT NULL,
  value        double precision NOT NULL,
  label_key    text,
  label_value  text
);
CREATE INDEX IF NOT EXISTS metric_points_lookup ON metric_points (world_id, service, metric, ts);

CREATE TABLE IF NOT EXISTS change_events (
  world_id          text NOT NULL,
  change_id         text NOT NULL,
  ts                timestamptz NOT NULL,
  source_timestamp  text NOT NULL,
  source_tz         text,
  service           text NOT NULL,
  change_type       text NOT NULL,
  body              jsonb NOT NULL,
  PRIMARY KEY (world_id, change_id)
);
CREATE INDEX IF NOT EXISTS change_events_lookup ON change_events (world_id, ts);

CREATE TABLE IF NOT EXISTS historical_incidents (
  world_id     text NOT NULL,
  incident_id  text NOT NULL,
  opened_at    timestamptz NOT NULL,
  services     text[] NOT NULL,
  search_text  text NOT NULL,
  body         jsonb NOT NULL,
  PRIMARY KEY (world_id, incident_id)
);

-- ---------------------------------------------------------------- run tables (investigations)
CREATE TABLE IF NOT EXISTS investigation_runs (
  run_id       text PRIMARY KEY,
  world_id     text NOT NULL,
  incident_id  text NOT NULL,
  arm          text NOT NULL,
  status       text NOT NULL,
  stop_reason  text,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  meta         jsonb NOT NULL,
  report       jsonb
);

CREATE TABLE IF NOT EXISTS investigation_events (
  run_id   text NOT NULL,
  seq      integer NOT NULL,
  ts       bigint NOT NULL,
  type     text NOT NULL,
  task_id  text,
  payload  jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS evidence_records (
  run_id       text NOT NULL,
  evidence_id  text NOT NULL,
  tool         text NOT NULL,
  body         jsonb NOT NULL,
  PRIMARY KEY (run_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS tool_attempts (
  run_id      text NOT NULL,
  attempt_id  text NOT NULL,
  tool        text NOT NULL,
  attempt     integer NOT NULL,
  status      text NOT NULL,
  error_code  text,
  latency_ms  double precision NOT NULL,
  body        jsonb NOT NULL,
  PRIMARY KEY (run_id, attempt_id)
);
