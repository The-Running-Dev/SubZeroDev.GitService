# Slices — SubZeroDev.Git

Derived from `10-design.md` and `20-contract.md`. Thirty-nine vertical slices. Each one ends
runnable: it goes from an entry point to persistence and leaves nothing half-wired.

## How this document is kept

Two sections. **`## Landed`** is an index — one row per slice whose issue is closed.
**`## Outstanding`** carries the full body of every slice still to do: `Delivers`, `Touches`,
`Depends on`, `Acceptance`, `Out of scope`.

A slice moves between them when its issue closes, and **its body is retired rather than copied
down**. The closed issue is the record of what was accepted, criterion by criterion, with the ticks
that were justified when they were made. A second copy here would be the one that rots, and
re-deriving criteria for a finished slice is how a closed issue gets reopened against prose nobody
checked. The index keeps the id, the name and the issue, which is what a reader needs to reach the
record.

Three rules follow from that, and both `/track` and `tools/Test-DesignDrift.ps1` depend on them:

- **A landed row is never rewritten** — not the name, not the issue. A landed slice with a closed
  issue is finished, not drifted.
- **A re-run appends new slices under `## Outstanding`, and retires closed ones out of it.**
  `/slices` owns both directions because it is the only command that writes this file — `/reconcile`
  puts it out of scope entirely and `/track` only reads the two sections — so a slice whose issue has
  closed is retired here or nowhere. A re-run never resurrects a landed body, and never renumbers or
  reuses a retired id.
- **Criteria are compared on ids, never on prose.** A landed slice carries no criteria here, so
  only its issue pin is checked.

## Criterion ids

Every acceptance criterion carries a stable `S<n>.<m>` id. `/track` compares ids rather than prose,
so a reworded criterion does not read as drift and a ticked checkbox keeps meaning what it meant.

**The ids are positional from 1 within each slice, and that was not a free choice.** The test suite
had already been citing them — `S3.4`, `S4.7`, `S9.2`, `S10.4` — derived positionally by whoever
wrote each test, against a document that contained no `S<n>.<m>` token anywhere. Numbering any other
way would have silently re-pointed every one of those test names at a criterion it does not prove.
The positional reading was checked against each cited id before numbering, and each resolves to the
criterion its test name describes. This resolves the open decision of 2026-08-04, in the `/slices`
session that entry said it needed.

**Ids are never reused and never renumbered.** Removing a criterion leaves a gap; the next one takes
the next free number. A criterion added later is **appended, even when it has to run first** —
`S12.8` and `S18.8` are both of that kind, and each says so in its own text. Renumbering to put them
in logical order would rewrite what an existing issue's checkbox refers to, which is the single
failure this scheme exists to prevent.

The same rule applies to slice ids. Splitting the original S17 created S23–S27, placed where their
dependencies run rather than after S22; S18–S22 keep their established identities. Extracted
criteria S17.8 and S17.10–S17.14 are retired, not reassigned. Their requirements now have new ids in
the new slices, so `/track` can report the removal and addition rather than silently treating one
checkbox as another. S28 and S29 are appended on the same rule and placed the same way — ahead of
S18, because that is where their dependencies run and where the assumption S28 rests on is worth
exercising. S30 is appended on the same rule and placed after S29, for the same reason.

**S28.4 is retired, not reworded, and the gap it leaves is deliberate.** It asked one box to carry
two requirements — that a named volume passes boot's lease self-test, and that a bind-mounted Windows
host path fails it — and the second did not reproduce: run for real on 2026-08-14 against Docker
Desktop 4.86, the bind mount honoured the lock, the self-test passed, and a second container was
refused with `lease-held` rather than `lease-not-exclusive`. The machinery is real and was exercised
correctly; the environmental premise it was written against is not true of that deployment target.
The decision log's 2026-08-14 entry recorded the finding and left the resolution to this command.
Retiring the id rather than narrowing it is what keeps the existing checkbox honest: narrowing S28.4
to the half that was demonstrated would silently shrink what an already-reported box refers to, which
is the one failure this scheme exists to prevent. The demonstrated half is now `S28.7`; the refusal
requirement was reframed onto a filesystem that genuinely does not lock and became `S30.1`,
which has since been retired in its turn — see below.

