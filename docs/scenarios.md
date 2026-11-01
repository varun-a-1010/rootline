# Scenarios and evidence-sufficiency review

Fourteen synthetic incidents in a fictional Indian investing app with an AI assistant built in.
Each has an **A** variant and a held-out **B** variant: a different seed, day, time of day,
magnitudes, red herrings and (where it matters) a different flavour of the same mechanism
class. Everything here is invented: services, banks, funds, tickers, people and data.

- Generator: `scenarios/sNN-*.ts` on top of `scenarios/_lib/` (world builder, catalog, traffic
  shapes, background logs, routine changes, incident history). `npm run fixtures:generate`
  rebuilds `fixtures/v1/` byte-for-byte; `npm run fixtures:check` verifies it against
  `fixtures/v1/manifest.json` (sha256 per file over uncompressed content, plus a corpus hash).
- Answer keys: `eval/labels/sNN-{A,B}.json` (evaluator-only; never imported by `src/`, never
  loaded into a database, never reachable through a tool).
- Fault profiles: `fixtures/v1/<world>/faults.json`, read only by the fault layer.
- Every world also carries background noise: per-minute metrics for every service following
  Indian market hours, ~3,000-7,000 log lines with 1-3% irrelevant errors, 35-55 routine
  deploys/config/flag changes over 10 days (1-3 inside the incident window), ~16 past
  incidents over 60 days, and random transient tool faults (timeouts, unavailable, partial
  results) that are decided by request and attempt, so every arm meets the same ones.
- Dev split (prompt iteration allowed): **s01, s02, s04, s06, s12, s13 — variant A only.**
  Everything else, and every B variant, is held out.

| # | Reported | Real cause | The trap | Expected |
| --- | --- | --- | --- | --- |
| s01 | Portfolio shows yesterday's values | Overnight NAV import (market-data-service, 23:30 IST) failed: A parse error, B OOM-kill | A: portfolio-service deploy at 09:10, when complaints start. B: cache TTL raise for the NAV keyspace at 08:55, plus a past "stale values from cache TTL" incident | Conclusive |
| s02 | Assistant replies take 20 s+ | LLM provider throttling (429 quota): A tokens/min, B requests/min | A: knowledge-index rebuild at the same time, also slow, plus a matching past incident. B: a prompt deploy 7 minutes after the 429s start | Conclusive |
| s03 | Assistant gives direct "buy this fund" advice | Compliance-filter change weakened advice detection: A prompt rewrite, B threshold raise | A: provider moved the model alias that morning ("more direct answers"). B: assistant tone-prompt deploy 25 min earlier | Conclusive |
| s04 | Stock orders failing at the 09:15 open | Opening burst exceeds the broker's per-second rate limit (429) | A: order-service CPU ~82% and a past CPU-saturation incident. B: database CPU and slow queries spike at the open | Conclusive |
| s05 | Assistant says "you don't hold any funds" | Two causes: user-context-service timeouts (A campaign surge, B OOM restarts) **and** empty contexts cached for 6 h | Fixing either alone leaves symptoms; a portfolio/knowledge-index deploy near the onset | Conclusive, both causes |
| s06 | SIP debited twice | One bank slowed; a shortened confirmation timeout made debit-worker resubmit (A config, B deploy) | A: app release at 09:15 and a past "batch ran twice" incident. B: bank-connector deploy at 05:50 and a past bank-side duplicate | Conclusive |
| s07 | Assistant quotes an old expense ratio | Monthly factsheets never reached the index: A strict-validation deploy rejects them, B cron typo means sync never ran | Search is perfectly healthy; A LLM temperature change, B knowledge-index deploy | Conclusive |
| s08 | Portfolio values 100x too high | portfolio-service switched to an endpoint returning paise and treats it as rupees (A config: stock prices, B flag: fund NAVs) | Market data looks fine; A market-data deploy 22 min earlier, B quotes-cache change and feed reconnect warnings | Conclusive |
| s09 | Autopay setup failing "for some users" | One bank's mandate API failing (A sahyadri timeouts, B gomti U16 declines) | Overall success ~93% looks fine unless split by bank; a deploy/config change just before; past NPCI outage | Conclusive |
| s10 | Orders failing at the open "again" | Our own pool config change on Friday (A DB pool 100 -> 20, B broker client pool 200 -> 20) | Two past incidents with identical symptoms were broker-side; the reporter assumes the same | Conclusive |
| s11 | Errors after a release that seems to come after the failures | The release; its deploy record is IST without an offset, read as UTC, so it appears 5.5 h late | The timeline itself; the reporter has already ruled the release out | Conclusive |
| s12 | OTP logins failing | Unknown: auth-service logs for the window never arrived (A shipper upgrade) or arrive heavily incomplete (B) | "The SMS provider" sounds right and has a precedent, but SMS sends are normal | **Inconclusive** |
| s13 | Redemption payouts delayed | Payout batch blocked on a DB lock (A ALTER TABLE migration, B FOR UPDATE export job) | The metrics tool times out for these services; bank payout API warnings | Conclusive, gap disclosed |
| s14 | KYC stuck at pending | Two fitting causes: agency slow vs our intake (A webhook 500s, B stuck queue consumer) | The evidence that would separate them keeps failing to load; both have precedents | **Inconclusive** |

