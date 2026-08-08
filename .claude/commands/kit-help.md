---
description: Where this repository is in the pipeline, and what to run next. Usage - /kit-help, or /kit-help all
argument-hint: [all, or a stage or command name]
---

Orient the user in this repository's pipeline. **$1** narrows it — `all` shows the whole flow, a stage or command name shows that step. With nothing, work out where the repository actually is and show the current step and the next one.

**Do not dump this whole file back.** It is a map you read, not a message you echo. Reciting eleven steps to someone who needs the next one is the mechanical text work `AGENTS.md` says should not be a model's job at all — and here, unlike a script, you can tell which step they are on.

## Orient first

```powershell
Get-ChildItem design -Filter *.md -ErrorAction SilentlyContinue | Select-Object Name, Length
git branch --show-current
git log -3 --oneline
gh issue list --state all --limit 100 --json number,title,state 2>$null
```

Read it this way, and say which signal you used:

- **No `design/` at all** — the kit is installed but nothing has started. Stage 0.
- **`00-brief.md` only** — stage 1. An empty or near-empty file is not a brief; say so rather than counting it.
- **Each further doc present** — the stage after the last one written. `30-slices.md` present means stage 6.
- **On the default branch with slices written** — the next move is a branch, not a command.
- **The tracker** decides where inside stage 6 they are: no issues means `/track` has never run; an open issue with unticked boxes is the slice in flight.

State it in one line — *"stage 6, S4 open with S4.2 unticked, on `main`"* — then the step. If the evidence is genuinely ambiguous, say what you found and ask rather than picking.

## The flow

This is the canonical copy. `README.md` summarises the shape and points here.

**Which model runs each command is in `AGENTS.md`, *Command routing*. Where a session must end is in `AGENTS.md`, *Session boundaries*.** Both are binding policy with one home, and it is not this file — the `fresh` and `same session` tags below are a convenience, and if they ever disagree with `AGENTS.md`, that file is right and this one has drifted.

### Once per project — stages 0 to 5

Each is its own session. Every one ends in a committed file, and that file is what the next stage reads.

| # | Step | Session | Ends when |
|---|---|---|---|
| 0 | Write `design/00-brief.md` **yourself** | — | Problem, non-goals, definition of done, and a `Lifespan` line are all real |
| 1 | `/brief-check` | fresh | The four lists come back thin. It writes nothing — **you** edit the brief from them |
| 2 | `/design` | fresh | `10-design.md` has rejected alternatives in every section that needed a choice |
| 3 | `/redteam` | fresh, **different vendor** | One pass, adjudicated. Never ask for another |
| 4 | `/contract` | fresh | `20-contract.md` has no `## Unresolved` section left |
| 5 | `/slices` | fresh | The `Delivers:` lines read as a set, and no slice is too big for one session |
| — | `/track` | fresh | One issue per slice. Idempotent — run it whenever `design/` changes |

Stages 1 and 3 write nothing, so their output exists only in that session. Act on it before the session ends.

Three of these stop rather than proceed, and that is the cheapest failure available: `/design` stops if the brief is too thin, `/contract` stops on a signature the design does not determine, and `/redteam` produces findings but never a fix. Sending work back a stage costs a few thousand tokens; discovering it in stage 6 costs a re-implementation.

### Per slice — stage 6, on repeat

One slice, one branch, one session. Do not start slice N+1 because you noticed something in slice N — that goes in `90-decisions.md` under `## Open`, and `/track` turns it into an issue.

1. **Branch.** `/pr` refuses to open from the default branch.
2. **`/slice S3`**, or bare **`/slice`** for the lowest-numbered slice that is neither closed nor fully ticked and whose dependencies are done. Criteria stated by id, failing tests first, implemented against the contract, ending with the ids it believes are met.
3. **You tick the boxes.** Deliberately not the agent's to do — "S3.1 met" and a ticked box are different claims by different parties.
4. **`/verify`** — same session. Discovers the gates from CI and reports three lists; the one that matters is *did not run*. It fixes nothing.
5. **Commit, then push.** Named paths only, and push before announcing anything.
6. **`/pr`** — same session, because the description must carry `/verify`'s did-not-run list **verbatim**.
7. **`/resolve`** — same session, once review lands. Fixed order: fix → push → confirm checks on the **new** head → only then resolve.
8. **Merge** — the user's, unless this repository's instruction file explicitly delegates it.
9. **`/track`** — **new session**, after the merge.

Then back to 1 for the next slice.

### When the slices run out

- **`/reconcile`** — fresh session. Reports contract drift, design drift, undocumented decisions, invalidated assumptions, and proposed `agent.md` lessons; the user decides each direction and it applies the edits after. This is the step that stops the docs becoming fiction.
- **`/make-human-docs`** — generates the guide from the design docs. Never hand-edit the result; `/reconcile` checks it for semantic drift.

### If the ask fits none of that

**`/refine`.** Every other command assumes you are already inside the pipeline. It routes the ask to the command that owns it where one exists, and otherwise emits a prompt carrying the constraints that bind it — for the user to run at the tier it names.

### Skipping most of it

For something short-lived, the honest minimum is `00-brief.md` with real non-goals, `20-contract.md`, and `/slice`. Skip 1, 2, 3, 7, 8. The `Lifespan` line in the brief exists to force that call before the work starts rather than after.

## Answering

- **Name the next command, its tier from `AGENTS.md`, and whether it needs a fresh session.** That is the whole answer most of the time.
- **Do not run the next command.** This orients; it does not act. Ending a session may be the next step, and a command that starts work cannot tell the user to start a new session for it.
- **Do not invent a step, a stage, or a tier.** If something here does not cover the situation, say so — an invented step in a help command is the one that gets followed.
