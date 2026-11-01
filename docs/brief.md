# Rootline build brief

**Written:** 2026-11-01 · **Submission due:** 2026-11-02
**Who it's for:** the coding agent building Rootline, and any reviewer who wants to see how the work was directed.

**Precedence:** `docs/assignment.md` (the company's requirements) > this brief > `docs/spec.md`
(the original design proposal). The spec holds the full rationale; this brief holds the
decisions, the concrete contracts and the order of work. **Scope is everything.** Build all
14 scenarios, the full engine, the baseline, the evaluation, the UI and the docs. Don't
cut scope for time: an agent can do this in hours. If something truly can't be finished, it
goes in `docs/limitations.md` and is never hidden.

---

## 0. Decisions

| Topic | Decision |
| --- | --- |
| Name | **Rootline** (the investigator). The system under investigation is the fictional **Aaroh**, a financial-education assistant with chat and voice. |
| Language / runtime | TypeScript (strict, ESM) on Node ≥ 22, **npm** (what reviewers have). |
| Model | **`gemini-4-argon`** on Vertex AI, global endpoint. See §5. |
| Agent framework | **None.** A hand-written scheduler and agent loop. The assignment rejects "chained prompts", and a small explicit engine is the most legible proof of real coordination. Say why in the technical note. |
| Data | **Postgres SQL everywhere.** By default it runs on **PGlite** (`@electric-sql/pglite`, in-process). It runs on **node-postgres** against the Deltabase-hosted database when `DATABASE_URL` is set. See §4. |
| HTTP | Hono + `@hono/node-server`. Server-Sent Events (SSE) for live run events. |
| Validation | zod is the single source for every contract. JSON Schema for the model is derived from it (§5). |
| Tests | vitest. `npm test` never touches the network. |
| UI | Vite vanilla-TS app in `web/`, served by the same Node process in production. |
| Viewer | Hosted Agentflow at `https://flow.slate-app.online` (iframe + postMessage, §11). |
| Repo | `github.com/varun-a-1010/rootline`, public, trunk = `main`. |
| Hosting | `rootline.slate-app.online`. **Deployment happens in a separate session, not in the build.** The build must leave it trivial: one `npm run build`, one `npm start`, configured entirely by env. |

## 1. Requirement → artifact map (keep this true)

| Assignment item | Where it's satisfied |
| --- | --- |
| ≥5 distinct agents incl. the six named | `src/agents/*`. Each has its own input/output schema, tool allowlist and decision authority (§6). |
| Structured results, genuine collaboration | Shared event-sourced run state + evidence ledger. The critic's follow-ups become new scheduled tasks (§6). |
| Five tools, structured I/O, errors, simulated failures | `src/tools/*` + `src/tools/faults.ts` (§7) |
| Parallelism, shared state, dependencies | `src/engine/scheduler.ts` (task DAG, concurrent ready set), tested for real overlap (§13) |
| Feedback loops | critic → follow-up tasks → reasoning → critic, bounded (§6) |
| Bounded retries, limits, termination, recovery | `src/engine/budgets.ts`, tool runner retries, typed stop reasons (§6) |
| Ranked hypotheses, support/contradiction, confidence, actions, facts vs assumptions, inconclusive | report contract (§6) |
| ≥10 test incidents with misleading, conflicting and tool-failure cases | 14 scenarios (§8) |
| Single-agent baseline with the same tools | `src/baseline/` (§9) |
| Accuracy, grounding, tool calls, latency, tokens | `eval/` (§10) → `docs/evaluation.md` |
| Runnable + setup | `README.md` quickstart: clone → `npm ci` → `npm test` → `npm run investigate` |
| Architecture diagram + coordination | `docs/architecture.md` (Mermaid) |
| Dataset + automated tests | `fixtures/`, `scenarios/`, `test/` |
| Technical note ≤500 words | `docs/technical-note.md` (check with `wc -w`) |
| Coding-assistant transcript | `docs/transcript/` (§14) |
| Document incomplete functionality and external dependencies | `docs/limitations.md` + README "External dependencies" |
| No hardcoded answers | import-boundary test + no scenario/world IDs in `src/` (§13) |

## 2. Repository layout

```
src/
  config.ts                 env parsing (zod), defaults, budgets
  contracts/                zod: incident, tool I/O, evidence, task, hypothesis, critic, report, events, run state
  db/                       client.ts (PGlite | pg), schema.sql, queries.ts (fixed parameterised queries), load.ts
  tools/                    query-logs.ts, query-metrics.ts, get-changes.ts, get-dependencies.ts,
                            search-incidents.ts, registry.ts, runner.ts (deadline/retry/attempt records), faults.ts
  llm/                      provider.ts (interface), vertex-gemini.ts, scripted.ts (test double),
                            schema.ts (zod → Gemini schema), usage.ts, pricing.ts
  engine/                   events.ts, run-state.ts (reducer), scheduler.ts, budgets.ts, ledger.ts,
                            citations.ts, persistence.ts, run.ts (entry point for both modes)
  agents/                   orchestrator.ts, observability.ts, dependency.ts, reasoning.ts, critic.ts,
                            reporting.ts, specialist-loop.ts, critic-checks.ts, prompts/*.md, objective.md
  baseline/                 single-agent.ts
  server/                   app.ts, routes/*.ts, sse.ts, limits.ts, static.ts
  cli/                      investigate.ts, fixtures.ts, eval.ts
scenarios/                  generator inputs (they encode the mechanisms, so they're agent-invisible)
  _lib/                     seeded RNG, series/noise helpers, log templates, world builder
  s01-stale-financial-data.ts … s14-conflicting-evidence.ts
fixtures/v1/                generated corpus (+ manifest.json with hashes) — the downloadable dataset
eval/
  labels/                   answer keys (never imported by src/, never loaded into any DB)
  rubric.md, judge-prompt.md
  runner.ts, score.ts, judge.ts, summarize.ts
  runs/                     every eval run's full event log + report (committed)
  results/                  summary.json + summary.md (committed, generated)
web/                        Vite vanilla-TS UI
test/                       vitest
docs/                       assignment.md, spec.md, brief.md, architecture.md, evaluation.md,
                            technical-note.md, limitations.md, scenarios.md, transcript/
```

## 3. Synthetic world and fixtures

- **One fictional product, Aaroh**, with the service catalog from spec §3 (`chat-gateway`,
  `voice-gateway`, `speech-provider`, `assistant-orchestrator`, `llm-provider`,
  `financial-data-service`, `market-data-provider`, `education-retrieval`, `indexing-pipeline`,
  `user-context-service`, `cache`, `database`). Add more only if a scenario needs them. Every
  world shares the catalog; dependency metadata may differ per world.
- **One world per scenario variant.** A world is a self-contained partition: an opaque ID
  (`w_` + 8 hex chars from a salted hash, revealing nothing about the scenario), a 3–4 hour
  incident window, background data for every service, and ~60 days of historical incidents. A
  run is bound to one world by the server/CLI. **Agents never name or see a world ID. The
  tool layer injects it.**
- **Realism is the whole game.** Every world has:
  - Per-minute metrics for every service (`request_rate`, `error_rate`, `latency_p50_ms`,
    `latency_p95_ms`, plus service-specific ones such as `cache_hit_rate`,
    `data_freshness_s`, `index_version`, `missing_context_rate`, `rate_limited_count`,
    `retry_count`, `session_failures`). Use a diurnal shape plus noise.
  - Background logs: INFO/WARN chatter and a 1–3% rate of irrelevant errors, with structured
    fields (`trace_id`, `route`, `status`, `latency_ms`, `provider`, `region`, `version`).
  - Routine deploys and config changes that have nothing to do with the incident, on top of each
    scenario's scripted red herrings.
  - Volume high enough that "fetch everything" hits page limits (a few thousand log lines per
    world), so targeted querying matters and truncation is real.
- **The mechanism lives only in the data**: metric deltas, log lines, change events, dependency
  edges and historical incidents. The **incident report** is what an on-call person or support
  agent would file: symptoms, user impact, affected surface, approximate start, an
  investigation window. It never states or implies the cause.
- **Timestamps** are ISO-8601 UTC with an explicit offset. Exception: in scenario 11 one
  source emits local time with a wrong or missing offset. Tools return what the source says
  (`source_timestamp`, `source_tz`) and never silently normalize it.
- **Determinism.** A seeded PRNG drives everything. `npm run fixtures:generate` reproduces the
  corpus byte-for-byte. `fixtures/v1/manifest.json` records a sha256 per file and for the
  whole corpus. A test regenerates the corpus and compares hashes.
- **Variants.** Every scenario has an **A** variant and a held-out **B** variant. B uses a
  different seed, different times and magnitudes, a different set of red herrings and noise,
  and the same mechanism class. B must differ in more than names (spec §9).
- **Distribution.** Commit the generated corpus as gzipped JSONL if the whole corpus is
  ≤ 25 MB; otherwise commit the generator and manifest and attach the corpus to a GitHub release.
  The server exposes `GET /downloads/fixtures-v1.zip`. Labels and fault profiles are
  downloadable too, clearly marked as evaluator-only (spec §8: separation is an access
  control on the tool surface, not secrecy).

## 4. Database

- `src/db/schema.sql` is the one schema. World tables: `worlds`, `incident_reports`,
  `services`, `service_dependencies`, `log_events`, `metric_points`, `change_events`,
  `historical_incidents`. Run tables: `investigation_runs`, `investigation_events`,
  `evidence_records`, `tool_attempts`. Index for the access patterns (`world_id, service, ts`).
- **Local and test default:** PGlite. Use in-memory for tests and file-backed `.data/pglite` for
  the dev server. Apply the schema at boot and load fixtures if the database is empty. Tests
  load only the worlds they need.
- **Hosted:** a `pg` Pool when `DATABASE_URL` is set. On Deltabase **the schema is owned by
  Deltabase**: apply `schema.sql`'s structure through the Deltabase schema workflow (MCP
  preview → apply with the exact plan hash → read back). The app never runs DDL against a
  `DATABASE_URL` database. `npm run fixtures:load` inserts data through `DATABASE_URL`.
  Private setup status is in `CLAUDE.local.md`. If Deltabase isn't ready, finish everything on
  PGlite; the Deltabase leg is small.
