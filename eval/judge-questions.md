# Judge questions (Jev)

All questions are Noul (probability that a proposition is true). A probability >= 0.5 counts as
"yes". The judge's state never contains the arm, run id, or anything about the orchestration.

## mechanism_agreement (one per conclusive run)

- State: `reference_mechanism` (from the label), `report_top_cause` (cause text, component, cause
  type), `report_root_cause_statement`.
- Question: "Does the report's top cause describe the same causal mechanism as the reference
  mechanism (the same faulty component and the same thing going wrong), even if worded
  differently?"
- Criteria: true = "same mechanism"; false = "a different mechanism, only a symptom, or only a
  coincidental change".

## claim_support (one per fact in a report)

- State: `claims` (each fact's statement and cited evidence ids) and `evidence` (the excerpts of
  every cited evidence record, as the agents saw them).
- Question per claim: "Do the excerpts of the evidence cited by claim <id> entail its statement?"
- Criteria: true = "the cited excerpts directly show it"; false = "the excerpts do not show it,
  or show something else".

## counterevidence_addressed (one per labeled counterevidence item)

- State: the report's summary, root-cause statement, ranked hypotheses with rationales, facts,
  inferences and gaps.
- Question per item: "Does the report address this point: <item>?" (address = states it, rules out
  the alternative using it, or explicitly discusses it).
- Criteria: true = "addressed"; false = "not addressed".
