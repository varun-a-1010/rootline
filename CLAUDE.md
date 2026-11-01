# Rootline — agent instructions

Rootline is a multi-agent production-incident investigator built for an AI Engineer
take-home assignment. **This repository is public, and the coding-assistant transcript is
part of the submission.**

## Read first, every session
1. `docs/assignment.md` — the company's requirements. They are the source of truth.
2. `docs/brief.md` — decisions, contracts, scope and order of work. It overrides the spec.
3. `docs/spec.md` — the original design proposal, for rationale.

## Rules
- **Public repo hygiene.** Never commit secrets, credentials, private hostnames or IPs, or
  details of unrelated private projects. Private operational notes live in
  `CLAUDE.local.md` and `DEPLOY.local.md`, which are gitignored. Never quote them into
  tracked files.
- **The transcript is submitted.** Keep the session on this project and explain decisions as
  you make them.
- **Commit each coherent, tested slice and push to `main`.** Never leave finished work only in
  the working tree.
- **Code-level verification only:** typecheck, lint, tests and CLI runs. Don't open browsers
  or do visual QA; the owner does that.
- **Every number in the README or docs comes from a committed file under `eval/results/`.**
  Never invent, round favorably or hand-edit results. Failed runs count as failed.
- **No scenario-specific logic in `src/`.** Nothing under `src/` may import `scenarios/` or
  `eval/`. A test enforces this.
- **Deployment is out of scope for build sessions.**
