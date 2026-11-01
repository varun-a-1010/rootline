# Rootline

A multi-agent system that investigates production incidents in a fictional Indian investing
app with an AI assistant built in. It plans an investigation, queries logs, metrics,
deployments, dependencies and past incidents through tools that fail like real ones, develops
and challenges competing hypotheses, and writes an evidence-cited report with corrective
actions. When the evidence does not support a diagnosis, it says so: *inconclusive* is a
valid outcome.

It was built for an AI Engineer take-home assignment ([`docs/assignment.md`](docs/assignment.md)).
**All services, incidents, users and data in this repository are synthetic.**

## What you get

| Deliverable | Where |
| --- | --- |
| Runnable implementation | `src/` (engine, six agents, five tools, five orchestrations), `web/`, this README |
| Architecture and coordination | [`docs/architecture.md`](docs/architecture.md) |
| Synthetic incidents, dataset and tests | [`docs/scenarios.md`](docs/scenarios.md), `scenarios/`, `fixtures/v1/`, `eval/labels/`, `test/` |
| Evaluation (multi-agent vs single-agent) | [`docs/evaluation.md`](docs/evaluation.md), `eval/results/`, every run in `eval/runs/` |
| Technical note (≤ 500 words) | [`docs/technical-note.md`](docs/technical-note.md) |
| Limitations and external dependencies | [`docs/limitations.md`](docs/limitations.md) |
| Coding-assistant transcript | [`docs/transcript/`](docs/transcript/) |
| Build plan and design proposal | [`docs/brief.md`](docs/brief.md), [`docs/spec.md`](docs/spec.md) |
| Sample live trace | [`docs/traces/`](docs/traces/) |

Hosted demo: `https://rootline.slate-app.online` (recorded runs and evaluation results are open;
starting a live run needs an access code because it spends real model money).

## Quickstart (no database setup)

Requires Node 22.12+ and npm.

```bash
git clone https://github.com/varun-a-1010/rootline && cd rootline
npm ci
npm test            # deterministic, offline: no model calls, no network
npm run typecheck
```

Investigating an incident needs a model. Rootline uses Gemini 3.8 Flash on Vertex AI:

```bash
gcloud auth application-default login            # or set VERTEX_SERVICE_ACCOUNT_B64
export VERTEX_PROJECT_ID=<your-gcp-project>
npm run investigate -- --scenario s01 --arm A     # live trace on stderr, report on stdout
npm run investigate -- --scenario s01 --arm E     # the single-agent baseline
```

The first run loads the synthetic corpus into an in-process Postgres (PGlite) under
`.data/pglite`. That takes a few seconds and happens once.

Run the web app:

```bash
npm run build && npm start       # http://localhost:8787 (API + UI from one process)
npm run dev                      # API on :8787 and a Vite dev server with hot reload
```

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | All deterministic tests (scripted models; no network) |
| `npm run typecheck` | Server and web type checks |
| `npm run investigate -- --scenario s01 [--variant B] --arm A\|B\|C\|D\|E` | One live investigation with a trace; writes the full event log to `.data/runs/` |
| `npm run tool -- --world s01-A [--no-faults] [--model-view] <tool> '<json>'` | Call one tool exactly as an agent would |
| `npm run fixtures:generate` / `npm run fixtures:check` | Regenerate the corpus byte-for-byte / verify it against the manifest |
| `npm run fixtures:load` | Load the corpus into the database (`DATABASE_URL` or PGlite) |
| `npm run eval -- --scenarios s01,s02 --variants A,B --arms A,E` | Evaluation runs (resumable, budget-capped) into `eval/runs/` |
| `npm run eval:summarize` | Regenerate `eval/results/summary.{json,md}` from the recorded runs |
| `npx tsx eval/judge.ts [--validate]` | Model judge (Jev): validation agreement, then judged metrics |
| `npm run llm:check` | One live structured call, one tool loop and one Jev call |
| `npm run build` / `npm start` / `npm run dev` | Build, serve, develop the web app |