**`S30.1` and `S30.3` are retired, and this is the second time the same requirement has failed to
land.** Both asked boot to exit `lease-not-exclusive` against a real mount whose byte-range locking is
absent, `S30.1` through boot and `S30.3` by measuring the self-test child's exit code directly. Run
for real on 2026-08-19 against a Samba sidecar mounted `nobrl`: the share **does** defeat locking
across independent client sessions — two production containers both booted and both reported
`ready: true` against it at once, which is exactly the split-brain invariant C7 exists to prevent —
and boot's self-test **passed on both sides**. `childIsRefused` spawns its child inside the container
that already holds the lock, so parent and child share one CIFS client session, and `nobrl` disables
only server-mediated cross-session locking; the check measures the session it already holds. So
`S30.3` does not merely fail, it inverts: the child exits `3` (refused) on the very filesystem the
criterion was written to catch. NFS could not be exercised at all — Docker Desktop's Linux VM kernel
carries no NFSv3 client, and NFSv4 has no `nolock` equivalent.

The decision log's 2026-08-19 entry recorded the finding and left the resolution to this command.
Retiring both ids rather than rewording them is what keeps the existing checkboxes honest: a
criterion asking for a demonstrated refusal cannot be quietly turned into one asking for a
demonstrated *failure to refuse* while the same box carries both meanings. Their replacements
`S30.5` through `S30.9` measure what the check actually does, and `S30.2` and `S30.4` are **reworded
without changing their ids**, on the same rule that reworded `S18.1` and `S18.2` — `S30.2` had been
written as a control for `S30.1`, and `S30.4`'s outcome set had no category for two live instances.

