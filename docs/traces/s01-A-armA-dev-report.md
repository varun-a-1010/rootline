<!-- Report produced by the live run in s01-A-armA-dev.md (dev phase, before the prompt freeze). -->

# Investigation report: Portfolio shows yesterday's values

**Outcome:** conclusive · **Stop reason:** critic_accepted · **Confidence:** 0.95 · **Written by:** reporting agent

## Summary
On the morning of 2026-10-14 around 09:10 IST (03:40 UTC), users reported that their portfolio holdings for mutual funds displayed stale, unchanged values from the previous day (2026-10-12), while equity stock values remained current. Investigation revealed that the nightly scheduled nav-import batch job failed at 23:32 IST (18:02 UTC) on 2026-10-13 when parsing NAVAll.txt from amfi-nav-feed due to an unhandled 'N.A.' value for scheme code 118191 at line 8982. The job aborted after writing 0 of 14,231 NAV records, leaving market-data-service serving NAVs from 2026-10-12 throughout the morning.

**Root cause:** The scheduled nav-import job in market-data-service aborted at 2026-10-13T18:02:00.000Z due to a parse error on encountering a non-numeric NAV value 'N.A.' for scheme code 118191 at line 8982 of the AMFI NAV feed file (NAVAll.txt). The parser aborted the entire batch without writing any records (0 of 14,231 written), leaving previous-day NAVs (2026-10-12) active in market-data-service and resulting in stale portfolio valuations on the morning of 2026-10-14.

## Hypotheses
1. **The scheduled nightly nav-import job in market-data-service aborted due to an unhandled 'N.A.' value for scheme code 118191 at line 8982 of NAVAll.txt, writing 0 of 14,231 records and leaving market-data-service serving stale NAVs from 2026-10-12.** — `market-data-service`, data_pipeline_failure, confidence 0.85, supported
   - Supporting: [ev_6, ev_7, ev_13, ev_15, ev_18, ev_19, ev_20, ev_21, ev_22, ev_23, ev_24, ev_25, ev_26] · Contradicting: none
   - Logs directly show the scheduled nav-import job failing at 18:02 UTC with an unhandled 'N.A.' parse error on scheme code 118191 at line 8982, aborting with 0 of 14,231 records written. Metrics confirm nav_age_s grew monotonically past 125,000s without resetting, and market-data-service served nav_date=2026-10-12 throughout the night and morning.
2. **Upstream external feed amfi-nav-feed published an invalid non-numeric 'N.A.' entry in NAVAll.txt, violating expected schema and inducing parser failure.** — `amfi-nav-feed`, upstream_dependency_degradation, confidence 0.15, plausible
   - Supporting: [ev_19, ev_21, ev_22] · Contradicting: none
   - The AMFI feed provided 'N.A.' for scheme code 118191. However, robust data ingestion pipelines are expected to handle missing, suspended, or unannounced scheme NAVs without failing the entire batch of 14,231 funds.
3. **Deployment CHG-48221 on portfolio-service at 03:40 UTC (version 7.2.0 to 7.3.0) introduced a regression in valuation calculation logic.** — `portfolio-service`, deployment_regression, confidence 0.00, ruled_out
   - Supporting: [ev_3] · Contradicting: [ev_1, ev_5, ev_7, ev_13, ev_27]
   - Portfolio-service was already logging warnings about NAVs older than 1 trading day (nav_date=2026-10-12) as early as 02:16 UTC, well before the 03:40 UTC deployment. Furthermore, valuation error rates remained near zero and stock pricing latency remained nominal (~2s).

## Facts
- At 2026-10-13T18:00:00.000Z (23:30 IST), job-scheduler triggered the scheduled job nav-import (run_7fadae4b). [ev_19, ev_22]
- At 2026-10-13T18:01:00.000Z, market-data-service downloaded NAVAll.txt (1980 KB) from amfi-nav-feed. [ev_19]
- At 2026-10-13T18:02:00.000Z, market-data-service logged an ERROR: 'nav-import: parse error at line 8982: invalid NAV value 'N.A.' for scheme code 118191'. [ev_21]
- At 2026-10-13T18:02:06.000Z, market-data-service logged an ERROR: 'nav-import: aborting import; 0 of 14231 NAVs written, previous NAV set remains active', and job-scheduler logged that nav-import failed with exit code 1 at 18:06:00.000Z. [ev_21]
- Between 2026-10-13T17:00:00.000Z and 2026-10-14T05:00:00.000Z, market-data-service nav_age_s grew monotonically from 82,440 seconds to over 125,460 seconds (~34.8 hours) with zero resets. [ev_7, ev_18, ev_20, ev_23, ev_24]
- Between 2026-10-13T18:10:00.000Z and 2026-10-14T05:00:00.000Z, no subsequent runs or retries of nav-import occurred. [ev_4, ev_8, ev_26]
- At 2026-10-14T02:16:24.606Z, portfolio-service logged warnings stating 'fund NAV older than 1 trading day for 3 holdings (nav_date=2026-10-12); showing last available NAV'. [ev_13]
- Portfolio-service was deployed at 2026-10-14T03:40:00.000Z under CHG-48221 (version 7.2.0 -> 7.3.0), while stock price_age_s remained steady at ~2.01s and valuation_errors averaged less than 1 error/min. [ev_1, ev_3, ev_5, ev_27]