- The data layer exposes **fixed parameterized queries only**. No agent ever supplies SQL.
  Every query is scoped to the run's world.

## 5. Model layer — `gemini-4-argon` on Vertex AI

- **Endpoint:** `POST https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/global/publishers/google/models/gemini-4-argon:generateContent`.
  Probed 2026-11-01: HTTP 200, schema-valid JSON, `usageMetadata` present, ~5 s for a
  small low-thinking call.
- **Auth:** `google-auth-library`. Use `VERTEX_SERVICE_ACCOUNT_B64` (base64 of the service-account
  JSON) if set, otherwise Application Default Credentials, so reviewers can run
  `gcloud auth application-default login`. Env: `VERTEX_PROJECT_ID`, `VERTEX_LOCATION=global`,
  `ROOTLINE_MODEL=gemini-4-argon`.
- **The Argon contract (learned in production use; follow it exactly):**
  1. **No `temperature`, `top_p`, `top_k`, `candidate_count` or seed.** Control reasoning
     with `generation_config.thinking_config.thinking_level` ∈ `low | medium | high`. Outputs
     are therefore not seedable: repeated runs measure variance (say so in the evaluation).
  2. `max_output_tokens` ≤ **32768** on non-streaming calls. Thinking and answer share it.
  3. **Structured output:** `response_mime_type: application/json` + `response_schema`
     (OpenAPI-3.0 subset: `OBJECT/ARRAY/STRING/NUMBER/INTEGER/BOOLEAN`, `properties`,
     `required`, `items`, `enum`, `nullable`). Write a small zod → Gemini-schema converter
     for that subset. **Always re-validate with zod.** On failure, make one repair call that
     includes the validation error, then fail the agent task with a typed error.
  4. **Function calling** (specialist loops and the baseline): declare tools as
     `functionDeclarations`. To continue a turn, append the model's `content.parts`
     **verbatim**, including `functionCall` IDs and `thoughtSignature` fields, then the
     `functionResponse` parts. Dropping them breaks continuation. Don't mix
     `response_schema` with tools. A tool loop ends when the model calls a terminal function
     (`submit_findings` / `submit_report`) whose parameters are the output schema.
  5. **Usage:** record `promptTokenCount` (input), `candidatesTokenCount` (output),
     `thoughtsTokenCount` (reasoning, billed as output) and `cachedContentTokenCount` raw, per
     call and per role. Billed output = candidates + thoughts. **Missing usage is `null`
     (unknown), never 0.**
  6. Drop parts with `thought: true` from answer text.
  7. **Errors:** for 429 `RESOURCE_EXHAUSTED` and 5xx, retry with bounded exponential backoff
     (max 3 attempts), recording every attempt as an event. Never retry a 400. The Vertex
     project is shared with a live product that also uses Argon, so **eval concurrency defaults
     to 2 runs** (`ROOTLINE_EVAL_CONCURRENCY`).
