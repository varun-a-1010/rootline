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
| Name | **Rootline** (the investigator). The system under investigation is a fictional **Indian investing app with an AI assistant built in** (§3). |
| Language / runtime | TypeScript (strict, ESM) on Node ≥ 22, **npm** (what reviewers have). |
| Model | **`gemini-3.8-flash`** on Vertex AI, global endpoint, for every agent in every orchestration and for the baseline. See §5. |
| Decision model | **Jev** (`typesafe/jev-1.13` via OpenRouter) for small typed decisions inside one orchestration, and as the evaluation judge. See §5 and §10. |
| Orchestrations | **Four multi-agent arms plus the single-agent baseline**, all with the same tools, limits, incidents, model and report format. See §6 and §9. |
| Evaluation budget | **$50** for all evaluation runs. Tokens are the reported cost measure; a dollar estimate sits beside them. See §10. |
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
| Single-agent baseline with the same tools | `src/baseline/` (§9), compared with four multi-agent orchestrations in `src/orchestrations/` (§6) |
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
  llm/                      provider.ts (interface), vertex-gemini.ts, jev.ts (OpenRouter decisions client),
                            scripted.ts (test doubles for both), schema.ts (zod → Gemini schema),
                            usage.ts, pricing.ts
  engine/                   events.ts, run-state.ts (reducer), scheduler.ts, budgets.ts, ledger.ts,
                            citations.ts, persistence.ts, run.ts (entry point for every arm)
  agents/                   orchestrator.ts, observability.ts, dependency.ts, reasoning.ts, critic.ts,
                            reporting.ts, specialist-loop.ts, critic-checks.ts, prompts/*.md, objective.md
  orchestrations/           split-by-source.ts (A), causes-first.ts (B), no-critic.ts (C),
                            jev-assisted.ts (D), registry.ts
  baseline/                 single-agent.ts (E)
  server/                   app.ts, routes/*.ts, sse.ts, limits.ts, static.ts
  cli/                      investigate.ts, fixtures.ts, eval.ts
scenarios/                  generator inputs (they encode the mechanisms, so they're agent-invisible)
  _lib/                     seeded RNG, series/noise helpers, log templates, world builder
  s01-stale-nav.ts … s14-kyc-conflicting-evidence.ts
fixtures/v1/                generated corpus (+ manifest.json with hashes) — the downloadable dataset
eval/
  labels/                   answer keys (never imported by src/, never loaded into any DB)
  rubric.md, judge-questions.md, judge-validation/ (hand-labeled items for checking the judge)
  runner.ts, score.ts, judge.ts, summarize.ts
  runs/                     every eval run's full event log + report (committed)
  results/                  summary.json + summary.md (committed, generated)
web/                        Vite vanilla-TS UI
test/                       vitest
docs/                       assignment.md, spec.md, brief.md, architecture.md, evaluation.md,
                            technical-note.md, limitations.md, scenarios.md, transcript/
```

## 3. Synthetic world and fixtures

- **One fictional product: an Indian investing app with an AI assistant built in.** Users buy
  stocks and mutual funds, run SIPs on UPI autopay, track their portfolio, redeem to their bank
  account, and ask the assistant about funds and their own holdings. Service catalog (spec §3;
  add more only if a scenario needs them):
  - Money: `api-gateway`, `auth-service` (OTP login), `order-service` (stock orders),
    `broker-connector`, `mf-order-service` (fund purchases and SIPs), `mandate-service` (UPI
    autopay and e-mandates), `payment-service`, `debit-worker` (collects SIP instalments),
    `bank-connector`, `portfolio-service` (holdings, values, P&L), `market-data-service`
    (prices, and fund NAVs from the AMFI feed), `payout-service` (redemptions), `kyc-service`,
    `notification-service`.
  - Assistant: `assistant-orchestrator`, `knowledge-index` (fund factsheets, help articles),
    `indexing-pipeline`, `user-context-service` (the user's holdings, for personal answers),
    `compliance-filter` (blocks direct buy/sell advice, which SEBI doesn't allow without an
    advisory licence).
  - Shared: `cache`, `database`, `job-scheduler`, `message-queue`.
  - External, marked `external: true` and seen through our connectors' metrics and logs:
    `llm-provider`, `bank-apis`, `npci`, `broker-api`, `amfi-nav-feed`, `kyc-agency`,
    `sms-provider`. Each can fail in ways that look like our own fault.

  Every world shares the catalog; dependency metadata may differ per world.
- **One world per scenario variant.** A world is a self-contained partition: an opaque ID
  (`w_` + 8 hex chars from a salted hash, revealing nothing about the scenario), a 3–4 hour
  incident window, background data for every service, and ~60 days of historical incidents. A
  run is bound to one world by the server/CLI. **Agents never name or see a world ID. The
  tool layer injects it.**
- **Realism is the whole game.** Every world has:
  - Per-minute metrics for every service (`request_rate`, `error_rate`, `latency_p50_ms`,
    `latency_p95_ms`, plus service-specific ones such as `cache_hit_rate`, `nav_age_s`,
    `index_version`, `missing_context_rate`, `rate_limited_count`, `retry_count`,
    `order_success_rate`, `debit_count`, `mandate_success_rate`, `otp_success_rate`,
    `queue_depth`, `db_lock_wait_ms`). Metric points may carry labels (e.g. `bank`, `route`),
    and `query_metrics` can group by one label, so "healthy overall, failing for one bank" is
    discoverable. Traffic follows Indian market hours: a sharp rush at the 09:15 IST open,
    quieter after the 15:30 close, SIP debits in early-morning batches. Add noise.
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
- **Timestamps** are ISO-8601 UTC with an explicit offset. Incident reports quote times in IST
  (e.g. "09:15 IST"), as an Indian on-call engineer would. Exception: in scenario 11 one source
  logs IST without an offset. Tools return what the source says
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

## 5. Model layer — `gemini-3.8-flash` on Vertex AI, plus Jev

- **Endpoint:** `POST https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/global/publishers/google/models/gemini-3.8-flash:generateContent`.
  The first live calls (order of work, step 3) confirm it before anything builds on it.
- **Auth:** `google-auth-library`. Use `VERTEX_SERVICE_ACCOUNT_B64` (base64 of the service-account
  JSON) if set, otherwise Application Default Credentials, so reviewers can run
  `gcloud auth application-default login`. Env: `VERTEX_PROJECT_ID`, `VERTEX_LOCATION=global`,
  `ROOTLINE_MODEL=gemini-3.8-flash`.
- **The Gemini 3.8 Flash contract (learned in production use; follow it exactly):**
  1. **No `temperature`, `top_p`, `top_k`, `candidate_count`, penalties, seed or integer
     thinking budget**: 3.8 Flash rejects them. Control reasoning with
     `generation_config.thinking_config.thinking_level` ∈ `low | medium | high`. Outputs are
     therefore not seedable: repeated runs measure variance (say so in the evaluation).
  2. Limits: 1,048,576 input tokens and **65,536** output tokens. Thinking and answer share
     the output limit.
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
     quota is shared with other workloads, so **eval concurrency defaults to 2 runs**
     (`ROOTLINE_EVAL_CONCURRENCY`).
- **Thinking level:** the same level for every role, every arm **and** the baseline (default
  `medium`), so the comparison is fair. Record any per-role override in the run metadata.
- **Cost estimates** (`src/llm/pricing.ts`): Gemini 3.8 Flash at the standard rates of $1.50 / M
  input and $7.50 / M output including thinking, with cached input at 0.1× ($0.15 / M). Google
  currently returns 50% promotional credits on top; estimates use the standard rates and say
  so. Jev: $0.042 / M input, $0 output. Check against the providers' pricing pages before
  quoting cost in docs. Report tokens as the primary measure; cost is an estimate with the rate
  table stated.
- **`ScriptedProvider`:** a deterministic test double that plays back canned function calls and
  JSON per role and step, plus a scripted Jev that returns canned decisions. Every
  deterministic test uses them, so the engine is fully testable offline.

### Jev (decision model)

- **What it is:** a "System One" decision model from TypeSafe. You send it material (the
  state) and typed questions, and it returns probabilities, not text:
  - **Choice:** pick one of the options you supply → the selected option, a probability per
    option, and a confidence.
  - **Noul:** the probability that a yes/no proposition is true.
  - **Score:** a rating on an ordered scale you define → a distribution and a confidence.

  Questions in one request are judged independently against the same state. Many questions
  per call add almost no latency, so batch them.
- **API:** `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`,
  `Authorization: Bearer $OPENROUTER_API_KEY`. Take the exact request and response shapes from
  OpenRouter's and TypeSafe's docs (`docs.typesafe.ai`) before writing `src/llm/jev.ts`, and
  validate every response with zod.
- **Limits:** a 32,000-token context including state and questions; text only. Split larger
  inputs into batches. Record provider-reported usage per call (unknown is `null`). Retry
  429/5xx like the Vertex provider.
- **Known behavior:** in an earlier classification test it was about 3.6× faster and 6× cheaper
  than Gemini Flash-Lite, and slightly less accurate (71/76 vs 74/76). Its answers are checks
  that feed the agents, never final verdicts. Confidence thresholds need validating.
- **Where it acts (arm D only, §6):**
  1. **Screening tool output.** Before a specialist's model reads a tool result, Jev scores
     each record's relevance to the task question. Low-relevance records are collapsed into a
     count with their IDs; they stay in the ledger and remain citable. Use a lenient threshold.
  2. **Evidence-vs-cause grid.** After specialists return, Jev answers "does `ev_N` support /
     contradict hypothesis `H_k`?" for every pair. The grid goes to reasoning and the critic.
  3. **Citation check.** For each claim, Jev answers "does the cited excerpt back this claim?".
     Weakly backed claims are flagged for the critic.

  Jev must take work away from Flash (less tool output to read, fewer re-reads of evidence),
  not add a layer on top. Flash still writes everything: plans, candidate causes, tool
  queries and the report. The critic's verdict stays on Flash. If arm D doesn't come out
  cheaper than its base arm, the evaluation says so.

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
- Flow (arm A): R0 plan → specialists (parallel) → reasoning → critic → [critic says
  `investigate` → follow-up specialists (parallel) → reasoning v(n+1) → critic]* → reporting.
  The other arms change this flow as described under **Orchestrations** below.
- **Termination is decided in code**, with a typed `stopReason`:
  `critic_accepted | critic_insufficient_evidence | max_rounds | no_new_evidence |
  budget_tool_calls | budget_llm_calls | budget_tokens | deadline | cancelled | unrecoverable_error`.
  Defaults: 3 critique rounds, 40 tool calls, 30 LLM calls, a token ceiling, a 6-minute deadline.
  All configurable, all checked **before** each call, and the remaining budget is visible to
  the orchestrator and the critic.

### Orchestrations (the arms)
Every arm uses the same agents where they apply, the same tools, tool runner, ledger, budgets,
fault injection, model, thinking level, objective text and report schema. Each arm is a
strategy in `src/orchestrations/`, and every run records which arm ran.

- **A. Split by source, then critique** (the reference design): the orchestrator splits the
  work by data source (metrics and logs vs changes, dependencies and history), specialists run
  in parallel, then reasoning, the critic and follow-up rounds. The flow above.
- **B. Causes first:** before any tool call, the reasoning agent proposes 3–4 candidate causes
  from the incident report and the service catalog. The orchestrator plans tasks that confirm
  or rule out each one (each task names the hypothesis IDs it discriminates), then reasoning,
  the critic and follow-ups run as in A. Reasoning must be free to drop every initial candidate
  and add new ones; the scenarios' red herrings are built to tempt early guesses.
- **C. A without the critic:** one round; reasoning goes straight to reporting. Shows what the
  critic is worth.
- **D. Jev-assisted:** whichever of A and B scores better on the **dev scenarios**, with Jev
  making the small decisions in §5. The base arm is picked before the prompt freeze and
  recorded in `eval/results`; until then D takes its base as a parameter.
- **E. Single-agent baseline** (§9).

### Orchestrator (hybrid: the model plans, code governs)
- The model step takes the incident, service catalog, dependency summary and budget (and in
  arm B, the candidate causes), and returns a plan: 2–6 tasks, each with a role ∈ {observability, dependency}, a question,
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
  hit every arm.**
- Simulated latency is small (50–400 ms). Timeouts really elapse at the per-tool deadline
  (default 1500 ms), so latency numbers are honest.

## 8. Scenarios

Build all 14. Each is built around a trap: something that makes the obvious answer wrong.

| # | File | What gets reported | Real cause | The trap | Expected |
| --- | --- | --- | --- | --- | --- |
| 01 | `s01-stale-nav` | Portfolio shows yesterday's values | The overnight AMFI NAV import job failed at 23:30 IST | A `portfolio-service` deploy at 09:10, right when complaints started | Conclusive |
| 02 | `s02-llm-throttling` | Assistant replies take 20 s or more | The LLM provider is throttling us (quota) | The knowledge index was rebuilding at the same time and looks slow too | Conclusive |
| 03 | `s03-compliance-prompt` | Assistant started giving direct "buy this fund" advice | A prompt change weakened the compliance filter | The LLM provider updated its model version the same day | Conclusive |
| 04 | `s04-broker-rate-limit` | Stock orders failing at the 09:15 IST market open | The broker API's rate limit, hit by our order bursts | High CPU from the opening rush looks like overload | Conclusive |
| 05 | `s05-missing-holdings` | Assistant says "you don't hold any funds" | `user-context-service` timing out **and** the cache serving stale empty data | Two causes; fixing one doesn't explain everything | Conclusive, both causes |
| 06 | `s06-sip-double-debit` | SIP debited twice | The bank slowed down, and a shortened retry timeout made us resubmit debits | An app release at 09:15, and a past double-debit incident with a different cause | Conclusive |
| 07 | `s07-stale-factsheet` | Assistant quotes an old expense ratio | The monthly factsheet update never reached the knowledge index | Search itself looks perfectly healthy | Conclusive |
| 08 | `s08-paise-rupee` | Portfolio values 100× too high | A config change made one service treat paise as rupees | Market data upstream looks fine | Conclusive |
| 09 | `s09-one-bank-mandates` | Autopay setup failing "for some users" | One bank's mandate API is failing | Overall success is 94%, which looks healthy unless split by bank | Conclusive |
| 10 | `s10-past-incident-decoy` | Orders failing at market open, again | Our own connection-pool config change | A past incident with identical symptoms was a broker outage | Conclusive |
| 11 | `s11-ist-timestamps` | Errors after a release, but the release seems to come after the failures, so it gets ruled out | The release is the cause: one service logs IST without an offset, shifting its events by 5.5 hours | The timeline itself is misleading | Conclusive |
| 12 | `s12-missing-auth-logs` | OTP logins failing | The auth logs for the window never arrived | "SMS provider" sounds right, but nothing supports it | **Inconclusive** |
| 13 | `s13-payout-db-lock` | Redemption payouts delayed | The payout batch job is stuck on a database lock | The metrics tool keeps timing out; agents must retry or use logs, and disclose the gap | Conclusive, gap disclosed |
| 14 | `s14-kyc-conflicting-evidence` | KYC stuck at "pending" | Two causes fit (the KYC agency is slow, or our webhook is failing), and the evidence that would separate them keeps failing to load | Picking one is the failure | **Inconclusive** |

Coverage of the assignment's required types: misleading evidence (01–04, 06–11), conflicting
observations (05, 14), tool failures (13, 14 by design; 12 through missing data; random
background faults everywhere).

For each one, `scenarios/sNN-*.ts` defines the services involved, the window, the causal
mechanism and its signals, the scripted red herrings, the history and the fault profile, and
writes the incident report text. `eval/labels/sNN.json` holds:

```json
{
  "scenario": "s01",
  "expectedOutcome": "conclusive",
  "acceptableCauses": [{ "component": "market-data-service", "causeType": "data_pipeline_failure",
                         "mechanism": "overnight AMFI NAV import job failed at 23:30 IST, so NAVs were never refreshed" }],
  "partialCredit": [],
  "requiredEvidence": [{ "description": "NAV import job failure logs", "match": { "tool": "query_logs", "service": "market-data-service" } }],
  "keyCounterevidence": ["portfolio-service deploy at 09:10 IST came after the NAVs went stale"],
  "redHerrings": ["portfolio-service deploy 09:10 IST"],
  "notes": "…"
}
```

- **Cause taxonomy** (generic, scenario-independent, used by every arm):
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
  change after the freeze, rerun everything and say so. Arm D's base arm is picked from dev
  results only.

## 9. Single-agent baseline

One agent with **all five tools**, one tool loop and the **same objective text**
(`src/agents/objective.md`, shared). It ends with `submit_report` using the **same report
schema**, so scoring is identical. It has the same budgets (tool calls, LLM calls, tokens,
deadline), the same thinking level, and the same tool runner, ledger and fault injection, so
evidence IDs and grounding are comparable. It runs sequentially: document that difference.
It is *not* one-shot; it may iterate until done or out of budget. It is arm E in every
comparison.

## 10. Evaluation

- **Matrix:** 5 arms × 14 scenarios, inside `ROOTLINE_EVAL_MAX_USD` (default **50**). First
  measure the cost per run on dev smoke runs, then fill coverage in this order: (1) every arm
  once on every A variant (70 runs); (2) every arm once on every B variant; (3) repetitions on
  A variants. Held-out variants matter more than repetitions. Record the plan in
  `eval/results` before the first held-out run; stop at whatever level the budget reaches and
  say so.
- **Runner** (`npm run eval`): resumable (skips run files that already exist), concurrency
  ≤ 2, records the fixture hash, prompt hash, model IDs and `modelVersion` from responses,
  thinking level, budgets, git SHA and machine info. Every run artifact goes to
  `eval/runs/<scenario>-<variant>-<arm>-r<k>.json` (events + report + metrics). Crashed
  runs are recorded as failed and never silently rerun.
- **Scoring** (`eval/rubric.md`, frozen before held-out runs):
  - *Root cause (deterministic):* does the top hypothesis's `(component, causeType)` match an
    acceptable cause? Report correct/total on conclusive cases, apply partial credit as
    labeled, and show the top-2 hit rate as a supplementary number.
  - *Mechanism agreement (judge):* `eval/judge.ts` asks **Jev** the typed questions in
    `eval/judge-questions.md` (e.g. a Noul: "the report's top cause describes the same
    mechanism as the label"). Jev is a different model family from the agents, so Gemini
    doesn't grade Gemini. The judge is **blind to arm**. Before any judging, validate it on
    the hand-labeled items in `eval/judge-validation/` (about 40 claims and mechanisms) and
    report the agreement. Report agreement with the deterministic score and print
    disagreements.
  - *Inconclusive handling:* correct abstentions, unsupported definitive diagnoses and false
    abstentions.
  - *Grounding:* the fabricated-citation rate (deterministic). Claim support (judge: does the
    cited evidence excerpt entail the claim?) as supported / assessed. Required-evidence recall
    (labels). Key counterevidence addressed (judge).
  - *Tool calls:* calls, attempts, retries, failures and partials, per run and aggregated.
  - *Latency:* wall clock from start to report, plus per-stage timing from events.
  - *Tokens:* input / output / thinking / cached by model, role and run, with unknowns shown
    as unknown. A dollar estimate sits beside them (§5 rate table); it is the only fair common
    unit once arm D mixes Flash and Jev.
  - *Supplementary:* confidence vs correctness (exploratory, no calibration claim), critic
    follow-up rate, recovery from faults, tool completeness, and for arm D how many decisions
    Jev made and whether screening ever dropped required evidence.
- **Comparing arms:** with 14 scenarios, small differences are noise. Claim only differences
  the numbers clearly show, and say when the single agent wins. Note that Jev both judges and
  acts inside arm D.
- **Outputs:** `eval/results/summary.json` + `summary.md` (per-case table, aggregates,
  mean ± range across repetitions, environment). `docs/evaluation.md` explains the method and
  embeds those numbers. **Never hand-edit results, and never claim multi-agent wins unless
  the numbers show it.**
- `npm run eval:smoke` runs one dev scenario in every arm as a quick live check. It isn't part
  of `npm test`.

## 11. UI and Agentflow

**Pages** (served at `/`): the incident list, labeled "synthetic data", with an arm picker
(A–E, each with a one-line description) and a start button, so a reviewer can watch the same
incident investigated different ways. A run view with the Agentflow panel, an
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
  latest tool call, e.g. `query_metrics market-data-service nav_age_s`.
- Arm B adds a `candidates` node before the plan. Arm C has no critic nodes. Arm D shows Jev
  decisions as captions on the node that asked for them (e.g. `jev: kept 13 of 100 log lines`).
- The single-agent baseline maps to root → `agent` → `report`, with tool calls as captions.

## 12. API, limits and production readiness

- `GET /api/incidents` · `POST /api/runs {incidentId, arm}` · `GET /api/runs/:id` ·
  `GET /api/runs/:id/events` (SSE, resumes from `?after=seq`) · `GET /api/runs` (recent) ·
  `POST /api/runs/:id/cancel` · `GET /api/eval/summary` · `GET /api/eval/runs/:file` ·
  `GET /downloads/fixtures-v1.zip` · `GET /healthz`.
- The public demo spends real model money: **live runs** are limited per IP (default 3/hour)
  and globally per day (default 40). `ROOTLINE_ACCESS_CODE`, when set, is required to start a
  run; the hosted demo sets it, so only reviewers with the code start live runs. Recorded runs
  and eval results are always browsable without limits or a code. Secrets stay server-side
  only. Reviewers use the hosted app and the repo; they aren't expected to run it locally.
- Config comes from env only (`PORT`, `DATABASE_URL`, `VERTEX_*`, `OPENROUTER_API_KEY`,
  `ROOTLINE_*`).
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
fixture reproducibility (hashes); every arm receives identical tools, budgets and fault
profiles; Jev screening keeps screened-out records in the ledger and citable. Integration: a
scripted end-to-end run in every arm (A–E) against a small seeded world, asserting persisted
events and the final report.

## 14. Deliverables checklist

1. `README.md`: what it is, a quickstart (no DB setup), env vars, the commands (`investigate`,
   `eval`, `eval:smoke`, `fixtures:*`, `dev`, `build`, `start`), the hosted demo link, external
   dependencies (Vertex AI / Gemini 3.8 Flash, OpenRouter / Jev, hosted Agentflow viewer,
   optional Deltabase) and what the reviewer receives.
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
   labels, synthetic data, model variance, small n, judge risk (Jev judges every arm and also
   acts inside arm D), external dependencies.

## 15. Order of work

Commit and push after every checkpoint (small, coherent, tested slices, straight to `main`).

1. **Foundation:** scaffold, config, contracts, schema, PGlite client, fixed queries, five
   tools + runner + faults, a minimal world generator.
   ✔ Tests show complete / empty / partial / error, retries and deterministic faults.
2. **All 14 scenarios** (A + B), labels, the generator, manifest hashes, `docs/scenarios.md`
   evidence-sufficiency review.
   ✔ The reproducibility test passes, and every scenario's answer is reachable through tools.
3. **Model layer:** the Vertex provider (the full Gemini 3.8 Flash contract), the Jev client,
   the scripted doubles, the schema converter, usage.
   ✔ One live structured call, one live tool-loop call and one live Jev call succeed.
4. **Engine + six agents** with arm A, the event log, persistence, CLI
   `npm run investigate -- --scenario s01 --arm A`.
   ✔ A live trace shows parallel specialists, a contradiction, a critic follow-up and a new
   round. Also deterministic scripted tests for every path in §6 and §13.
5. **Arms B, C, D and the baseline (E).** ✔ The same CLI with `--arm B|C|D|E` produces the
   same report schema.
6. **Server + UI + Agentflow mapping.** ✔ Code-level checks only (typecheck, build,
   endpoint tests with the scripted provider). **Don't open a browser.**
7. **Evaluation:** rubric, judge questions and judge validation, dev smoke, pick arm D's base,
   prompt freeze, the matrix, summary.
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