## Inferences
- The user-facing symptom of portfolios showing previous day's fund values was caused by market-data-service serving NAVs dated 2026-10-12 because the 2026-10-13 import completely aborted. [ev_6, ev_7, ev_13, ev_15, ev_21]
- The portfolio-service deployment CHG-48221 at 03:40 UTC (09:10 IST) coincided with user complaints solely because market open and user app logins peak at 09:10 IST, not because the deployment caused the staleness. [ev_3, ev_13]
- The NAV import failure went undetected overnight due to the lack of automated retries or alerting on the job-scheduler failure exit code 1 or nav_age_s threshold breaches. [ev_21, ev_23, ev_25, ev_26]

## Assumptions
- AMFI periodically publishes 'N.A.' for fund schemes undergoing corporate actions, closure, or delayed valuation.
- A batch ingestion job should skip, log, or nullify individual erroneous records rather than aborting all 14,231 records in the daily feed.

## Timeline
- **2026-10-13T18:00:00.000Z (23:30 IST)** job-scheduler initiates nightly nav-import job run_7fadae4b. [ev_19, ev_22]
- **2026-10-13T18:01:00.000Z (23:31 IST)** market-data-service successfully downloads NAVAll.txt (1980 KB) from amfi-nav-feed. [ev_19]
- **2026-10-13T18:02:00.000Z (23:32 IST)** market-data-service encounters parse error on line 8982: invalid NAV value 'N.A.' for scheme code 118191. [ev_21]
- **2026-10-13T18:02:06.000Z (23:32 IST)** market-data-service aborts import with 0 of 14,231 NAVs written, leaving 2026-10-12 NAV dataset active. [ev_21]
- **2026-10-13T18:06:00.000Z (23:36 IST)** job-scheduler records nav-import job failure with exit code 1; no automated retry triggered. [ev_21, ev_25, ev_26]
- **2026-10-14T02:16:24.000Z (07:46 IST)** portfolio-service begins logging warnings that fund NAV is older than 1 trading day (nav_date=2026-10-12). [ev_13]
- **2026-10-14T03:40:00.000Z (09:10 IST)** CHG-48221 deploys portfolio-service v7.3.0; market opens and users open app, noticing stale mutual fund values. [ev_3, ev_13]
- **2026-10-14T04:10:00.000Z (09:40 IST)** Customer support logs INC-2249 reporting stale portfolio values. [ev_13]

## Confidence
0.95: Direct log and metric evidence from market-data-service and job-scheduler precisely pinpoint the time, file, line number, scheme code, and error message causing the batch abort, while ruling out portfolio-service and caching issues.

## Gaps
- Historical AMFI NAVAll.txt files were not queried to verify frequency of 'N.A.' strings in AMFI feeds. (impact: Minimal; the parser behavior and failure point are explicitly detailed in application error logs.)
- Source code review of market-data-service parser was not performed within tool budget. (impact: Low; the error message explicitly identifies that 'N.A.' is treated as an unhandled invalid value.)

## Recommended actions (not executed)
- **[now]** Manually trigger nav-import for NAVAll.txt with a script or hotfix that skips or handles 'N.A.' entries to refresh mutual fund NAVs immediately. [ev_2, ev_7, ev_13, ev_21]
  - Why: Restores current NAV values for mutual fund holdings, resolving customer-facing portfolio staleness.
  - Verify: Check market-data-service nav_age_s resets to <3600s and portfolio-service stops logging stale NAV warnings.
- **[next]** Update market-data-service NAVAll.txt parser to gracefully handle non-numeric NAV values such as 'N.A.', logging a warning for the specific scheme code while committing the remaining valid NAVs. [ev_21]
  - Why: Prevents a single invalid or missing scheme value from aborting the entire daily batch of over 14,000 schemes.
  - Verify: Run parser unit and integration tests containing 'N.A.' values and verify batch completes successfully.
- **[next]** Configure alerting on job-scheduler exit code != 0 for nav-import and on market-data-service nav_age_s exceeding 86,400 seconds (24 hours). [ev_21, ev_23, ev_25]
  - Why: Ensures on-call engineers are alerted immediately when nightly imports fail rather than discovering the issue at morning market open.
  - Verify: Simulate job failure in staging and confirm alert fires to PagerDuty/Slack within 15 minutes.
- **[later]** Implement automated retry with exponential backoff in job-scheduler for nav-import. [ev_2, ev_26]
  - Why: Allows transient network or file publication issues to recover automatically without manual intervention.
  - Verify: Inspect job-scheduler configuration to ensure retry policy is active and verified in staging.

Cited evidence: ev_1, ev_2, ev_3, ev_4, ev_5, ev_6, ev_7, ev_8, ev_13, ev_15, ev_18, ev_19, ev_20, ev_21, ev_22, ev_23, ev_24, ev_25, ev_26, ev_27
Investigation window: 2026-10-14 07:30 IST to 2026-10-14 10:30 IST