- **Thinking level:** the same level for every role **and** the baseline (default `medium`), so
  the comparison is fair. Record any per-role override in the run metadata.
- **Cost estimates** (`src/llm/pricing.ts`): $2 / M input, $10 / M output including thinking,
  $0.10 / M cached input until 2026-11-30 (promotional); list price $4 / $20 / $0.20 after
  that. Check against Google's pricing page before quoting cost in docs. Report tokens as the
  primary measure; cost is an estimate with the rate table stated.
- **`ScriptedProvider`:** a deterministic test double that plays back canned function calls and
  JSON per role and step. Every deterministic test uses it, so the engine is fully testable
  offline.

## 6. Engine and agents

### Run state is event-sourced
Every change is a typed event: `run.created`, `plan.proposed`, `plan.validated`, `plan.fallback`,
`task.scheduled`, `task.started`, `llm.call`, `tool.attempt`, `evidence.recorded`, `citation.invalid`,
`agent.output`, `task.completed`, `task.failed`, `hypotheses.updated`, `critic.checks`,
`critic.decided`, `followup.scheduled`, `followup.rejected`, `budget.exhausted`, `report.ready`,
`run.terminated`, and so on. Each event has `seq`, `ts` (ms), `runId`, `type`, optional `taskId`
and a zod-validated `payload`. `RunState = fold(events)`. The same log drives persistence, live
SSE, replay, the Agentflow mapping and eval scoring. **Nothing is displayed that isn't in the
log.**

