# Coding-assistant transcript

The assignment allows AI coding assistants and asks for the transcript. Rootline was built
with Claude Code (Claude Opus 5.5).

## Included

- **The build session(s) for this repository.** The owner exports them with Claude Code's
  `/export` command and adds them to this folder. They cover reading the assignment, brief and
  spec; the approach and the issues raised about the brief; and building, testing and
  evaluating everything in this repository, in the order the brief sets out.

## Excluded, and why

- **Planning sessions** that produced `docs/brief.md` and `docs/spec.md`. They also touched
  unrelated private projects and infrastructure. Their outcome is in the repository: the brief
  and spec are committed as written.
- **Deployment sessions** for the hosted demo. Deployment was deliberately done in a separate
  session so that private hostnames, server details and credentials stay out of the submitted
  transcript.

## Review

The owner reviews every exported transcript for secrets and unrelated private material before
committing it. During the build session, credentials were only ever injected into processes by
the secrets manager (`doppler run ...`); no key, token or connection string was printed.
