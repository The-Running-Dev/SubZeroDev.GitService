---
description: Turn a rough ask into a prompt carrying this repository's binding constraints. Usage - /refine make install handle an occupied design folder
argument-hint: <rough ask>
---

<!-- companion:start -->
**Per-repo companion:** `.claude/commands/refine-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:end -->

Turn **$ARGUMENTS** into a prompt that carries the constraints this repository actually binds an agent to.

The value here is not better wording. It is that you do not have to remember which decision, non-goal, or lesson applies before you ask for something. Generic prompt refinement is available elsewhere and is not what this is for.

## Route away first

**If an existing command already covers the ask, name it and stop.** Do not refine. A front door that everything passes through is a cost paid on every request, and most asks in this repository belong to a command that already exists:

| The ask is about | Use |
|---|---|
| Which stage this is, or what to run next | `/kit-help` |
| Whether the brief is sound | `/brief-check` |
| Architecture, data model, failure modes | `/design` |
| Types, schemas, signatures, errors | `/contract` |
| Breaking work into units | `/slices` |
| Implementing a defined unit | `/slice S<n>` |
| Whether the code and the docs still agree | `/reconcile` |
| Running this repository's gates | `/verify` |
| Issues, milestones, anything on GitHub | `/track` |
| Opening a pull request | `/pr` |
| Review comments on a pull request | `/resolve` |
| Putting the kit into a repository | `/install` |

Refine only what falls between them — a change to the kit's own files, a question about the tooling, a fix that is not a slice, a one-off task with no upstream document.

## Gather only what changes the work

Read `AGENTS.md` and the files the ask actually touches. Then ask **at most three questions**, and only ones whose answers change what gets built. A question whose every answer produces the same prompt is noise.

Ask when:

- Two readings of the ask imply materially different work.
- The ask would touch a rule, a public interface, or a schema, and it is unclear whether that is intended.
- Something already answers the ask and it is unclear whether you mean to change that answer.

Do not ask for information you can read. Do not interrogate the idea — that is `/brief-check`, and it operates on a brief, not on an ask.

## Emit

Fixed template. Fill the fields; do not compose prose around them. The shape is the point — it mirrors a slice block in `design/30-slices.md`, so what you get back is checkable the same way.

```
Read:      <files, completely, not from a diff>
Tier:      <model, effort> — AGENTS.md § Command routing
Binding:   <each constraint that genuinely applies, one line, with its source>
Task:      <the ask, sharpened by the answers>
Out of scope: <the adjacent thing an agent will be tempted to also do>
Ends:      <the deliverable — a proposal, a commit, a report>
```

Rules for the fields:

- **`Binding` carries only constraints you have read, each naming where it lives.** `AGENTS.md` § *Verification* forbids asserting what a command could confirm, and that applies to this command's own output — a plausible-sounding rule with no source is the failure mode here, because the emitted prompt is trusted precisely for carrying rules the reader did not look up.
- **Three or four binding lines, not ten.** Everything in `AGENTS.md` applies to every session already. List what is easy to miss for *this* ask: a non-goal in `design/00-brief.md`, a decision in `design/90-decisions.md`, a lesson in `agent.md` that cost something here.
- **`Out of scope` is the single most effective line.** If nothing is genuinely adjacent, write `nothing adjacent`, do not invent a boundary.
- Where `design/` does not exist — an install may legitimately skip it — cite `AGENTS.md` and whatever instruction file the repository does have. Say which sources you had.

## Emit; do not execute

Hand back the prompt. **Do not then run it in this session.**

The reason is mechanical, not ceremonial: this command runs at `sonnet`/`medium`, the emitted `Tier` is frequently something else, and an agent cannot change its own session model (`AGENTS.md`, *Division of control*). Running it here would silently execute at the wrong tier the prompt itself just named.

Close by saying which session to run it in. If the emitted tier matches the current session, say so and offer — one line, no argument.

## Variants

If asked for variants, emit **three scopings of the same ask**, not three wordings:

- **Minimal** — the smallest change that satisfies it, and what it leaves unsolved.
- **As asked** — the literal reading.
- **Thorough** — what it implies once done properly, and what that costs.

Scope is what goes wrong, not phrasing. Three rewordings of one prompt are three ways to ask for the same mistake.

## Stop conditions

Halt and say so rather than refining:

- The ask contradicts a non-goal in `design/00-brief.md`. **Non-goals are binding** — refining it into a well-formed prompt is helping it past the gate.
- The ask contradicts a recorded decision in `design/90-decisions.md`. Name the entry and ask, do not quietly route around it.
- The ask is an architectural or contract change. Say which command owns it. Do not escalate your own reasoning to cover it.
- Two readings are both defensible and the answer did not resolve them. Present both.

## Never

- Never put a constraint in `Binding` that you did not read in a file in this repository.
- Never widen the ask. A vague request becomes precise, not larger.
- Never write to `design/`, to `agent.md`, or to the tracker. This command emits text and nothing else.
- Never emit more than about fifteen lines. A prompt long enough to need skimming has reproduced the problem it was meant to solve.

## Re-run

Stateless — nothing it emits is stored, so a re-run on the same ask re-derives the prompt from
`AGENTS.md`, `design/`, and `agent.md` as they stand now, not from a remembered prior emission.
A constraint lifted since the last run drops out of `Binding`; one added since shows up. It
never treats a prior refinement of the same ask as already answered.