### Scheduler
- A task DAG: `{id, role, question, scope{services, window}, dependsOn[], round, status, attempts}`.
  Ready tasks run **concurrently** in a bounded pool (`ROOTLINE_TASK_CONCURRENCY`, default 4).
- A dependency is satisfied when its task is terminal (`completed` or `failed`). Reasoning
  tolerates failed specialists and works from what exists, with the gaps listed.
- Flow: R0 plan → specialists (parallel) → reasoning → critic → [critic says `investigate` →
  follow-up specialists (parallel) → reasoning v(n+1) → critic]* → reporting.
- **Termination is decided in code**, with a typed `stopReason`:
  `critic_accepted | critic_insufficient_evidence | max_rounds | no_new_evidence |
  budget_tool_calls | budget_llm_calls | budget_tokens | deadline | cancelled | unrecoverable_error`.
  Defaults: 3 critique rounds, 40 tool calls, 30 LLM calls, a token ceiling, a 6-minute deadline.
  All configurable, all checked **before** each call, and the remaining budget is visible to
  the orchestrator and the critic.

### Orchestrator (hybrid: the model plans, code governs)
- The model step takes the incident, service catalog, dependency summary and budget, and
  returns a plan: 2–6 tasks, each with a role ∈ {observability, dependency}, a question,
  services, a window and the rationale ("what this establishes").
- Code validates the plan: known services, a window inside the incident window ± 6 h, at least
  one observability and one dependency task, deduplication. If invalid, one repair call; if
  still invalid, a code default plan (one task of each role over the affected services),
  recorded as `plan.fallback`.
- Follow-ups: code turns the critic's requests into tasks. It checks the role ↔ tool
  authorization, the budget, **novelty** (a fingerprint of canonical tool params already
  executed; repeats are rejected with a reason) and caps follow-ups at 4 per round.
  Rejections are events.

### Specialists — observability (`query_logs`, `query_metrics`) and dependency (`get_changes`, `get_dependencies`, `search_incidents`)
- A bounded tool loop (default 8 tool calls per task) using only the role's tools. It ends with
  `submit_findings`: `observations[{statement, kind: fact|inference, evidenceIds}]`,
  `gaps[{description, cause: tool_error|partial|no_data|out_of_budget}]`, `suggestedNextQueries`.
- The model sees tool results as compact records tagged with **evidence IDs minted by the tool
  runner**, never by the model.

### Evidence ledger and citations
- Every tool attempt becomes a `tool_attempts` row (canonical params, attempt number, status,
  latency, error). Every ok or partial result becomes one evidence record:
  `ev_<n>` (stable within the run), tool, source record refs (log IDs, metric series keys),
  service, observation window, retrieval time, completeness, a bounded excerpt and the filters
  applied. **An empty complete result is evidence too** (a negative observation). Errors are
  gaps, not evidence.
