---
description: Derive the interface contract from the design doc
---

## Stop if `design/` is frozen

If `design/FROZEN.md` exists, **stop before doing anything else.** Report its `Frozen because` and `Lifts when` lines verbatim and write nothing. The rule and the marker's format live in `AGENTS.md`, *The design freeze* — not restated here.

This is the gate a blocked slice most often arrives at: a slice that needs a contract amendment stops and escalates, and while frozen that escalation is answered by the user, not absorbed here. Thawing to amend is a legitimate answer — **it is just not this command's to decide.**

Read `design/10-design.md`. Write `design/20-contract.md`.

This is the artifact that constrains the implementing agent. Everything downstream is checked against it. Precision here is what makes it safe to implement with a cheaper model.

Write, in the project's actual language syntax (types and signatures only, no bodies):

## Types
Every entity from the data model as a concrete type declaration. Nullability explicit. No `any`, no `object`, no untyped dictionaries. If a field is a constrained string, declare the constraint as a type or state the invariant next to it.

## Persisted schemas
Table/collection/file definitions with keys, indexes, and constraints. State the migration story for each: what happens to existing data.

## Public signatures
Every function or method crossing a module boundary. Full signature: parameter types, return type, and error type. Internal helpers are out of scope.

## Error semantics
An enumerated error type per module. For each variant: when it is raised, whether it is retryable, and what the caller is expected to do. **No bare exceptions, no string errors.**

## Invariants
Statements that must hold at all times, written so they could become assertions. Name which module is responsible for maintaining each.

Rules:
- If the design doc does not determine a signature, do not invent it. List it under `## Unresolved` and stop.
- No implementation. No file paths. No comments explaining intent — the design doc carries intent.
- Anything you add here that was not implied by the design doc gets a decision-log entry.
