---
description: Interrogate the concept brief before any design work
---

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