- Every agent output's evidence IDs are checked against the run ledger. An unknown ID raises a
  `citation.invalid` event and marks the claim ungrounded (feeds the grounding metric). Model
  text never becomes evidence.
- Claims carry `kind: fact | inference | assumption`. Facts must cite evidence; assumptions
  must not pretend to.

### Reasoning
Input: incident, ledger digest, specialist observations and gaps, previous hypotheses, the
critic's objections. Output: versioned hypotheses (spec §6): `id`, `rank`, `cause`,
`component` (service ID), `causeType` (taxonomy in §8), `confidence` 0–1 with a rationale,
`supportingEvidence`, `contradictingEvidence`, `assumptions`, `missingEvidence`,
`discriminatingChecks`.

### Critic (deterministic checks + model judgment)
- First, `critic-checks.ts` runs **code checks** and passes the results to the model:
  - citation validity
  - chronology (the hypothesized cause starts after the symptom → flag)
  - confidence ≥ 0.8 while relying on partial evidence or on tools that failed → flag
  - no contradicting evidence considered while the ledger holds any → flag
  - a top-two confidence gap < 0.1 → flag
- Model output: `decision: accept | investigate | insufficient_evidence`, a `rationale`,
  `objections[{hypothesisId, type: unsupported_claim|chronology|alternative_unexplored|
  missing_data|overconfidence|counterevidence_ignored, detail, evidenceIds}]`, and
  `followUps[{role, tool, params, purpose, discriminates: hypothesisId[]}]`.
- Code validates the decision. `investigate` with no valid, novel follow-up becomes
  `no_new_evidence` termination.

### Reporting
- A structured report plus a Markdown rendering: `outcome: conclusive | inconclusive | failed`;
  incident summary; ranked hypotheses with support and counterevidence; facts / inferences /
  assumptions; timeline; confidence and gaps; recommended actions, each with a verification
  step and phrased as recommendations (never as executed); tool failures; stop reason; and
  every cited evidence ID.
- **Code-enforced honesty:** if the critic's last decision was `insufficient_evidence`, or the
  run stopped on budget/deadline without critic acceptance, the outcome can't be `conclusive`
  unless the report explicitly justifies it, and the inconsistency is flagged in the metadata.
  All citations are validated.

### Failure handling (write a test for each)
- Tool: per-tool deadline. Only retryable errors are retried (timeout, unavailable,
  rate_limited), max 2 retries with backoff, and every attempt is recorded. Partial results
  are passed through with `completeness: partial`.
- Agent: invalid output → one repair call → task failed + gap. A failed specialist doesn't
  block reasoning. If reasoning fails twice, the outcome is `failed`, with a partial report
  built from the ledger by code (clearly labeled).
- LLM: 429/5xx backoff (§5). Budget exhaustion goes to reporting with whatever exists.
- Cancellation: an `AbortController` per run, honored by tools and LLM calls.

## 7. Tools

Contracts follow spec §7. Shared response envelope:

```ts
{
  status: 'ok' | 'partial' | 'error',
  tool: string,
  request: object,                 // canonicalized echo
  source: string,                  // e.g. "logs-store", "deploy-history"
  window?: { from: string; to: string },
  records: unknown[],
  completeness: 'complete' | 'partial' | 'unknown',
  coverage?: { requested: string; returned: string; fraction?: number },
  truncated: boolean,
  nextCursor?: string,
  error?: { code: 'timeout' | 'unavailable' | 'invalid_input' | 'rate_limited'; retryable: boolean; message: string },
  evidenceId?: string
}
```

- Limits: at most 100 log records per page with cursor pagination. Metric queries are capped
  (e.g. 360 points) with a `resolution` parameter for downsampling. Logs filter by severity,
  text contains, and structured-field equality. Invalid input returns
  `error.invalid_input` with a useful message (the agent can fix it and retry).
- **Fault injection** (`src/tools/faults.ts`) applies at the tool boundary from each world's
  fault profile (`fixtures/v1/<world>/faults.json`). It's loaded only by the fault layer and
  never returned to agents. The rules match `{tool, predicate on canonical params, attempts}`
  and produce `timeout | error(code) | partial(dropFraction | truncateWindow) | latencyMs`.
  Background transient faults use `hash(worldSeed, tool, canonicalParams, attempt) < p`. Because
  matching is on logical request and attempt number, never on call order, **the same faults
  hit both modes.**
