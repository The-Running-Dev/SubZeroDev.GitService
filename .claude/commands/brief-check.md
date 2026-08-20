---
description: Interrogate the concept brief before any design work
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/brief-check-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

Read `design/00-brief.md`.

Your job is to find what is missing or load-bearing-but-unstated. You are not here to develop the idea, propose architecture, or tell me whether it is a good idea.

Produce exactly these four lists:

1. **Underspecified** — statements in the brief that admit more than one implementation with materially different cost. Quote the statement, name the readings.
2. **Implied non-goals** — things the brief obviously does not want but does not say. These are candidates to promote into the explicit non-goals list.
3. **Unstated assumptions about the environment** — scale, concurrency, data volume, network, single-user vs multi, offline, platform. Anything the design will silently assume if the brief stays quiet.
4. **Definition-of-done gaps** — what would have to be true for this to be finished, that the brief does not currently assert.

Rules:
- No architecture. No technology names. No solutions.
- Do not rewrite the brief. Output the lists only.
- If a list is empty, say so. Do not manufacture entries.

## Re-run

Writes nothing, so there is no state to skip or refresh — a re-run reads `design/00-brief.md`
fresh and produces new lists from scratch. Run again after every hand-edit to the brief; a
prior run's lists live only in that session's output and are not carried forward or treated as
already answered.
