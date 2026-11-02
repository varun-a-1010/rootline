# Evaluation summary (generated)

Generated 2026-11-02T02:22:13.174Z by `eval/summarize.ts` from `eval/runs/`. Do not edit by hand.

Prompt freeze: hash `fbb5303b5fc5eeaa` at 2026-11-01T21:14:33.318Z (git 213ad08); arm D base: B.
Model: gemini-3.8-flash; Jev: typesafe/jev-1.13; thinking: medium; fixtures: `e19d58a023270bc3`; node v24.15.0; darwin 25.4.0 Apple M5 Pro x18.
Runs: 140 included, 0 excluded (pre-freeze), 0 crashed, 2 superseded and redone (see eval/runs-superseded/README.md). Estimated spend over all recorded runs: $74.619 (scored $64.173, dev $9.864, superseded $0.582).

## By arm (all included runs)

| Metric | Arm A | Arm B | Arm C | Arm D | Arm E |
| --- | --- | --- | --- | --- | --- |
| Runs | 28 | 28 | 28 | 28 | 28 |
| Root-cause accuracy (credit / conclusive cases) | 21.5 / 24 (89.6%) | 21.5 / 24 (89.6%) | 21 / 24 (87.5%) | 20.5 / 24 (85.4%) | 20 / 24 (83.3%) |
| Top hypothesis matches (any outcome) | 22 / 24 | 23 / 24 | 22 / 24 | 23 / 24 | 21 / 24 |
| Top-2 hit | 22 / 24 | 23 / 24 | 22 / 24 | 23 / 24 | 21 / 24 |
| False abstentions (conclusive cases) | 0 | 1 | 1 | 2 | 0 |
| Correct abstentions (inconclusive cases) | 0 / 4 | 0 / 4 | 0 / 4 | 0 / 4 | 2 / 4 |
| Unsupported definitive diagnoses | 3 | 3 | 3 | 4 | 2 |
| Fabricated-citation rate | 0.0% (1/4353) | 0.0% (2/4100) | 0.0% (0/2950) | 0.0% (0/4090) | 0.0% (0/1606) |
| Facts stated without evidence | 0 | 1 | 0 | 0 | 0 |
| Required-evidence recall (mean) | 94.6% | 96.4% | 82.1% | 96.4% | 96.4% |
| Tool calls per run (mean, min-max) | 24.357 (17-40) | 24.607 (12-40) | 17.214 (0-24) | 25.929 (14-40) | 29.5 (8-40) |
| Tool attempts / retries / failures / partials per run | 27.357 / 3 / 0.893 / 1.571 | 28.5 / 3.893 / 1.143 / 1.857 | 19.857 / 2.643 / 0.643 / 0.893 | 29.643 / 3.714 / 1 / 1.786 | 34.607 / 5.107 / 1.821 / 2.286 |
| Model calls per run | 28.429 | 29.857 | 18.714 | 29.5 | 25.964 |
| Latency s (mean, median, min-max) | 224.793, 193.258 (98.872-448.973) | 266.675, 229.452 (128.417-480.005) | 153.088, 134.728 (90.674-361.735) | 259.084, 261.193 (123.81-480.017) | 220.326, 191.391 (111.538-404.005) |
| Input tokens per run (mean) | 254342.536 | 255833.964 | 168792.929 | 254477.5 | 874019.143 |
| Output tokens per run (mean) | 12783.75 | 12968.893 | 8861.357 | 13322.857 | 5519.714 |
| Thinking tokens per run (mean) | 15473.893 | 16110.214 | 9407.679 | 17666.357 | 8084.643 |
| Cached input tokens per run (mean) | 61564.071 | 64915.071 | 49040.25 | 66130.857 | 738349.964 |
| Calls with unknown usage | 0 | 0 | 0 | 0 | 0 |
| Jev calls / questions per run | 0 / 0 | 0 / 0 | 0 / 0 | 5.179 / 131.929 | 0 / 0 |
| Est. cost per run (USD, standard rates) | $0.51 | $0.514 | $0.324 | $0.527 | $0.416 |
| Critic rounds / follow-ups per run | 1.5 / 1.929 | 1.143 / 1.357 | 0 / 0 | 1.286 / 1.571 | 0 / 0 |
| Stop reasons | critic_accepted: 26, deadline: 2 | critic_accepted: 19, deadline: 8, critic_insufficient_evidence: 1 | completed: 26, unrecoverable_error: 2 | critic_accepted: 22, deadline: 6 | completed: 20, budget_tool_calls: 6, deadline: 2 |