- Simulated latency is small (50–400 ms). Timeouts really elapse at the per-tool deadline
  (default 1500 ms), so latency numbers are honest.

## 8. Scenarios

Build all 14 from spec §9. For each one, `scenarios/sNN-*.ts` defines the services involved, the
window, the causal mechanism and its signals, the scripted red herrings, the history and the
fault profile, and writes the incident report text. `eval/labels/sNN.json` holds:

```json
{
  "scenario": "s01",
  "expectedOutcome": "conclusive",
  "acceptableCauses": [{ "component": "financial-data-service", "causeType": "cache_or_staleness",
                         "mechanism": "scheduled cache refresh job failing since 09:52" }],
  "partialCredit": [],
  "requiredEvidence": [{ "description": "refresh job failure logs", "match": { "tool": "query_logs", "service": "financial-data-service" } }],
  "keyCounterevidence": ["assistant-orchestrator deploy at 10:04 is after staleness began"],
  "redHerrings": ["assistant-orchestrator deploy 10:04"],
  "notes": "…"
}
```

- **Cause taxonomy** (generic, scenario-independent, used by both modes):
  `deployment_regression, config_change, upstream_dependency_degradation, rate_limiting_or_quota,
  capacity_saturation, cache_or_staleness, data_pipeline_failure, retry_or_idempotency_bug,
  clock_or_timestamp_skew, infrastructure_failure, unknown`.
- Multi-cause scenarios (e.g. 05) list every acceptable cause and the partial-credit rule
  **before** any eval run.
- Inconclusive scenarios (12, 14) have `expectedOutcome: inconclusive`. A definite diagnosis
  there is scored as an unsupported definitive diagnosis.
- Scenario 13 is conclusive only if the agents retry or use alternative data; the report must
  disclose the remaining coverage gap.
- **Evidence-sufficiency review:** for each scenario, query the tools yourself (the CLI
  `npm run tool -- …` is fine) and record in `docs/scenarios.md` that the labeled answer
  really follows from tool-reachable evidence, and that the red herrings really are plausible.
  It's agent-reviewed, not human-reviewed, so say so in limitations.
- **Dev / held-out split:** dev = s01, s02, s04, s06, s12, s13 (variant A) may be used to
  iterate prompts. Before the first held-out run, **freeze prompts** and record their hash in
  `eval/results`. Held-out = the other eight scenarios, plus every B variant. If prompts
  change after the freeze, rerun everything and say so.

## 9. Single-agent baseline

One agent with **all five tools**, one tool loop and the **same objective text**
(`src/agents/objective.md`, shared). It ends with `submit_report` using the **same report
schema**, so scoring is identical. It has the same budgets (tool calls, LLM calls, tokens,
deadline), the same thinking level, and the same tool runner, ledger and fault injection, so
evidence IDs and grounding are comparable. It runs sequentially: document that difference.
It is *not* one-shot; it may iterate until done or out of budget.

## 10. Evaluation

- **Matrix:** 14 scenarios × variant A × 2 modes × **3 repetitions**, plus 14 × variant B ×
  2 modes × 1 repetition, for 112 runs. First measure the cost per run on dev smoke runs, then
  confirm the total fits `ROOTLINE_EVAL_MAX_USD` (default 150). If not, cut B-variant
  repetitions before anything else, and say so.
- **Runner** (`npm run eval`): resumable (skips run files that already exist), concurrency
  ≤ 2, records the fixture hash, prompt hash, model ID and `modelVersion` from responses,
  thinking level, budgets, git SHA and machine info. Every run artifact goes to
  `eval/runs/<scenario>-<variant>-<mode>-r<k>.json` (events + report + metrics). Crashed
  runs are recorded as failed and never silently rerun.
- **Scoring** (`eval/rubric.md`, frozen before held-out runs):
  - *Root cause (deterministic):* does the top hypothesis's `(component, causeType)` match an
    acceptable cause? Report correct/total on conclusive cases, apply partial credit as
    labeled, and show the top-2 hit rate as a supplementary number.
  - *Mechanism agreement (LLM judge):* `eval/judge.ts` uses `gemini-4-argon` with
    `eval/judge-prompt.md`. The judge is **blind to mode**. Report agreement with the
    deterministic score and print disagreements.
  - *Inconclusive handling:* correct abstentions, unsupported definitive diagnoses and false
    abstentions.
  - *Grounding:* the fabricated-citation rate (deterministic). Claim support (judge: does the
    cited evidence excerpt entail the claim?) as supported / assessed. Required-evidence recall
    (labels). Key counterevidence addressed (judge).
  - *Tool calls:* calls, attempts, retries, failures and partials, per run and aggregated.
  - *Latency:* wall clock from start to report, plus per-stage timing from events.
  - *Tokens:* input / output / thinking / cached by role and run, with unknowns shown as unknown.
  - *Supplementary:* confidence vs correctness (exploratory, no calibration claim), critic
    follow-up rate, recovery from faults, tool completeness.
