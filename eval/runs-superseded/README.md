# Superseded runs

These runs are kept for transparency and their cost counts toward the budget, but they are not scored.

**Why they were redone.** The freeze added a final `submit_report` turn for the baseline at the deadline. That turn put its notice inside the function-response turn, which Vertex rejects (`400 Requests ending with a model turn are not supported`). So every baseline run that reached the deadline lost its final report and ended `failed` with a code-built report, through an engine bug and not through the agent's investigation. That made the headline comparison unfair to the baseline.

**What changed.** The notice is now its own user turn. `ScriptedProvider` rejects the conversations Vertex rejects, and reintroducing the bug fails `test/arms.test.ts`. Multi-agent arms never use this path, so no other run was affected.

| Run | Estimated cost |
| --- | --- |
| s01-B-E-r1.json | $0.223 |
| s06-B-E-r1.json | $0.359 |
