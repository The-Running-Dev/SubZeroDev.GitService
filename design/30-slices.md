# Slices — SubZeroDev.Git

Derived from `10-design.md` and `20-contract.md`. Sixty-four vertical slices. Each one ends
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

Three rules follow from that, and the former track command and the Test-DesignDrift script depended on them, and `/next` still reads a `## Landed` table as history:

- **A landed row is never rewritten** — not the name, not the issue. A landed slice with a closed
  issue is finished, not drifted.
- **A re-run appends new slices under `## Outstanding`, and retires closed ones out of it.**
  `/plan` owns both directions because it is the only command that writes this file — the former
  reconcile command put it out of scope entirely and the track command only read the two sections — so a slice whose issue has
  closed is retired here or nowhere. A re-run never resurrects a landed body, and never renumbers or
  reuses a retired id.
- **Criteria are compared on ids, never on prose.** A landed slice carries no criteria here, so
  only its issue pin is checked.

## Criterion ids

Every acceptance criterion carries a stable `S<n>.<m>` id. The former track command compared ids rather than prose,
so a reworded criterion does not read as drift and a ticked checkbox keeps meaning what it meant.

**The ids are positional from 1 within each slice, and that was not a free choice.** The test suite
had already been citing them — `S3.4`, `S4.7`, `S9.2`, `S10.4` — derived positionally by whoever
wrote each test, against a document that contained no `S<n>.<m>` token anywhere. Numbering any other
way would have silently re-pointed every one of those test names at a criterion it does not prove.
The positional reading was checked against each cited id before numbering, and each resolves to the
criterion its test name describes. This resolves the open decision of 2026-08-04, in the session (then the slices
command, now `/plan`) that entry said it needed.

**Ids are never reused and never renumbered.** Removing a criterion leaves a gap; the next one takes
the next free number. A criterion added later is **appended, even when it has to run first** —
`S12.8` and `S18.8` are both of that kind, and each says so in its own text. Renumbering to put them
in logical order would rewrite what an existing issue's checkbox refers to, which is the single
failure this scheme exists to prevent.

The same rule applies to slice ids. Splitting the original S17 created S23–S27, placed where their
dependencies run rather than after S22; S18–S22 keep their established identities. Extracted
criteria S17.8 and S17.10–S17.14 are retired, not reassigned. Their requirements now have new ids in
the new slices, so the former track command could report the removal and addition rather than silently treating one
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
the old criteria at the time; the former track command reported that drift and synced it, and the issue has since
closed. S30 is a landed row.

**The blindness itself was not resolved there, and must not be read as accepted.** The slices command (now `/plan`) could
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
their requirements carry new ids in S31 to S34, so the former track command reported a removal and an addition rather
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
to S38, so the former track command reported a removal and an addition rather than silently treating one checkbox as
another. S20 keeps `S20.3` and `S20.4`, both of which describe work that stays in the narrowed
slice; the two requirements that remain S20's own but were previously carried inside a retired
criterion — the blog's own tools compiling into its derived image, and the parity comparison
actually being run against it — are **appended as `S20.7` and `S20.8`**, on the same rule that put
`S12.8` and `S18.8` where they sit.