- **Outputs:** `eval/results/summary.json` + `summary.md` (per-case table, aggregates,
  mean ± range across repetitions, environment). `docs/evaluation.md` explains the method and
  embeds those numbers. **Never hand-edit results, and never claim multi-agent wins unless
  the numbers show it.**
- `npm run eval:smoke` runs one dev scenario in both modes as a quick live check. It isn't part
  of `npm test`.

## 11. UI and Agentflow

**Pages** (served at `/`): the incident list, labeled "synthetic data", with a mode toggle
(multi-agent / single-agent) and a start button. A run view with the Agentflow panel, an
event timeline, the evidence ledger (filterable; shows partial, error and retry), hypotheses
by version, critic decisions with follow-ups (accepted and rejected), and the final report with
clickable citations → evidence. Run metadata (tokens, calls, latency, stop reason). An
evaluation page rendering `eval/results`. A browser for recorded eval runs. Downloads and
links to the docs. Plain and clean; no polish needed.

**Agentflow embed contract (viewer v1.1.0):**
- iframe `ROOTLINE_FLOW_VIEWER_URL` (default `https://flow.slate-app.online`). Accept messages
  only where `event.origin` equals the viewer origin. Wait for `{type:'flow:ready', version}`;
  anything sent before it is lost.
- `flow:init {title, subtitle}`, then `flow:sync {nodes: FlowNode[]}` with the **whole node array
  on every update**, parents before children. Nodes are never removed.
  `FlowNode = {id, parentId|null, alsoFedBy?: string[], label, phase, status?: 'active'|'ok'|'findings'|'failed', caption?}`.
  Exactly one root (`parentId: null`).
- `flow:terminal {status: 'ok'|'failed', summary}` when the run ends.
- For finished runs (since 1.1.0): `flow:replay {duration, nodes: TimedFlowNode[]}` with
  `TimedFlowNode = {id, parentId, alsoFedBy?, label, phase, spawn, done, verdict?, tone?, captions?: [number, string][]}`.
  Build it **only from recorded event timestamps**. If the run lasted more than 90 s, compress
  it to about 60 s and label the compression factor in the UI.
- Optional `flow:setTheme {tokens}` with `--flow-*` CSS variables. `flow:caption {id, text}` for
  streaming the current tool call.
- **Mapping** (derived only from events): root = run. Children: `plan` (orchestrator) →
  round-0 specialist tasks → `reasoning-1` (parent = one specialist, `alsoFedBy` = the rest) →
  `critic-1` → follow-up tasks (parent `critic-1`) → `reasoning-2` → … → `report`. Rounds are
  new nodes; the viewer has no cycles. Status: ok = clean return, findings = finished with
  gaps or partial evidence (or the critic asked for more), failed = failed. Caption = the
  latest tool call, e.g. `query_metrics financial-data-service latency_p95_ms`.
- The single-agent mode maps to root → `agent` → `report`, with tool calls as captions.

## 12. API, limits and production readiness

- `GET /api/incidents` · `POST /api/runs {incidentId, mode}` · `GET /api/runs/:id` ·
  `GET /api/runs/:id/events` (SSE, resumes from `?after=seq`) · `GET /api/runs` (recent) ·
  `POST /api/runs/:id/cancel` · `GET /api/eval/summary` · `GET /api/eval/runs/:file` ·
  `GET /downloads/fixtures-v1.zip` · `GET /healthz`.
- The public demo spends real model money: **live runs** are limited per IP (default 3/hour)
  and globally per day (default 40). `ROOTLINE_ACCESS_CODE`, when set, is required to start a
  run. Recorded runs and eval results are always browsable without limits. Secrets stay
  server-side only.
- Config comes from env only (`PORT`, `DATABASE_URL`, `VERTEX_*`, `ROOTLINE_*`).
  `npm run build` builds the server and web; `npm start` serves both. No dev-only paths in
  production.

