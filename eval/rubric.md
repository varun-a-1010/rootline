# Scoring rubric

Frozen before the first held-out evaluation run (the freeze is recorded in
`eval/results/freeze.json` with the prompt hash). Implemented in `eval/score.ts` (deterministic)
and `eval/judge.ts` (model judge). Labels live in `eval/labels/` and were written with the
scenarios, before any evaluation run.

## Which runs count

Every recorded run in `eval/runs/` whose prompt hash equals the frozen hash. Crashed runs count
as failed: they score zero and are never silently rerun. Runs made before the freeze are listed
as excluded.

## Root-cause accuracy (deterministic, conclusive scenarios only)

- The report's hypotheses are ranked; `ruled_out` ones are skipped. The top hypothesis's
  `(component, causeType)` is compared with the label's acceptable causes. A cause matches when
  the component is one of its listed components and the cause type is one of its listed cause
  types (equivalent framings are listed in the label, e.g. `llm-provider` or
  `assistant-orchestrator` for quota throttling).
- **Credit is given only when the report commits to `conclusive`.** An `inconclusive` or `failed`
  report on a conclusive scenario is a *false abstention* and scores 0, whatever its top
  hypothesis. The top-hypothesis match regardless of outcome is reported separately.
- `top1_any` (all single-cause scenarios): 1 if the top hypothesis matches an acceptable cause;
  otherwise the best labeled partial credit that matches (e.g. 0.5 for naming the right
  component with the symptom-level cause type); otherwise 0.
- `top2_all` (s05, two causes): 1 if the top two hypotheses cover both acceptable causes with
  distinct hypotheses; 0.5 if the top hypothesis matches one of them; otherwise 0.
- Supplementary: top-2 hit (an acceptable cause among the top two hypotheses).

## Inconclusive handling (s12, s14)

- Correct abstention: outcome `inconclusive`.
- Unsupported definitive diagnosis: outcome `conclusive` (any cause).
- `failed` outcomes are neither and are listed as other.
- False abstentions on conclusive scenarios are reported under root cause (above).

## Evidence grounding

- **Fabricated-citation rate (deterministic):** evidence ids cited by any agent that do not exist
  in the run's ledger, divided by all evidence ids cited (valid + invalid). Counted from
  `citation.invalid` events and the citations in `agent.output` events. "Facts stated without
  evidence" are counted separately.
- **Required-evidence recall (deterministic):** share of the label's required evidence items that
  the run actually retrieved: an evidence record with the same tool and service (and metric),
  non-empty, whose excerpt or request contains the labeled text.
- **Claim support (judge):** for each fact in the report, the judge answers whether the excerpts
  of the evidence it cites entail it. Reported as supported / assessed.
- **Key counterevidence addressed (judge):** for each counterevidence item in the label, whether
  the report addresses it.

## Mechanism agreement (judge)

For conclusive scenarios, the judge answers whether the report's top cause describes the same
mechanism as the label. Reported next to the deterministic root-cause score, with agreement
between the two and every disagreement listed.

## Judge

The judge is Jev (`typesafe/jev-1.13`), a different model family from the agents, so Gemini does
not grade Gemini. It is blind to the arm: its inputs contain no arm, run id or orchestration
details. Before judging, it is validated on `eval/judge-validation/items.json` (labeled by the
coding agent, not by a human) and the agreement is reported. Jev also acts inside arm D; that
overlap is disclosed with every judged number.

## Efficiency (from the event log)

- Tool calls, attempts, retries, failures and partial results per run.
- Latency: wall clock from `run.created` to `run.terminated`, plus per-role task time.
- Tokens: input, output, thinking and cached per run, by role, from provider-reported usage.
  Unknown usage is shown as unknown, never as zero.
- Cost: an estimate at the standard rates in `src/llm/pricing.ts`; tokens are the primary measure.

## Comparing arms

With 14 scenarios (28 worlds), small differences are noise. Results report counts, not just
percentages, show dev and held-out separately, and include a paired comparison on the cases
every arm ran. A difference is only described as a difference when the counts clearly show it.