S30 was **renamed** for the same reason: "The lease guard refuses a filesystem that does not lock"
states as fact the thing the slice existed to disprove. Issue
[#118](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/118) carried the old title and
the old criteria at the time; `/track` reported that drift and synced it, and the issue has since
closed. S30 is a landed row.

**The blindness itself was not resolved there, and must not be read as accepted.** `/slices` could
decide what S30 checks; it could not decide whether boot should be able to see a cross-session lock
failure at all, because that means telling boot what kind of mount it is on — new surface in
`lease.ts` and a claim in `10-design.md` that would have to change. That is `/design`'s, and it is
now issue [#135](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/135) rather than a
staged item in `90-decisions.md` § Open, which is empty.

**S18 is split the same way S17 was, and six of its criteria are retired rather than moved.** S18
asked one session to stand up a user interface from nothing, ship five views on top of it, federate
login against a real identity provider, and drive all of it through a browser. At the split there
was no user interface in this repository at all — no markup, no styles, no build for any of it — so
the console S18 described as needing completion had not been started, and the slice was mis-sized by
roughly the whole of its first half. `S18.3`, `S18.4`, `S18.5`, `S18.6`, `S18.7` and `S18.8` are **retired**, and
their requirements carry new ids in S31 to S34, so `/track` reports a removal and an addition rather
than silently treating one checkbox as another. S18 keeps `S18.1` and `S18.2`, both of which describe
work that now sits in the first sub-slice; the criteria covering the parts that were never written
down — serving the bundle at all, signing in from a browser, enrolling the first operator, and
hashing the bundle's asset manifest — are **appended as `S18.9` onwards, even though every one of
them runs before `S18.2`**, on the same rule that put `S12.8` and `S18.8` where they sit.

**S18.1's and S18.2's wording changed; their ids did not.** `S18.1` was written as though no route
existed, and about twenty-two already ship. `S18.2` opened with a clause about views that will not
exist until S33 and S34. Both are reworded to what is checkable in the slice that now holds them,
which is the case criterion ids exist for: prose moves, the checkbox keeps its meaning.

S18 is also **renamed** — "The console is complete, and federated login works" described the whole
of what has now become five slices. Both issues have since been retitled and closed, and S18 and
S19 are index rows above; the two landed rows that still carry a superseded name are the ones the
note under that table names.

**S20 is split the same way S17 and S18 were, and four of its criteria are retired rather than
moved.** S20 asked one session to build a consumer-extension seam that does not exist, invent a
parity-measurement mechanism that does not exist, port sixteen authoring tools and two console
screens across a repository boundary, name a file-watcher pair, and complete a naming cutover. Two
of those were assumptions rather than work: `S20.1` reads as though a derived image's build could
already merge its own declarations into the base's registry, and `S20.2` as though a fixture
comparison already existed to run. Neither is true — `scripts/build-registry.ts` compiles one
hardcoded declaration array with no merge point, `src/server.ts` registers every handler and
recovery descriptor by hand, the runtime image deletes the compiler per **B8** so a derived image
built from it has neither the compiler nor the base's declarations, and nothing anywhere in the tree
captures or compares tool metadata. The slice was mis-sized by the whole of its first half, in the
same way S18 was.

`S20.1`, `S20.2`, `S20.5` and `S20.6` are **retired**, and their requirements carry new ids in S35
to S38, so `/track` reports a removal and an addition rather than silently treating one checkbox as
another. S20 keeps `S20.3` and `S20.4`, both of which describe work that stays in the narrowed
slice; the two requirements that remain S20's own but were previously carried inside a retired
criterion — the blog's own tools compiling into its derived image, and the parity comparison
actually being run against it — are **appended as `S20.7` and `S20.8`**, on the same rule that put
`S12.8` and `S18.8` where they sit.

S20 is also **renamed**. "`SubZeroDev.Blog` runs as a consumer, with parity measured" now describes
what S35, S36, S20, S37 and S38 achieve together, not what the narrowed slice delivers. Issue
[#34](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/34) still carries the old
title and the old criteria. It is open, so that is drift for `/track` to report and sync, not
something this command reconciles.

S35 to S38 are appended on the same rule as S23–S27 and S31–S34, and placed where their
dependencies run rather than after S22 — S35 and S36 ahead of S20 because S20 cannot start without
them, S37 and S38 after it because both need the blog's tools already migrated.

**S39 is appended on the same rule, and no criterion of S20's is retired to make room for it.** S20
did not mis-size this one; it could not have seen it. `S20.8` measured what each profile can reach
and found the `mcp` profile reaching none of the blog's own tools, and the cause was neither in the
blog's declarations nor in the parity harness but in the base's scope expansion, which is not S20's
to touch — `Touches` names the blog's tools, its derived image, and its fixtures. So the work is a
slice of its own rather than a criterion added to a slice whose scope excludes it, and `S20.8` stays
exactly as written: it is the measurement, and S39 is what makes the measurement pass. S39 is placed
ahead of S20 for that reason, the same way S35 and S36 were.

**S32 has no retired predecessor, because nothing named it.** `10-design.md` § Console session
requires a grants view — "revoke everything and re-authenticate is one screen during an incident" —
and S18's own `Delivers` line said "the three remaining operator views", counting grants as already
built. S13's closed issue does carry a ticked box reading "The grants view lists clients, grants,
operator API tokens and operator sessions with last use, and revokes any of them", and S13 did ship
every route behind it. What it did not ship, because no console existed to put it in, is the screen.
**S13 is landed and is not edited, reopened or reported as drift** — a landed slice with a closed
issue is finished. The missing screen is picked up as new outstanding work in S32 instead, which is
where it can be checked.

## Why this order

The two bets the design cannot control were proven first, because both are cheap to test and both
invalidate a great deal if false.

**S1 proved the contract-first spine.** Deliverable 1 is new construction against a document that
states nothing in it is implemented. If the compiler, the fingerprint and the boot refusal do not
hold together, every capability claim downstream is decoration.

**S2 proved the volume honours an exclusive advisory lock.** This is a Linux container on a Windows
host, where the design records that advisory locking has historically been unreliable enough for
two instances to both believe they hold the lease. Definition-of-done item 9 rests on a property of
the filesystem, not of this code. If the target volume fails the child-process self-test, single
instance ownership needs rethinking — and that is worth learning in week one rather than after the
journal, the clone store and the audit chain have all been written against it.

The capability lattice is the design's spine but is not observable until a session can list tools,
so it landed in two parts: the instance-scoped layers in S5, where declaration-management routes
first need them, and discovery filtering in S6.

**S28 ran first among what then remained, because S2's proof was taken behind an injected seam.**
`LockAcquirer` exists precisely because a volume that does not exclude cannot be produced on demand
in a test, so the property definition-of-done item 9 rests on has been demonstrated against a fake
and never against the deployment the brief describes. Everything after it — the derived image, the
parity migration, the rollback — assumed a container that had never been built. S29 followed it
because invariant B1 had no enforcement at all, and the seam it protects is the one
`MCP-NEXT.md` Phase 8 exists to eventually cut.

**S30 no longer finishes what S28 could not; it establishes why nothing can, yet.** S28 shipped the
image and demonstrated mutual exclusion, so definition-of-done item 9 is met for every supported
configuration. The *guard* behind item 9 — boot's refusal to serve on a filesystem that does not
honour exclusion — turns out to be unreachable from any real filesystem in this environment, and the
one real filesystem that does produce split-brain sails straight past it. S30 is therefore a
measurement rather than a proof: it pins where single-instance ownership actually stops, and leaves a
committed fixture that any future repair has to satisfy. It was placed ahead of S18 because it needs
the image S28 built and nothing else, and because a boundary the system leans on is worth knowing
before five more slices are written on top of it. It has since landed, along with the five console
slices around it — so the ordering argument stands as the record of why it ran there, not as a claim
about what runs next.

**Among the console slices, the bet that had never been taken ran first and the external dependency
ran second.** S18 was where a browser talked to this service for the first time: an ambient-authority
cookie session, a double-submit token, and a bundle this repository had never built were all assumed
to work together, and every later view was written on top of that assumption. S31 followed because a
real identity provider is the console's one external dependency, and because it reopened the login
surface S18 had just finished — a session later would have been reopening it cold. S32, S33 and S34
were views over backends that already shipped, so the risk in them was presentation rather than
architecture; they were ordered smallest-first, and only S34's last criterion depended on the other
three, because it is the one that counts every view.

**S35 ran before the migration, because the migration had been written against a seam that did not
exist.** `10-design.md` § Where consumer extension attaches names two seams, and at that point only
one of them had been built: S19 shipped the console half as a published package a consumer's build
consumes, and nothing shipped the tool half at all. Everything the handover needs — the consumer's
tools compiling into one registry, one fingerprint over the extension, a consumer's handlers
reachable from a pipeline that may not import them — rested on that unbuilt half, exactly the way
every console slice rested on a bundle S18 had not yet served. It was proven against a small example
consumer committed here rather than against the blog, so a defect in the seam surfaced on one
declaration and one view rather than a third of the way through a two-repository migration. S36
followed it because a
comparison that has never reported a difference cannot be the evidence definition-of-done item 17
asks for, and building it after the migration would mean measuring parity with a tool the migration
itself was the first to exercise.

**S36 is why S39 exists, and that is the strongest argument this ordering has produced.** S35 and S36
were placed ahead of S20 on the reasoning above, and the measurement S36 built then failed in a way
no amount of reading the types would have found: `content.*` is admitted by the type, by the ceiling
and by a declaration's grant, and was reachable from no MCP scope, so a consumer's entire tool
surface was invisible to the one client kind definition-of-done 13 requires it for. Three of the four
profiles build their grant from the contract set directly and were unaffected, which is why every
prior review passed over it. Had the parity harness been built after the migration, as the retired
`S20.2` assumed, the migration itself would have been the first thing to exercise it and this would
have surfaced as a defect in the blog rather than a gap in the base.

**What remains is S39, then S20, S37, S38, S21 and S22 in that order** — the scope rule that makes a
consumer's operations reachable, then the blog's tools, its screens and its watched files, then the
second repository, then the deployment gates. Everything from S20 onward is dependency order rather
than a risk argument. S39 is placed ahead of S20 because `S20.8` cannot pass without it, and because
it is base-runtime work sitting under a slice that touches no base source.

## Contract gates

Items in `20-contract.md` § Unresolved block specific slices. Each is a contract amendment,
committed separately and before the handler work depending on it. **No slice may introduce a
signature absent from the contract** — where a slice needs tools, amending the contract is its
first acceptance criterion, not an implementation detail.

**No gate is live.** `20-contract.md` § Unresolved records every U-item from U1 to U10 resolved, the
last two on 2026-08-19 by S18 and S19; that section is the authority for which slice closed which
gate and on what date, and it is not restated here. The one gate this document raised itself — the
**consumer-extension seam for tools**, which the contract fixed for the console half and not the
other — was `S35.1`, committed separately and before the rest of S35, exactly as every earlier gate
was. S35 has landed and that gate is closed.

Naming a gate here is not the same as recording it in § Unresolved, which is `/contract`'s to write.
This document names what blocks a slice and the criterion that closes it; the amendment itself
decides the shape.

**One claim this section used to make was wrong, and a measurement is what found it.** It read
"S20's content capabilities are already admitted by the open `content.*` template type. None of them
opens with an amendment criterion." Admitted by the type and reachable through the expansion are
different things, and `S20.8` measured the difference: every `content.*` capability was unreachable
from every MCP scope. The correction is already committed — `20-contract.md` § *Capabilities and the
lattice*, § *Scopes*, § *Compiler* and **A10** carry it, with the alternatives rejected in
`90-decisions.md`, 2026-08-23 — so the amendment is not a gate S39 opens with but a settled contract
S39 implements against. That is the ordinary case, not an exception: a slice's first criterion is an
amendment only when the amendment has not already been made.

Nothing S39, S20, S37, S38, S21 or S22 needs is now unfixed in the contract, checked against it
rather than remembered: S37 uses the console registration and filtering the contract already fixes;
S38 uses the file-watcher plan/apply protocol U10 resolved, whose plan entry the same 2026-08-23 pass
confirmed is gated by nothing at dispatch and intended to be; and S39's four surfaces are each fixed
by name. None of them opens with an amendment criterion.

**U7 was answered in two parts, and the first part moved earlier than this section used to say.**
Invariant B3 has boot verify the console asset manifest and refuse to start on a mismatch, and the
2026-08-03 decision fixing `consoleFingerprint` at the SHA-256 of the empty string did so on the
stated ground that "the console does not exist until S19". That ground is wrong — the console's own
views land at S18 — so leaving the fingerprint empty would have shipped real, runtime-swappable
assets for the whole span between S18 and S19 under an invariant claiming to verify them. S18
therefore fixed the framework binding, the build entry and the manifest hash, and B3's console half
stopped being vacuous the moment there was anything to verify. S19 kept what was genuinely its own:
publishing the console as a versioned package a consumer's build can consume. `S19.1` was left as
written and met by S18, which is why it is recorded here rather than in the criterion.

## A contradiction found while slicing, since resolved

Writing S1's acceptance criteria surfaced a conflict between contract invariant **E8** — no HTTP
route unauthenticated — and the design's own item 15 companion check polling `/healthz`
unauthenticated. **Resolved 2026-08-03 by splitting the payload**, not by picking a reading: the
probe carries `LivenessReport`, which is `ready` and `commitSha` and nothing else, and the operator
health report is a separate authenticated route. Both documents are amended and the decision log
carries the reasoning.

---

## Landed

Bodies retired; the closed issue is the record. Criteria are not re-derived from this table.

| Slice | Name | Issue |
|---|---|---|
| **S1** | The contract compiles, and the service refuses to start on a mismatch | [#15](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/15) |
| **S2** | One instance owns the volume, and a second refuses to start | [#16](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/16) |
| **S3** | The audit trail, hash-chained and verified at boot | [#17](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/17) |
| **S4** | The operator can log in, and only the operator | [#18](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/18) |
| **S5** | A repository is declared, and clones itself on first use | [#19](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/19) |
| **S6** | Reads, dispatched through the pipeline, filtered by capability | [#20](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/20) |
| **S7** | Local mutations, serialised, with intent recorded before the first side effect | [#21](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/21) |
| **S8** | A restart mid-operation recovers, or parks and says so | [#22](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/22) |
| **S9** | Credentials resolve, and the service reaches a remote | [#23](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/23) |
| **S10** | Pull requests, checks and bounded waits | [#24](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/24) |
| **S11** | Terminal states reach the operator | [#25](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/25) |
| **S12** | Composites, and a change carried end to end | [#26](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/26) |
| **S13** | Durable grants, and revocation that means something | [#27](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/27) |
| **S14** | MCP, bound to one repository, with a grant that can narrow | [#28](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/28) |
| **S15** | The escape hatch, and the six operations it can reach | [#29](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/29) |
| **S16** | Held operations fire, or are cancelled with a reason | [#30](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/30) |
| **S17** | A watched file becomes a pull request without widening authority | [#31](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/31) |
| **S18** | The console opens, and the operator picks a repository | [#32](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/32) |
| **S19** | A consumer can extend the console | [#33](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/33) |
| **S23** | A consumer can declare a safe file-watcher protocol | [#92](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/92) |
| **S24** | An unattended pull request is followed to its terminal state | [#93](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/93) |
| **S25** | Expired structured records release real disk space | [#94](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/94) |
| **S26** | Filesystem history ages out without losing the only copy | [#95](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/95) |
| **S27** | Disk pressure releases only disposable clones, or refuses clearly | [#96](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/96) |
| **S28** | The service ships as a container, and a second one refuses the volume | [#114](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/114) |
| **S29** | The layering is enforced by a check, and every gate runs unattended | [#115](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/115) |
| **S30** | Where single-instance ownership actually stops, demonstrated | [#118](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/118) |
| **S31** | Federated login, and a way back after a recovery code | [#126](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/126) |
| **S32** | Revoking everything is one screen | [#127](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/127) |
| **S33** | The trail is readable, and its integrity is visible in it | [#128](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/128) |
| **S34** | The two states with no other exit become visible, and clearable | [#129](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/129) |
| **S35** | A consumer can add its own tools | [#155](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/155) |
| **S36** | Parity is measured, and the measurement has failed | [#156](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/156) |

Two rows carry a name this document changed after the issue was opened: #31 is titled "A dropped
file becomes a pull request…" and #92 "A consumer can declare a safe content-drop protocol", both
predating the 2026-08-11 rename to file-watcher terminology. Both issues are closed and neither is
edited — reported here rather than reconciled.

---

## Outstanding

## S39 — A consumer's own operations are reachable from an agent

Delivers: an agent working through this service can reach a consumer's own operations — writing a
post, running its publishing gates — and not only the repository-generic ones. Until now a consumer
could add operations, be granted them, and have them build cleanly, while every agent that connected
saw none of them; the console saw them, which is why nobody noticed until the operations were
counted. And anyone adding an operation the service cannot decide how to reach is told so when they
build it, instead of shipping something invisible to the callers it was written for.

Touches: the capability type, the scope-to-capability expansion in authorization, the compiler's
error set, and the invariant assertion in the parity harness.

Depends on: S35 and S36, both landed — the consumer whose operation this makes reachable, and the
harness A10's equality is asserted in.

Acceptance:
- S39.1 A `content.*` capability whose final segment is neither `read` nor `write`, written as a
  literal in a tool declaration, fails the repository's own typecheck gate. Both directions are
  shown: a conforming name of each tail compiles.
- S39.2 The same malformed name reaching the declaration array as a widened `string`, where the type
  cannot catch it, fails `compile` with `capability-unscopable` naming the tool and the offending
  capability. Its `resultKind` is `validation` and `isError` is false, as for the other eight.
- S39.3 An MCP session holding only the `read` scope sees a tool declaring a `content.*` read
  capability in a listing and can call it, and does not see a tool declaring the write one at all. A
  session holding only `write` sees the second and not the first. Read and write stay separable for
  content, which is the property the rejected fifth scope would have collapsed.
- S39.4 A session holding only `raw` and `schedule` sees no content tool whatsoever. The escape hatch
  and the scheduler are not reachable by naming a capability family after them.
- S39.5 The nine fixed declaration-scoped literals expand exactly as they did before, pinned
  name-by-name against the existing table — `scheduler.read` reaches `schedule` and never `read`. A
  later attempt to derive all nine from their tails fails this criterion rather than silently
  widening what a `read`-scoped token reaches.
- S39.6 **A10** is asserted rather than described: `expandScopes(['read','write','raw','schedule'],
  contract)` equals the declaration-scoped members of the contract set, run against a registry
  carrying a `content.*` capability of each tail. Adding a capability the rule cannot place makes the
  assertion fail, demonstrated.
- S39.7 A session of the `mcp` profile against the example consumer's derived image sees that
  consumer's own tool. The `mcp` profile's tool count for that image is stated before and after this
  slice, and the difference is exactly the consumer's content-capability tools — which numbered zero
  visible before.
- S39.8 Comparing the base image against its committed parity fixtures still reports zero differences
  for every profile. The base declares no `content.*` capability, so any change to its own visible
  surface would mean one of the nine fixed literals moved.

Out of scope: re-measuring the blog's parity, which is `S20.8` and is the criterion this slice
exists to unblock. Adding a fifth content-shaped scope, or changing which scope reaches any of the
nine fixed literals — both rejected on 2026-08-23, and reopening either is a contract change rather
than an implementation choice. Adding a dispatch-time check against `ToolDeclaration.scopes`:
withdrawn on the same date, and scopes stay enforced only at session establishment. Validating the
deployment ceiling, where a malformed name is inert because it can never reach the contract set.

---

## S20 — The blog's authoring tools run on this runtime

Delivers: definition-of-done items 3 and 17, for the tools. The blog's own authoring work — creating
and updating posts, adding tags, authors and hub entries, running its publishing gates — stops
needing a server built for the blog alone and runs on the one that serves every repository. Whoever
publishes to the blog keeps everything they could do before, under names that say what an operation
does rather than which repository it came from.

Touches: the blog repository's own tools and its derived image, and the parity fixtures for it.

Depends on: S35, S36.

Acceptance:
- S20.3 Every generic tool carries an operation-descriptive name and no `blog_` prefix, and the blog
  migrates to the new names in the same cutover — no aliases, no deprecation window.
- S20.4 The blog's content capabilities appear under the `content.*` prefix and are absent from
  every other declaration's grant.
- S20.7 The blog's sixteen authoring tools compile into its derived image's registry alongside the
  base's, under one fingerprint. Both counts are stated, and the base's own set is unchanged by the
  extension. **Appended, though it runs before `S20.3`** — it carries the half of the retired
  `S20.1` that is genuinely this slice's, once S35 has built the seam the rest of it assumed.
- S20.8 Tool metadata is captured from the blog's current server before cutover, per its own
  capability tiers, and compared against the derived image's capture per this service's profiles.
  The mapping between the two profile vocabularies is stated rather than assumed. The comparison
  reports **no capability loss**; every difference it does report is an addition, or a rename
  covered by `S20.3`, and each is named individually. "No loss of capability" is measured, not
  asserted.

Out of scope: changing blog domain behaviour. This is a migration, and any behaviour change makes
the parity comparison meaningless. The blog's console screens (S37) and its watched files (S38);
both need these tools migrated first.

**`S20.1`, `S20.2`, `S20.5` and `S20.6` are retired, and the gaps they leave are deliberate.** The
first two named a seam and a measurement that did not exist and are now S35 and S36; the last two
are whole slices of their own, S37 and S38. See *Criterion ids* above.

---

## S37 — The blog's authoring screens appear, and only for the blog

Delivers: whoever wrote and published posts from the blog's own console does it from this service's
console instead, against the repository they have selected — and those screens are simply not there
when they have selected any other one.

Touches: the blog's two authoring screens, ported onto the published console package and taking the
selected repository as an input, and the blog's derived image bundle.

Depends on: S20.

Acceptance:
- S37.1 The blog's post-list and compose screens render in the derived image's console when the blog
  declaration is selected.
- S37.2 Both are absent for a second declaration in the same running instance, and their absence
  follows from that declaration's grant lacking the content capabilities each screen declares —
  never from a check against a declaration name. Demonstrated with two declarations live at once.
- S37.3 Neither screen assumes a single repository: each acts against the selected declaration, and
  no request either makes omits the repository.
- S37.4 A post is created and published through the console in a real browser, end to end against a
  real repository, and the resulting change is visible on the remote.
- S37.5 The derived image's console fingerprint covers both screens: a bundle swapped after the
  build refuses to boot, the same way the base's does.

Out of scope: restyling the base console — a derived image is not forbidden from doing so, and this
slice does not. Adding a file view or content editor to the base console; the brief left that open
and it stays open.

---

## S38 — The blog's watched files become pull requests

Delivers: someone can drop a finished post file into a folder for the blog and get a pull request
from it, with no git client, no console and no agent involved — the headless delivery the blog has
today, running on this service instead.

Touches: the blog's plan and apply authoring pair in its derived image, and the blog declaration's
watcher configuration.

Depends on: S20.

Acceptance:
- S38.1 The blog declaration names its own plan and apply tools, both compiled into its derived
  image's registry and each annotated for its phase.
- S38.2 The plan decides the repository path from the file's own front matter, and the watcher
  chooses no path. Demonstrated with two files whose front matter routes them to different paths in
  one run.
- S38.3 The pair's plan schemas are byte-for-byte equal after canonical serialisation. A
  deliberately mismatched pair is refused at declaration and again at boot re-validation, and each
  refusal reason is stated by name.
- S38.4 A complete file dropped into the blog's inbox reaches an open pull request unattended, and
  the file ends in `processed/`.
- S38.5 A file whose front matter does not satisfy the plan tool's schema never reaches a git
  command, ends in `failed/` with a sibling reason file naming what was wrong, and is not retried.
- S38.6 The apply tool refuses a path outside the declaration's effective allowlist whoever
  dispatched it, including when a session calls it directly rather than through the watcher.

Out of scope: changing the watcher mechanism, which is generic and landed in S23. A second
consumer's plan/apply pair. Widening what the blog's plan tool may decide beyond a repository path.

---

## S21 — A second repository, driven end to end, unwatched

Delivers: definition-of-done items 4 and 13. Generalisation is the justification for the whole
project, and one consumer is not evidence of it.

Touches: nothing new — this is a proof, not a build.

Depends on: S20.

Acceptance:
- S21.1 A repository outside the `SubZeroDev.*` estate is declared and driven through a full change:
  branch, edit, commit, push, pull request, merged.
- S21.2 An agent completes that change **without a human touching git and without supervision**.
- S21.3 Every terminal state is reached at least once without intervention, and each stops safely
  and says so: merge conflict, failed required check, wait timeout, and a restart mid-operation.
- S21.4 A `generic`-host declaration performs local git and push, and its `host.*` tools are
  **absent from the listing** rather than failing at call time.
- S21.5 A new repository is onboarded by declaration alone — no code change, no rebuild, no restart
  — while the instance continues serving every other repository. Other repositories' operations are
  timed across the onboarding to prove they were not blocked.

Out of scope: adding a tool to make the second repository easier. If it needs one, that is a contract
amendment and evidence of a gap in the generalisation.

---

## S22 — The deployment is verifiable, reversible and documented

Delivers: definition-of-done items 15, 18 and 20.

Touches: the companion check script, operator documentation.

Depends on: S21.

Acceptance:
- S22.1 The companion check polls `/healthz` until the commit SHA is stable, then runs a real
  `initialize → tools/list → repo_status` session, classifying its outcome as `stale-runtime`,
  `mixed-runtime`, `verification-credential`, `unexpected-profile-or-catalog` or `verified`. It is
  **an executable check shipped alongside the service, not a registry tool** — asserted by its
  absence from the registry.
- S22.2 Each of the five classifications is produced at least once against a deliberately broken
  deployment. A check that has only ever returned `verified` is not known to classify anything.
- S22.3 Returning `SubZeroDev.Blog` to its current server is documented **and has been done once**,
  with the pre-migration store copy as the rollback target.
- S22.4 Operator documentation covers configuration, onboarding a repository, backup and recovery,
  revocation and rollback.
- S22.5 The volume-loss table is restated in the operator documentation as an accepted risk with its
  costs, because no off-volume backup ships.

Out of scope: an off-volume audit sink. Deferred by decision; reopening it is a brief change, not a
slice.