## 13. Tests (deterministic, offline, `npm test`)

Tool input validation; query filtering; complete / empty / partial / error semantics;
pagination and truncation; retry limits and attempt recording; deterministic fault profiles
(same faults regardless of call order); scheduler dependencies and **real parallel overlap**
(timestamps prove the tasks overlapped); evidence provenance (IDs minted by the runner,
invalid citations caught); critic-driven follow-up creating new tasks; novelty rejection;
every termination reason; the inconclusive-honesty rule; the failed-specialist recovery path;
budget enforcement; event persistence and replay (fold of persisted events = live state);
Agentflow mapping from events; scoring stability; **evaluation isolation** (nothing under
`src/` imports `scenarios/` or `eval/`, and no label content is reachable through any tool);
fixture reproducibility (hashes). Integration: a scripted end-to-end run in both modes against
a small seeded world, asserting persisted events and the final report.

## 14. Deliverables checklist

1. `README.md`: what it is, a quickstart (no DB setup), env vars, the commands (`investigate`,
   `eval`, `eval:smoke`, `fixtures:*`, `dev`, `build`, `start`), the hosted demo link, external
   dependencies (Vertex AI / Gemini 4 Argon, hosted Agentflow viewer, optional Deltabase) and
   what the reviewer receives.
2. `docs/architecture.md`: Mermaid diagrams (components; a run's sequence with the parallel
   fan-out and the critic loop), coordination explained, the state/event model, and how
   failures are contained.
3. `fixtures/`, `scenarios/`, `docs/scenarios.md`, `test/`.
4. `eval/results/*` + `docs/evaluation.md`.
5. `docs/technical-note.md`: **≤ 500 words** (`wc -w`), written from real results only.
6. `docs/transcript/README.md`: says which sessions are included (the build sessions in this
   repo, exported by the owner with `/export`) and which are excluded and why (planning and
   deployment touched unrelated private infrastructure). The owner reviews it for secrets
   before committing.
7. `docs/limitations.md`: incomplete functionality, agent-reviewed (not human-reviewed)
   labels, synthetic data, model variance, small n, judge self-preference risk (the same model
   family judges), external dependencies.

## 15. Order of work

Commit and push after every checkpoint (small, coherent, tested slices, straight to `main`).

1. **Foundation:** scaffold, config, contracts, schema, PGlite client, fixed queries, five
   tools + runner + faults, a minimal world generator.
   ✔ Tests show complete / empty / partial / error, retries and deterministic faults.
2. **All 14 scenarios** (A + B), labels, the generator, manifest hashes, `docs/scenarios.md`
   evidence-sufficiency review.
   ✔ The reproducibility test passes, and every scenario's answer is reachable through tools.
3. **Model layer:** the Vertex provider (the full Argon contract), the scripted provider, the
   schema converter, usage.
   ✔ One live structured call and one live tool-loop call succeed.
4. **Engine + six agents** (multi-agent mode), the event log, persistence, CLI
   `npm run investigate -- --scenario s01 --mode multi`.
   ✔ A live trace shows parallel specialists, a contradiction, a critic follow-up and a new
   round. Also deterministic scripted tests for every path in §6 and §13.
5. **Baseline.** ✔ The same CLI in `--mode single` produces the same report schema.
6. **Server + UI + Agentflow mapping.** ✔ Code-level checks only (typecheck, build,
   endpoint tests with the scripted provider). **Don't open a browser.**
7. **Evaluation:** rubric + judge, dev smoke, prompt freeze, the full matrix, summary.
   ✔ `eval/results` is committed with all metrics.
8. **Docs:** README, architecture, evaluation, limitations, technical note, transcript README.
   ✔ Every number traces to `eval/results`.
9. **Deltabase leg** (if the private setup is ready): schema applied through Deltabase,
   fixtures loaded, the app runs against `DATABASE_URL`. ✔ The integration test passes
   against it.

## 16. Working rules

- **Public repo:** no secrets, no private hostnames or IPs, no details of unrelated private
  projects. Private notes live in `CLAUDE.local.md` and `DEPLOY.local.md` (gitignored).
- **The transcript is a deliverable:** keep the session on this project, and explain your
  decisions as you go. Reviewers will read it.
- **Honesty over polish:** never show progress that didn't happen, never fill missing data,
  never round results in our favor, and document every gap.
- **No browser or visual QA:** verify with typecheck, build, tests and the CLI. The owner
  checks the UI.
