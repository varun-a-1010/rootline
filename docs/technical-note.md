# Technical note

**What it is.** Rootline investigates incidents in a fictional Indian investing app. An orchestrator plans parallel tasks; observability and dependency specialists query five fault-injected tools; a reasoning agent ranks hypotheses; a critic challenges them and requests follow-up checks; a reporting agent writes a cited report, which may be inconclusive.

**Key decisions.** There is no agent framework: a small scheduler and an event-sourced log make coordination inspectable, and state, persistence, the UI and scoring all derive from that log. Models propose and code governs: plans, follow-ups, citations and stop reasons are validated in code, and a conclusive report needs critic acceptance or a justification. Evidence ids are minted by the tool runner, never by models. Faults key on the request and attempt number, so every arm meets the same ones.

**Results.** Five orchestrations ran once each on 28 worlds (14 scenarios, two variants) using Gemini 3.8 Flash. On root cause, the multi-agent design earned 21.5/24 and the single-agent baseline 20/24, which is within noise. Only 3 of 17,099 citations were invalid.

The multi-agent design did not clearly win. It cost more ($0.51 against $0.42 per run at list rates) and was no faster (225 s against 220 s). The weakest result is abstention: on scenarios that should end inconclusive, 15 of 20 runs across all arms gave a definite diagnosis. Arm A abstained correctly 0 of 4 times and the baseline 2 of 4, one of them forced by the code's honesty rule. Critics accepted all ten unsupported diagnoses, usually by elimination. The critic did raise required-evidence recall (94.6% against 82.1%), at 57% more cost and without measurable accuracy gain. Jev assistance did not reduce cost.

**Trade-offs.** Parallel specialists isolate context but lose prompt caching: the baseline's single conversation was 84% cached, against 24% for arm A, so it sent over three times the input and still cost less. Caching needs a matching request, and each synthesis agent has its own schema, so those agents ran effectively uncached. Raising evaluation concurrency finished sooner but failed 8.6% of runs against 1.2%, which understates arms B, C and D. Failed runs stayed failed.

**Limitations.** The data is synthetic. Labels were reviewed by the agent that wrote them and the prompts, not by a human. One run per case measures no variance. The model judge stopped after 26 of 140 runs on a billing error, so claim support is unmeasured. Post-evaluation changes gave no measurable saving on a four-scenario check, though they added recovery from failed plan calls, so shipped code differs from the evaluated commits.

**Improvements.** Enforce abstention in code: require direct evidence of the mechanism, reject diagnosis by elimination, and treat missing logs as blocking. Give the critic that rule, not just a prompt. Add repeated runs and human-reviewed labels, and test on real telemetry.