## How the traps are made plausible

- **Timing.** Every red-herring change sits close to the onset or the first complaint: s01-A
  09:10 deploy vs 09:10 complaints, s02-B deploy 7 min after the 429s begin, s05 deploys
  minutes before onset, s09-A deploy 18 min before.
- **Supporting-looking signals.** The red herrings move metrics: portfolio p95 +22% after the
  s01-A deploy, knowledge-index p95 x4 during the s02-A rebuild, order-service CPU to ~82% in
  s04-A, database CPU +38 points in s04-B, NAV-keyspace hit rate up after the s01-B TTL change.
- **History.** Nine scenarios plant a past incident whose symptoms match and whose cause is the
  trap (s01 AMFI late file / cache TTL, s02 index rebuild / prompt template, s03 model update /
  tone prompt, s04 CPU / unindexed query, s06 double-run batch / bank duplicate, s09 NPCI
  outage, s10 broker outages, s12 SMS outage, s14 one precedent for each candidate).
- **Reporter bias.** Incident reports name the suspected cause the way an on-call would ("looks
  like we're overloaded", "probably the broker again", "we've ruled the release out"). They
  never state or imply the real cause.

## How the real answer is reachable

The mechanism lives only in the data. The table below is generated by `scenarios/review.ts`,
which runs each labeled piece of required evidence through the real tool runner over the
world's data range — once with faults off, once with the world's fault profile as an agent
would meet it — and probes every scripted fault rule. `test/fixtures.test.ts` asserts the same
(every required item returns `ok` with matching content; every scripted fault fires).

Discriminating checks that are reachable but not listed as required evidence:

- s01: `nav_age_s` is already past 24 h and climbing before the red-herring change; NAV lookups
  log `nav_date=<previous import>`.
- s03: `block_rate` stays ~2% after the red herring and collapses at the compliance change.
- s05: `missing_context_rate` stays elevated after `timeout_count` returns to normal.
- s09: `mandate_success_rate` with `group_by: bank`.
- s10: broker-connector `rate_limited_count` and upstream latency are normal.
- s11: error logs carry `version` = the new build from two minutes after the real release time;
  the deploy record shows `tz: "none"`.
- s13: the lock holder is named in database logs (`blocked by process 48213 ... ALTER TABLE` /
  `... FOR UPDATE (aum-export)`); metrics for payout-service/database time out on every attempt.
- s12/s14: the absence is itself the evidence (an auth-service log gap starting 10:25 IST in
  s12-A; webhook series and queue metrics that never load in s14).

## Review status (agent-reviewed, not human-reviewed)

This review was done by the coding agent that wrote the scenarios: it queried the tools, read
the results and checked that the labeled answer follows from tool-reachable evidence and that
each red herring is plausible. **No human has independently reviewed the labels.** That is a
limitation (`docs/limitations.md`): an author-reviewer can share blind spots with the
scenarios it wrote.

Spot checks recorded during the review (faults off, via `npm run tool`):

- s09-A, 10:30-12:30 IST: overall `mandate_success_rate` mean 93.35%; by bank: gomti 96.3,
  indus_valley 95.9, kaveri 95.8, northstar 96.8, **sahyadri 68.2**.
- s04-A, 5-minute buckets from 09:00 IST: order-service `cpu_utilization` 27 -> **82** -> 72 -> 66 ...;
  `order_success_rate` 99.2 -> **80.3, 77.9, 74.8, 77.7, 76.7** -> 96.1 -> 99.2.
- s08-A, 5-minute buckets from 10:30 IST: `displayed_value_total_cr` ~4,850 -> 57,492 (11:00
  bucket, change at 11:02) -> ~269,000.
- s11-A: `get_changes` returns the mf-order-service release as `t: "2026-10-20T09:20:00.000",
  tz: "none"`; the first `NullPointerException` errors are at `03:52Z` (09:22 IST) with
  `version: "4.1.0"`.
- s01-A: `nav_age_s` hourly from 22:00 IST on 13 Oct: 81,390 s rising to 123,810 s by 09:30 IST;
  nav-import logs at 23:32 IST: `parse error at line 8982: invalid NAV value 'N.A.'` and
  `aborting import; 0 of 14231 NAVs written`.

### Generated reachability table

| World | Required evidence | Tool call | Faults off | As agents meet it (faults on) |
| --- | --- | --- | --- | --- |
| s01-A | nav-import failure logs | `query_logs(market-data-service "nav-import")` | ok, 4 records, match | ok, 4 records |
| s01-A | NAV age metric showing staleness since the failed import | `query_metrics(market-data-service/nav_age_s)` | ok, 1 records | ok, 1 records |
| s01-B | nav-import failure logs | `query_logs(market-data-service "nav-import")` | ok, 4 records, match | ok, 4 records |
| s01-B | NAV age metric showing staleness since the failed import | `query_metrics(market-data-service/nav_age_s)` | ok, 1 records | ok, 1 records |
| s02-A | 429 quota errors from the LLM provider | `query_logs(assistant-orchestrator "429")` | ok, 100 records, match | ok, 100 records |
| s02-A | rate-limited call count | `query_metrics(assistant-orchestrator/rate_limited_count)` | ok, 1 records | ok, 1 records |
| s02-B | 429 quota errors from the LLM provider | `query_logs(assistant-orchestrator "429")` | ok, 100 records, match | ok, 100 records |
| s02-B | rate-limited call count | `query_metrics(assistant-orchestrator/rate_limited_count)` | ok, 1 records | ok, 1 records |
| s03-A | compliance-filter config change | `get_changes(compliance-filter)` | ok, 3 records | ok, 3 records |
| s03-A | block rate drop | `query_metrics(compliance-filter/block_rate)` | ok, 1 records | ok, 1 records |
| s03-B | compliance-filter config change | `get_changes(compliance-filter)` | ok, 3 records | ok, 3 records |
| s03-B | block rate drop | `query_metrics(compliance-filter/block_rate)` | ok, 1 records | ok, 1 records |
| s04-A | 429 responses on /orders | `query_metrics(broker-connector/rate_limited_count)` | ok, 1 records | ok, 1 records |
| s04-A | 429 errors in broker-connector logs | `query_logs(broker-connector "429")` | ok, 100 records, match | ok, 100 records |
| s04-B | 429 responses on /orders | `query_metrics(broker-connector/rate_limited_count)` | ok, 1 records | ok, 1 records |
| s04-B | 429 errors in broker-connector logs | `query_logs(broker-connector "429")` | ok, 100 records, match | ok, 100 records |
| s05-A | context build timeouts | `query_logs(user-context-service "timed out")` | ok, 100 records, match | ok, 100 records |
| s05-A | empty context cached with long TTL | `query_logs(user-context-service "holdings=0")` | ok, 100 records, match | ok, 100 records |
| s05-A | missing-context rate stays high after timeouts stop | `query_metrics(user-context-service/missing_context_rate)` | ok, 1 records | ok, 1 records |
| s05-B | context build timeouts | `query_logs(user-context-service "timed out")` | ok, 100 records, match | ok, 100 records (2 attempts) |
| s05-B | empty context cached with long TTL | `query_logs(user-context-service "holdings=0")` | ok, 100 records, match | ok, 100 records |
| s05-B | missing-context rate stays high after timeouts stop | `query_metrics(user-context-service/missing_context_rate)` | ok, 1 records | ok, 1 records |
| s06-A | resubmission logs | `query_logs(debit-worker "resubmitting")` | ok, 100 records, match | ok, 100 records |
| s06-A | the timeout change | `get_changes(debit-worker)` | ok, 1 records | ok, 1 records |
| s06-B | resubmission logs | `query_logs(debit-worker "resubmitting")` | ok, 100 records, match | ok, 100 records |
| s06-B | the timeout change | `get_changes(debit-worker)` | ok, 1 records | ok, 1 records |
| s07-A | rejected factsheet batch | `query_logs(indexing-pipeline "rejected")` | ok, 7 records, match | ok, 7 records (2 attempts) |
| s07-A | strict validation deploy | `get_changes(indexing-pipeline)` | ok, 1 records | ok, 1 records |
| s07-B | factsheet-sync schedule change | `get_changes(job-scheduler)` | ok, 1 records | ok, 1 records |
| s07-B | freshness check warning | `query_logs(indexing-pipeline "freshness")` | ok, 1 records, match | ok, 1 records |
| s08-A | the portfolio-service change | `get_changes(portfolio-service)` | ok, 3 records | ok, 3 records |
| s08-A | displayed value jump | `query_metrics(portfolio-service/displayed_value_total_cr)` | ok, 1 records | ok, 1 records |
| s08-B | the portfolio-service change | `get_changes(portfolio-service)` | ok, 3 records | ok, 3 records (2 attempts) |
| s08-B | displayed value jump | `query_metrics(portfolio-service/displayed_value_total_cr)` | ok, 1 records | ok, 1 records |
| s09-A | mandate success split by bank | `query_metrics(mandate-service/mandate_success_rate)` | ok, 1 records | ok, 1 records |
| s09-A | bank-specific errors | `query_logs(bank-connector "mandates")` | ok, 100 records, match | partial, 85 records |
| s09-B | mandate success split by bank | `query_metrics(mandate-service/mandate_success_rate)` | ok, 1 records | ok, 1 records |
| s09-B | bank-specific errors | `query_logs(bank-connector "mandates")` | ok, 100 records, match | ok, 100 records |
| s10-A | pool exhaustion errors | `query_logs(order-service "pool")` | ok, 100 records, match | ok, 100 records |
| s10-A | the pool config change | `get_changes(order-service)` | ok, 1 records | ok, 1 records |
| s10-B | pool exhaustion errors | `query_logs(order-service "pool")` | ok, 100 records, match | ok, 100 records |
| s10-B | the pool config change | `get_changes(order-service)` | ok, 4 records | ok, 4 records |
| s11-A | the release record (offset-less timestamp) | `get_changes(mf-order-service)` | ok, 2 records | ok, 2 records |
| s11-A | error logs carrying the new version | `query_logs(mf-order-service "NullPointerException")` | ok, 100 records, match | ok, 100 records |
| s11-B | the release record (offset-less timestamp) | `get_changes(kyc-service)` | ok, 4 records | ok, 4 records |
| s11-B | error logs carrying the new version | `query_logs(kyc-service "serialization error")` | ok, 100 records, match | ok, 100 records |
| s12-A | auth-service logs for the window (missing/incomplete) | `query_logs(auth-service)` | ok, 54 records | ok, 54 records |
| s12-A | OTP success drop | `query_metrics(auth-service/otp_success_rate)` | ok, 1 records | ok, 1 records |
| s12-B | scripted fault "auth-logs-partial" | `query_logs(auth-service)` | - | partial, 10 records |
| s12-B | auth-service logs for the window (missing/incomplete) | `query_logs(auth-service)` | ok, 54 records | partial, 16 records |
| s12-B | OTP success drop | `query_metrics(auth-service/otp_success_rate)` | ok, 1 records | ok, 1 records |
| s13-A | scripted fault "metrics-timeout" | `query_metrics(payout-service/request_rate)` | - | **timeout** after 3 attempt(s) |
| s13-A | lock-wait logs from the batch | `query_logs(payout-service "lock")` | ok, 76 records, match | ok, 76 records |
| s13-A | blocking process in database logs | `query_logs(database "blocked by")` | ok, 48 records, match | ok, 48 records |
| s13-B | scripted fault "metrics-timeout" | `query_metrics(database/request_rate)` | - | **timeout** after 3 attempt(s) |
| s13-B | scripted fault "payout-metrics-partial" | `query_metrics(payout-service/request_rate)` | - | partial, 1 records |
| s13-B | lock-wait logs from the batch | `query_logs(payout-service "lock")` | ok, 65 records, match | ok, 65 records |
| s13-B | blocking process in database logs | `query_logs(database "blocked by")` | ok, 48 records, match | ok, 48 records |
| s14-A | scripted fault "webhook-metrics" | `query_metrics(kyc-service/webhook_received_per_min)` | - | **timeout** after 3 attempt(s) |
| s14-A | scripted fault "webhook-logs" | `query_logs(kyc-service "hook")` | - | **timeout** after 3 attempt(s) |
| s14-A | scripted fault "webhook-queue" | `query_metrics(message-queue/queue_depth)` | - | **unavailable** after 3 attempt(s) |
| s14-A | pending count rising | `query_metrics(kyc-service/kyc_pending_count)` | ok, 1 records | ok, 1 records (2 attempts) |
| s14-A | agency latency up | `query_metrics(kyc-service/agency_latency_p95_ms)` | ok, 1 records | ok, 1 records |
| s14-B | scripted fault "queue-metrics" | `query_metrics(message-queue/queue_depth)` | - | **timeout** after 3 attempt(s) |
| s14-B | scripted fault "webhook-metrics" | `query_metrics(kyc-service/webhook_received_per_min)` | - | **unavailable** after 3 attempt(s) |
| s14-B | scripted fault "kyc-logs" | `query_logs(kyc-service)` | - | partial, 4 records |
| s14-B | pending count rising | `query_metrics(kyc-service/kyc_pending_count)` | ok, 1 records | ok, 1 records |
| s14-B | agency latency up | `query_metrics(kyc-service/agency_latency_p95_ms)` | ok, 1 records | ok, 1 records (2 attempts) |