S20 is also **renamed**. "`SubZeroDev.Blog` runs as a consumer, with parity measured" now describes
what S35, S36, S20, S37 and S38 achieve together, not what the narrowed slice delivers. Issue
[#34](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/34) closed on 2026-08-23 still
carrying the old title. Its criteria were synced and are the narrowed set, so the title is the only
half that went unreconciled, and it is now one of the superseded names the note under the landed
index records rather than drift the former track command could still act on.

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

**`S41.2` is retired, and `S41.7` to `S41.9` are appended, on 2026-09-28.** `S41.2` asked for one
outbox row per terminal kind "in the same transaction as the settle", for all three kinds. Two of the
three, `required-check-failed` and `wait-timeout`, are produced only by `checks_await`, and
`checks_await` is a `monitoring-wait`: it never journals and never settles, so there is no settle for
the row to share a transaction with. PR #326 landed the half of S41 that this does not touch and
stopped there. Narrowing `S41.2` to the one kind that does settle would silently shrink what its
checkbox refers to, so it is retired instead. `S41.7` is the contract amendment that decides how a
monitoring wait delivers its terminal notification, and it has to run first even though it is
numbered last, like `S12.8` and `S18.8`. `S41.8` carries the part of `S41.2` that still holds as
written, and `S41.9` carries the part that waits on the amendment. The gate is recorded under
§ *Contract gates*.

**`S52.6` is appended, not folded into `S52.5`.** `S52.5` covers the corrected outcomes of S49 to S51.
S53 was sliced after it, and widening `S52.5`'s range would change what an open checkbox refers to.

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

**The last six ran as S39, then S20, S37, S38, S21 and S22 in that order** — the scope rule that
makes a consumer's operations reachable, then the blog's tools, its screens and its watched files,
then the second repository, then the deployment gates. Everything from S20 onward was dependency
order rather than a risk argument. S39 was placed ahead of S20 because `S20.8` could not pass
without it, and because it is base-runtime work sitting under a slice that touches no base source.
All six have since landed, so this stands as the record of why they ran in that order, not as a
claim about what runs next.

**S40 to S52 were appended on 2026-09-25 from the open-issue backlog, and they are ordered by what
the gap costs while it stays open, not by what they build.** Every one of them closes a place where
the tree falls short of a contract or design statement that stands as written — direction already
decided, each confirmed against the code at `982b738` before it was sliced. Each slice names the
issues it closes, and its criteria carry those issues' `Done when` rather than restating them loosely.
The issues that are decisions rather than defects (#54, #135, #136, #140, #216, #276, #287, #288,
#292, and the W08/D18 item in `90-decisions.md` § *Open*), the kit-tooling issues, and the #65
helper refactor are deliberately not sliced: each belongs to `/design`, the kit, or
`/fix`, and a slice written against an undecided contract would be deciding it.

**S40 runs first because it is the one gap exploitable today.** A read-only operator token can resolve
a parked operation and clear a failing credential, and two routes that need no authentication at all
can grow the disk and the audit chain without bound. **S41 and S42 follow because they are what the
operator's attention depends on**: a terminal outcome that never notifies, a park that never notifies,
and a clone flagged `needs-attention` with no record able to clear it each mean the one person the
system escalates to is never told, or is told and cannot act. **S43 is boot**, where a lost takeover
record and a race between two steps each silently weaken a guarantee the brief rests on. **S44 to
S47 are integrity and truthfulness under failure** — what a crash, a busy lock, an unresolvable
credential or a hung module does — ordered by blast radius: a clone adopted half-written, then a
branch force-deleted with commits nobody merged, then error kinds that name the wrong cause, then
timeouts nothing enforces. **S48 is presentation**: every fact it shows already exists server-side.

**The watcher runs last, as S53, S49, S50, S51 and S52, in dependency order.** S53 was appended on
2026-09-28, after the D18 and D19 decision of 2026-09-25 settled what S50's out-of-scope line had left
open. It goes first among the watcher slices because it is not gated and its gap can be exploited
today. While a state directory is tampered, the watcher can open one pull request per poll interval
and then lose track of it. S49 is contract-gated (§ *Contract gates*, below) and carries the SHA the
rest of the watcher work names in its notices. S50 finishes the audit and notification path over both.
S51 fixes a first-use gap on the same tick protocol. S52 is the evidence harness, and it can only
prove the corrected outcomes once all four have landed.

S40 to S53 have landed.

**S54 to S64 were appended on 2026-10-08, because the plan read as finished while thirty issues were
still open.** Thirteen were issues that S40 to S47 named in their `Closes:` lines and fixed, but that
nobody closed; each was checked against the code at `e1b30f3` and closed with its evidence. Five more
were obsolete or already done. What remained was real: four decided changes nobody had built (#276,
#287, #288, #292), one defect found while verifying (#365), two tooling issues (#65, #150), and four
decisions, settled the same day in `90-decisions.md` so they could be sliced (#135, #136, #140,
#216). #54 closed as a decision with no slice.

**S54 runs first because it is the one gap exploitable today**: a stolen recovery code buys a full
session without a new factor. **S55 runs second because it carries the only untested assumption**,
that a real MCP client opens the server-to-client stream and honours `list_changed`. Nothing in the
tree serves that stream yet, and `S55.2` is written to fail fast if the assumption is false. **S56 to
S58 are the decided contract changes**, ordered by how silently each fails: an approver that is never
recorded, a generation number that collides without a trace, then a clone destroyed, but only on an
explicit operator override. **S59 to S62 are small and independent.** **S63 and S64 are maintainer
work**, last because neither changes behaviour; S64 follows S54 to S56 because those three edit the
surface files it consolidates.

## Contract gates

Items in `20-contract.md` § Unresolved block specific slices. Each is a contract amendment,
committed separately and before the handler work depending on it. **No slice may introduce a
signature absent from the contract** — where a slice needs tools, amending the contract is its
first acceptance criterion, not an implementation detail.

**No gate is live.** Five were raised by this document on 2026-10-08 and met by their own slices:
`S54.1`, the re-enrolment gate in § *The HTTP API route table*; `S55.1`, the MCP route's `GET`
stream; `S56.1`, the approving operator as an MCP grant's subject; `S57.1`, the generation
high-water mark and migration 0003; and `S58.1`, the corrupt-tree override's quarantine.

Before these, the last gate was `S46.10`, raised by this document on 2026-10-03. The amendment
of that date (**#343**) gave `ExecError` a `signalled` variant and made a signalled mutating call park
its journal entry, as a `timed-out` one does, but fixed only *that* the entry parks and not *how* the
park is reached. The amendment that PR #345 merged closed the gap: a signalled mutating call parks
through a `ParkSink`, and `HostError` gains `signalled`. S46 has landed.

Two earlier gates closed on and after 2026-09-28. S41's gate, `S41.7`, was met by the amendment
that PR #328 merged (**R12**), and S41 has landed. **S49's gate, raised by this document on
2026-09-25,** was `S49.1`: the watcher has to pin an auto-merge to the commit it pushed (#77), and
`pr_enable_auto_merge`'s input carried no expected head, so adding one changed a registered MCP tool's
public input. That amendment was committed separately and before the rest of S49, and S49 has landed.

**No U-item is live.** `20-contract.md` § Unresolved records every U-item from U1 to U10 resolved, the
last two on 2026-08-19 by S18 and S19; that section is the authority for which slice closed which
gate and on what date, and it is not restated here. The one gate this document raised itself — the
**consumer-extension seam for tools**, which the contract fixed for the console half and not the
other — was `S35.1`, committed separately and before the rest of S35, exactly as every earlier gate
was. S35 has landed and that gate is closed.

Naming a gate here is not the same as recording it in § Unresolved, which is `/design`'s to write.
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

Nothing S39, S20, S37, S38, S21 or S22 needed was unfixed in the contract, checked against it
rather than remembered: S37 used the console registration and filtering the contract already fixes;
S38 used the file-watcher plan/apply protocol U10 resolved, whose plan entry the same 2026-08-23 pass
confirmed is gated by nothing at dispatch and intended to be; and S39's four surfaces are each fixed
by name. None of them opened with an amendment criterion.

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

## Outstanding

Eleven slices, S54 to S64, appended 2026-10-08 from the open-issue backlog. The other fifty-three
are landed and indexed below.

## S54 — A recovery code forces re-enrolment before anything else
Delivers: An operator who signs in with a recovery code must set up a new authenticator before the
console or API will do anything else for them. Today only the console's own screen asks; every other
route keeps serving the session, so a stolen recovery code buys a full session with no new factor.
Touches: `design/20-contract.md` § cookie routes and the recovery-code error row;
`src/surfaces/console-auth-routes.ts` (`requireSession`); `src/operator-identity/`.
Depends on: none
Status: done
Closes: #276
Acceptance:
  - S54.1 The contract states that "forces TOTP re-enrolment" is a server-side session gate, names the
    routes a session with `totp_reenrol_required` set may still reach (`/auth/totp-reenrol/begin`,
    `/auth/totp-reenrol/complete`, logout, and the session read the console needs to show the
    re-enrolment screen), and names the refusal every other cookie route returns. Committed before
    S54.2.
  - S54.2 With `totp_reenrol_required` set, every cookie route outside S54.1's list refuses with the
    named refusal and performs no side effect. The test walks every cookie route in the route table, so
    a route added later without the gate fails it.
  - S54.3 After `completeTotpReenrol` succeeds, the same session reaches every cookie route again
    without signing in a second time.
  - S54.4 Each refused request is audited once, under the operator, naming the route.
Out of scope: changing how recovery codes are issued, burned or counted. Bearer-token routes.

## S55 — A connected agent hears when its tools change
Delivers: An agent that stays connected across a redeploy, or whose access is narrowed, is told its
tool list has changed and fetches the new one, instead of carrying on with a list the server no longer
honours.
Touches: `design/10-design.md` and `design/20-contract.md` § MCP transport; `src/surfaces/mcp-routes.ts`;
`src/authorization/` (grant narrowing and epoch); `src/mcp-proxy/proxy.ts`.
Depends on: none
Status: done
Closes: #136
Acceptance:
  - S55.1 The design and contract are amended before any code: the MCP route serves the Streamable
    HTTP server-to-client stream (`GET` with `text/event-stream`, bound to the `Mcp-Session-Id` an
    `initialize` minted, authenticated the same way as `POST`), `initialize` advertises
    `capabilities.tools.listChanged: true`, and the contract names exactly which events send
    `notifications/tools/list_changed`: a grant narrowed or its epoch advanced, and a session that
    survives a boot with a different contract fingerprint. Committed separately and first.
  - S55.2 A real `@modelcontextprotocol/sdk` client, connected through the route, receives
    `notifications/tools/list_changed` within 2 seconds of its grant being narrowed, and the next
    tool list it fetches omits the removed tool. This is the first behaviour test written: if the SDK client
    does not open or honour the stream, the slice stops and reports it.
  - S55.3 A stream opened without a valid bearer, or for a session id the route did not mint, is
    refused with the same `401` challenge `POST` uses, and opens nothing.
  - S55.4 Revoking a grant closes every stream bound to it; the server never reopens a closed stream.
  - S55.5 The stdio proxy forwards `notifications/tools/list_changed` from the remote to its local
    client.
  - S55.6 Open streams per grant are capped by a named constant; a stream over the cap is refused
    rather than evicting an existing one.
Out of scope: resource or prompt change notifications. Any server-to-client message other than
`notifications/tools/list_changed`. Persisting MCP sessions across a restart.

## S56 — Every MCP grant names the operator who approved it
Delivers: An operator reading the audit trail or the grants screen can see which operator admitted
each agent, not only which client asked.
Touches: `design/20-contract.md` § `Grant.subject`; `src/surfaces/mcp-routes.ts` (consent POST,
authorization code record, token exchange); `src/authorization/`.
Depends on: none
Status: done
Closes: #292
Acceptance:
  - S56.1 The contract states that a newly approved MCP grant's `subject` is the approving operator and
    its `clientId` is the requesting client, and that grants issued earlier keep the client id as
    subject. Committed before S56.2.
  - S56.2 The authorization code record carries the operator subject from the consent POST's session;
    the grant issued from it has `subject` set to that operator and `clientId` set to the client.
  - S56.3 Issuance is audited with the approving operator as actor and the client id in the record.
  - S56.4 A grant issued before this change still lists, verifies and revokes unchanged.
  - S56.5 The comment above `MAX_PENDING_AUTHORIZATIONS` in `src/surfaces/mcp-routes.ts` no longer says
    `oauth_client` rows are bounded by disk, and a route-level test shows `/oauth/revoke` answers `200`
    for an unknown token, a live one and an already-revoked one.
Out of scope: backfilling a subject onto existing grants. Changing the consent screen's content.

## S57 — A generation number is never issued twice
Delivers: An operator who removes a repository and declares it again gets a fresh generation, so old
journal entries and audit records can never be mistaken for the new one's.
Touches: `design/20-contract.md` § data model and R4; `src/store/` (a new migration);
`src/declarations/declarations.ts`.
Depends on: none
Status: done
Closes: #288
Acceptance:
  - S57.1 The contract adds a persisted per-declaration-id generation high-water mark that survives
    removal, and the migration that creates it and backfills it from the highest generation already in
    `declaration`. Committed before S57.2.
  - S57.2 Declare, remove, declare again: the second declaration's generation is greater than every
    generation the id ever had, including the removed one.
  - S57.3 The migration runs against a store copied from before it, backfills the mark per id, and the
    migration-matches-contract check passes on it.
  - S57.4 The declaration and the high-water write happen in one transaction; a forced failure between
    them leaves neither.
Out of scope: renumbering existing rows. Changing what `Journal.unsettled` selects on.

## S58 — A corrupt clone is set aside, never destroyed
Delivers: When an operator overrides the safety check on a clone the service cannot read, its
contents are moved aside where they can still be recovered, instead of deleted.
Touches: `design/10-design.md` and `design/20-contract.md` § L1 clone store and health;
`src/clone/clone-store.ts`; the health view and console.
Depends on: none
Status: done
Closes: #287
Acceptance:
  - S58.1 The design and contract are amended before any code: `permitCorruptTree` moves the clone
    directory to a named quarantine location on the volume, clears the clone row, counts the
    quarantined directory as a volume consumer, and lists it in health; only an operator action deletes
    it. Committed separately and first.
  - S58.2 Overriding on a clone whose `.git` cannot be read leaves every original file present under
    the quarantine location, byte for byte, and no row for the clone.
  - S58.3 Disk accounting and the health view both report the quarantined directory and its size.
  - S58.4 An operator can delete a quarantined directory; a read-only operator token and any MCP grant
    cannot, and the deletion is audited.
  - S58.5 The clone can be materialised again afterwards at its original path.
Out of scope: automatic repair of a corrupt tree. Retention or expiry of quarantined directories.

## S59 — A check wait measures time with a clock that cannot jump
Delivers: An operator waiting on pull-request checks gets a wait that ends at its limit and a waited
time that is true, even if the host clock is stepped mid-wait.
Touches: `src/host/host-operations.ts`.
Depends on: none
Status: done
Closes: #365
Acceptance:
  - S59.1 `checks_await`'s deadline and its reported `waitedSeconds` are measured from
    `clock.monotonicMs()`; no duration in `src/host/` subtracts two `now()` readings.
  - S59.2 With the wall clock stepped forward one hour mid-wait, the wait does not end early; stepped
    back one hour, it still ends at its limit. Both report the monotonic elapsed time.
Out of scope: changing the wait's limits or poll interval.

## S60 — A grant shows how many sessions are live
Delivers: An operator looking at a grant sees how many client sessions can still continue under it,
instead of a figure that is always zero.
Touches: `src/authorization/authorization.ts` (`listGrants`); the grants view.
Depends on: none
Status: done
Closes: #140
Acceptance:
  - S60.1 `GrantView.liveSessions` is the count of the grant's refresh tokens that are unrevoked and
    unexpired, computed at read time in the same read as `activeTokens`; a revoked grant shows `0`.
  - S60.2 A test issues two refresh tokens under one grant, then revokes one and expires the other, and
    the count reads 2, 1, 0.
Out of scope: a session registry. Counting stdio or console sessions.

## S61 — The dispatch pipeline always has its journal
Delivers: A maintainer can no longer compose a dispatch pipeline that silently skips recording
intent, because the journal is a required dependency rather than an optional one.
Touches: `src/dispatch/dispatch-pipeline.ts`; its callers and tests.
Depends on: none
Status: todo
Closes: #216
Acceptance:
  - S61.1 `DispatchPipelineDependencies.journal` is required; the expired "required only once S7
    ships" comment is gone, and the type check fails on a caller that omits it.
  - S61.2 Every branch that tested for an absent journal is removed, and the full test suite passes.
Out of scope: changing what the journal records.

## S62 — The storage guidance says where single-instance ownership stops
Delivers: An operator deploying the service is told plainly that a network share is not supported
storage, and why, instead of reading a design that claims protection the boot check cannot give.
Touches: `design/10-design.md` (the two-instances failure mode and boot step 1);
`docs/operator-guide.md`.
Depends on: none
Status: todo
Closes: #135
Acceptance:
  - S62.1 `10-design.md`'s claim about two instances against one volume states what boot's self-test
    proves (exclusion between processes on one kernel) and what it cannot see (lock loss across hosts
    on a network share), citing S30 and the 2026-10-08 decision.
  - S62.2 `docs/operator-guide.md` states that `VOLUME_ROOT` must be a local or container-managed
    volume and that CIFS/SMB and NFS shares are unsupported, naming the failure: two instances both
    start and both report healthy.
  - S62.3 The design check reports no new finding.
Out of scope: changing the lease or the self-test.

## S63 — The contract's registry tables are generated from the tools
Delivers: A maintainer who changes a tool's declaration finds the contract's table for it updated by a
generator and checked by the build, instead of having to remember to edit it by hand.
Touches: `scripts/` (a generator and an integrity check, after `generate-migration-0001.ts`);
`design/20-contract.md` registry tables; the build script.
Depends on: none
Status: todo
Closes: #150
Acceptance:
  - S63.1 A generator produces the contract's registry tables from the tree's `ToolDeclaration` values.
  - S63.2 An integrity check in the build fails when the committed tables differ from the generator's
    output; shown failing on a deliberately edited table and passing on the real one.
  - S63.3 The committed tables are replaced by the generated output, with the content diff showing no
    lost value.
Out of scope: changing the table format to suit the generator. If the generator cannot express the
current tables without loss, the slice stops and reports it.

## S64 — One JSON helper for every HTTP surface
Delivers: A maintainer changing how the service reads a request body or writes a JSON response does it
in one place, with each route's size limit still stated where the route is.
Touches: `src/surfaces/` (every file defining `sendJson` or `readJsonBody`); a shared helper.
Depends on: S54, S55, S56
Status: todo
Closes: #65
Acceptance:
  - S64.1 One shared helper owns JSON response writing and request-body parsing; no file under
    `src/surfaces/` defines its own `sendJson` or `readJsonBody`.
  - S64.2 Every route keeps its existing body-size limit, passed explicitly; a test per distinct limit
    shows a body at the limit accepted and one byte over refused.
Out of scope: changing any limit, route payload or status code.

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
| **S20** | The blog's authoring tools run on this runtime | [#34](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/34) |
| **S39** | A consumer's own operations are reachable from an agent | [#171](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/171) |
| **S37** | The blog's authoring screens appear, and only for the blog | [#157](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/157) |
| **S38** | The blog's watched files become pull requests | [#158](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/158) |
| **S21** | A second repository, driven end to end, unwatched | [#35](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/35) |
| **S22** | The deployment is verifiable, reversible and documented | [#36](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/36) |
| **S40** | Only the operator's own console can clear what needs attention | [#308](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/308) |
| **S41** | Terminal outcomes and parked work reach the operator | [#309](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/309) |
| **S42** | Recovery never strands a clone, and never waits for a caller | [#310](../../issues/310), closed | S42.1–S42.7 | `8a89cf0` |
| **S43** | Boot keeps its evidence, and its steps in order | [#311](../../issues/311), closed | S43.1–S43.4 | `8a89cf0` |
| **S49** | A watcher's auto-merge only merges the commit it pushed | [#317](../../issues/317), closed | S49.1–S49.6 | `8a89cf0` |
| **S44** | A clone on disk is exactly what it claims to be | [#312](../../issues/312), closed | S44.1–S44.5 | `8663eee` |
| **S45** | Composites keep what they did not merge | [#313](../../issues/313), closed | S45.1–S45.5 | `8663eee` |
| **S46** | Every error names what actually happened | [#314](../../issues/314), closed | S46.1–S46.13 | `0b88d38` |
| **S47** | Nothing waits forever, and a busy store is retried | [#315](../../issues/315), closed | S47.1–S47.4 | `0b88d38` |
| **S48** | The console and the health view show what is real | [#316](../../issues/316), closed | S48.1–S48.5 | `0b88d38` |
| **S53** | A tampered watcher folder stops delivery, and the operator hears once | [#330](../../issues/330), closed | S53.1–S53.10 | `f3f0d7b` |
| **S50** | Every watcher outcome is audited, and every failure is told | [#318](../../issues/318), closed | S50.1–S50.7 | `6ef5231` |
| **S51** | A watched repository clones itself on first use | [#319](../../issues/319), closed | S51.1–S51.3 | `c87b475` |
| **S52** | The watcher is proven against a real repository | [#320](../../issues/320), closed | S52.1–S52.6 | `2aa6647` |

Three rows carry a name this document changed after the issue was opened: #31 is titled "A dropped
file becomes a pull request…" and #92 "A consumer can declare a safe content-drop protocol", both
predating the 2026-08-11 rename to file-watcher terminology, and #34 "S20 — `SubZeroDev.Blog` runs
as a consumer, with parity measured", predating the rename recorded above. All three issues are
closed and none is edited — reported here rather than reconciled.