## Paired comparison on the 28 cases every arm ran

| Metric | Arm A | Arm B | Arm C | Arm D | Arm E |
| --- | --- | --- | --- | --- | --- |
| Root-cause accuracy | 21.5 / 24 (89.6%) | 21.5 / 24 (89.6%) | 21 / 24 (87.5%) | 20.5 / 24 (85.4%) | 20 / 24 (83.3%) |
| Correct abstentions | 0 / 4 | 0 / 4 | 0 / 4 | 0 / 4 | 2 / 4 |
| Tool calls (mean) | 24.357 | 24.607 | 17.214 | 25.929 | 29.5 |
| Latency s (mean) | 224.793 | 266.675 | 153.088 | 259.084 | 220.326 |
| Input / output+thinking tokens (mean) | 254342.536 / 28257.643 | 255833.964 / 29079.107 | 168792.929 / 18269.036 | 254477.5 / 30989.214 | 874019.143 / 13604.357 |
| Est. cost per run | $0.51 | $0.514 | $0.324 | $0.527 | $0.416 |

## By split

- Arm A: dev 5/5 root cause, 0/1 abstentions; held-out 16.5/19 root cause, 0/3 abstentions.
- Arm B: dev 5/5 root cause, 0/1 abstentions; held-out 16.5/19 root cause, 0/3 abstentions.
- Arm C: dev 4/5 root cause, 0/1 abstentions; held-out 17/19 root cause, 0/3 abstentions.
- Arm D: dev 4/5 root cause, 0/1 abstentions; held-out 16.5/19 root cause, 0/3 abstentions.
- Arm E: dev 5/5 root cause, 1/1 abstentions; held-out 15/19 root cause, 1/3 abstentions.

## Per case

| Case | Split | Expected | Arm A | Arm B | Arm C | Arm D | Arm E |
| --- | --- | --- | --- | --- | --- | --- | --- |
| s01-A | dev | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s01-B | heldout | conclusive | ✗ | ✗ | ½(0.5) | ✗ | ✗ |
| s02-A | dev | conclusive | ✓ | ✓ | ✓ | ✗ inconclusive | ✓ |
| s02-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s03-A | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s03-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s04-A | dev | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s04-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s05-A | heldout | conclusive | ½(0.5) | ✓ | ½(0.5) | ✓ | ½(0.5) |
| s05-B | heldout | conclusive | ½(0.5) | ½(0.5) | ✓ | ½(0.5) | ½(0.5) |
| s06-A | dev | conclusive | ✓ | ✓ | ✗ inconclusive | ✓ | ✓ |
| s06-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✗ |
| s07-A | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s07-B | heldout | conclusive | ✓ | ✗ inconclusive | ✓ | ✓ | ✓ |
| s08-A | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s08-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s09-A | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s09-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s10-A | heldout | conclusive | ½(0.5) | ✓ | ✓ | ✓ | ✓ |
| s10-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s11-A | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s11-B | heldout | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s12-A | dev | inconclusive | ✗ diagnosed | ✗ diagnosed | ✗ inconclusive | ✗ diagnosed | ✓ abstain |
| s12-B | heldout | inconclusive | ✗ diagnosed | ✗ diagnosed | ✗ diagnosed | ✗ diagnosed | ✗ diagnosed |
| s13-A | dev | conclusive | ✓ | ✓ | ✓ | ✓ | ✓ |
| s13-B | heldout | conclusive | ✓ | ✓ | ✗ | ✗ inconclusive | ✗ |
| s14-A | heldout | inconclusive | ✗ inconclusive | ✗ diagnosed | ✗ diagnosed | ✗ diagnosed | ✓ abstain |
| s14-B | heldout | inconclusive | ✗ diagnosed | ✗ inconclusive | ✗ diagnosed | ✗ diagnosed | ✗ diagnosed |

Legend: ✓ full root-cause credit; ½(x) partial credit; ✗ wrong top cause; "inconclusive"/"failed" after a mark = the run did not commit to a cause (no credit); for inconclusive cases ✓ abstain / ✗ diagnosed. Repetitions are separated by "/".