## Configuration (environment only)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VERTEX_PROJECT_ID` | (required for live runs) | Google Cloud project for Vertex AI |
| `VERTEX_LOCATION` | `global` | Vertex location |
| `VERTEX_SERVICE_ACCOUNT_B64` | (optional) | Base64 service-account JSON; otherwise Application Default Credentials |
| `ROOTLINE_MODEL` | `gemini-3.8-flash` | Model for every agent and the baseline |
| `ROOTLINE_THINKING_LEVEL` | `medium` | `low`, `medium` or `high`; the same for every role and arm |
| `OPENROUTER_API_KEY` | (optional) | Jev, needed for arm D and the evaluation judge |
| `ROOTLINE_JEV_MODEL` | `typesafe/jev-1.13` | Jev model |
| `DATABASE_URL` | (optional) | Postgres connection; otherwise PGlite in `ROOTLINE_DATA_DIR` |
| `ROOTLINE_DATA_DIR` | `.data/pglite` | PGlite data directory |
| `ROOTLINE_MAX_TOOL_CALLS` / `ROOTLINE_MAX_LLM_CALLS` / `ROOTLINE_MAX_TOKENS` | 40 / 48 / 2,000,000 | Per-run budgets (identical for every arm) |
| `ROOTLINE_DEADLINE_MS` / `ROOTLINE_MAX_ROUNDS` | 360000 / 3 | Run deadline, critique rounds |
| `ROOTLINE_SPECIALIST_TOOL_CALLS` / `ROOTLINE_TASK_CONCURRENCY` | 6 / 4 | Per-task tool budget, parallel tasks |
| `ROOTLINE_TOOL_DEADLINE_MS` / `ROOTLINE_TOOL_RETRIES` | 1500 / 2 | Per-attempt tool deadline, retries |
| `ROOTLINE_EVAL_CONCURRENCY` / `ROOTLINE_EVAL_MAX_USD` | 2 / 50 | Evaluation concurrency and spending cap |
| `PORT` | 8787 | HTTP port |
| `ROOTLINE_ACCESS_CODE` | (optional) | Required to start live runs from the web app when set |
| `ROOTLINE_RUNS_PER_IP_PER_HOUR` / `ROOTLINE_RUNS_PER_DAY` | 3 / 40 | Live-run limits |
| `ROOTLINE_FLOW_VIEWER_URL` | `https://flow.slate-app.online` | Agentflow viewer embedded in the run view |

## How it works (short)

An orchestrator plans parallel tasks split by data source. Observability and dependency
specialists investigate with their own tools. A reasoning agent ranks competing hypotheses with
supporting and contradicting evidence. A critic runs code checks (citations, chronology,
overconfidence, ignored counterevidence, a close ranking) and either accepts, gives up as
insufficient, or requests concrete follow-up tool calls that become a new parallel round. A
reporting agent writes the report, and code enforces citations and an honesty rule. Everything
is an event in an append-only log; state, persistence, the live UI and scoring all come from it.
Details: [`docs/architecture.md`](docs/architecture.md).

## External dependencies

- **Vertex AI, Gemini 3.8 Flash** (Google Cloud): every agent and the baseline. Needed for live
  runs and evaluation, not for `npm test`.
- **OpenRouter, Jev** (`typesafe/jev-1.13`): arm D's decisions and the evaluation judge. Optional.
- **Agentflow viewer** (hosted at `flow.slate-app.online`): the animated graph in the web UI's
  run view. The rest of the UI works without it.
- **Deltabase** (optional): the hosted demo's Postgres. Locally everything runs on PGlite.
- npm packages: zod, @electric-sql/pglite, pg, hono, @hono/node-server, google-auth-library,
  fflate; dev: typescript, vitest, tsx, vite.

What is incomplete or limited is listed in [`docs/limitations.md`](docs/limitations.md).
