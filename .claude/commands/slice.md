---
description: Implement one slice. Usage - /slice S3
argument-hint: <slice id>
---

Implement slice **$1** from `design/30-slices.md`.

Before writing code, read `design/20-contract.md` for every signature you will touch. The contract is authoritative — if what you need is not in it, stop.

Sequence:

1. State the slice's acceptance criteria back as a checklist. One line each. Nothing else.
2. Write the tests that check those criteria. They must fail for the right reason before you write the implementation.
3. Implement against the contract signatures exactly. No signature drift, no added parameters, no widened return types.
4. Run the tests. Run the full suite, not just the new tests.
5. Report: criteria met, criteria not met and why, and anything you had to decide that the contract did not determine.

Stop conditions — halt and report rather than proceeding:

- The contract does not contain a signature you need.
- Two readings of an acceptance criterion are both defensible.
- Making the slice work requires changing a signature, schema, or invariant.
- You find a defect outside this slice. Note it, do not fix it.
- The `Out of scope` line is blocking you. That is information, not an obstacle to route around.

Do not:
- Touch files outside `Touches` without saying why first.
- Refactor adjacent code.
- Add dependencies.
- Update the design docs. That is `/reconcile`.
