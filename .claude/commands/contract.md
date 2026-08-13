---
description: Derive the interface contract from the design doc
---

<!-- companion:start -->
**Per-repo companion:** `.claude/commands/contract-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`, `extra-steps`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:end -->

## Stop if `design/` is frozen

If `design/FROZEN.md` exists, **stop before doing anything else.** Report its `Frozen because` and `Lifts when` lines verbatim and write nothing. The rule and the marker's format live in `AGENTS.md`, *The design freeze* — not restated here.

This is the gate a blocked slice most often arrives at: a slice that needs a contract amendment stops and escalates, and while frozen that escalation is answered by the user, not absorbed here. Thawing to amend is a legitimate answer — **it is just not this command's to decide.**

Read `design/10-design.md`. Write `design/20-contract.md`.

This is the artifact that constrains the implementing agent. Everything downstream is checked against it. Precision here is what makes it safe to implement with a cheaper model.

## Semantics, not shape

**This document carries semantics; the tree carries shape** (`AGENTS.md`, *Single ownership* — a document states only what the tree cannot). A type declaration or a parameter list written both here and in the code is two copies, and this one is the copy that rots.

Before the code exists there is nowhere else for shape to live, so write it here **as a scaffold**: full declarations, in the project's actual language syntax, types and signatures only, no bodies. Then the slice that materialises a declaration into code **replaces the block here with a pointer to the file that now declares it, in the same commit** — that is descriptive drift being corrected where it is found (`AGENTS.md`, *Hard rules*), not a contract amendment, and it needs no approval.

What is left behind after that replacement is the point of this document, and it is the part no parameter list can state. Write it as though the scaffold were already gone.

## Types
Every entity from the data model, named, with **where its declaration lives**. While that is here: a concrete declaration, nullability explicit, no `any`, no `object`, no untyped dictionaries. Once it is in the tree: the file, plus the facts a declaration cannot carry — which fields are meaningful under which state, what must never be normalised away, what a consumer may not assume. An entity with no code representation says so and points at the invariants that constrain it instead.

## Persisted schemas
Table/collection/file definitions with keys, indexes, and constraints. State the migration story for each: what happens to existing data. **"None" is an answer**, and where it is a deliberate constraint rather than an absence, say which.

## Public surface
Every function, method, or command crossing a module boundary. For each: the file that declares it, and every constraint the declaration cannot express — a parameter that must not acquire a default and what invariant that would defeat, what the caller may rely on, what it must never do. A **Markdown command file has no separate declaration to point at**, so its surface is stated here in full: invocation, what it reads, what it writes, what it must output, what it must not do.

## Error semantics
An enumerated error type per module. For each variant: when it is raised, whether it is retryable, and what the caller is expected to do. **No bare exceptions, no string errors.** This section never becomes a pointer — an error variant's name is in the tree, but when it fires and what the caller does about it is not.

## Invariants
Statements that must hold at all times, written so they could become assertions. Name which module is responsible for maintaining each, and say which are enforced by code rather than by instruction — those are the only ones a reader may trust without checking. **This is the highest-value section in the document. Write it first.**

Rules:
- If the design doc does not determine a signature, do not invent it. List it under `## Unresolved` and stop.
- **Do not restate a declaration the tree already carries.** Point at it and state what it cannot say.
- No implementation. No comments explaining intent — the design doc carries intent. File paths are permitted **only** as the pointers this section requires.
- Anything you add here that was not implied by the design doc gets a decision-log entry.

## Re-run

Rewrites `design/20-contract.md` in full from the current `design/10-design.md` — there is no
partial regeneration. A scaffold already replaced by a pointer to a materialised declaration
(*Semantics, not shape*, above) must stay a pointer; a re-run never turns it back into a
scaffold. `## Unresolved` only ever shrinks between runs, as signatures get resolved — an
entry a previous run resolved must never reappear.
