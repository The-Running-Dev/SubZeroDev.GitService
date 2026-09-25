# Slices — SubZeroDev.Git

Derived from `10-design.md` and `20-contract.md`. Fifty-two vertical slices. Each one ends
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
[#34](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/34) closed on 2026-08-23 still
carrying the old title. Its criteria were synced and are the narrowed set, so the title is the only
half that went unreconciled, and it is now one of the superseded names the note under the landed
index records rather than drift `/track` can still act on.

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
helper refactor are deliberately not sliced: each belongs to `/design`, `/contract`, the kit, or
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

**The watcher runs last, as S49 to S52, and in dependency order.** S49 is contract-gated (§ *Contract
gates*, below) and carries the SHA the rest of the watcher work names in its notices. S50 finishes the
audit and notification path over it, S51 fixes a first-use gap on the same tick protocol, and S52 is
the evidence harness that can only prove the corrected outcomes once all three have landed.

## Contract gates

Items in `20-contract.md` § Unresolved block specific slices. Each is a contract amendment,
committed separately and before the handler work depending on it. **No slice may introduce a
signature absent from the contract** — where a slice needs tools, amending the contract is its
first acceptance criterion, not an implementation detail.

**One gate is live: S49, raised by this document on 2026-09-25.** The watcher has to pin an auto-merge
to the commit it pushed (#77), and `pr_enable_auto_merge`'s input carries no expected head today. Adding
one changes a registered MCP tool's public input, so it is a contract amendment and not an
implementation detail. `S49.1` is that amendment, committed by `/contract` (opus, high) separately
and before the rest of S49. `/slice` refuses S49 until `S49.1` is met. The amendment decides the
field's name, whether it is optional for callers other than the watcher, and what the persisted
pending record carries. This section only names the gate.

**No U-item is live.** `20-contract.md` § Unresolved records every U-item from U1 to U10 resolved, the
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

Thirteen slices, S40 to S52, appended 2026-09-25. The first thirty-nine are landed and indexed below.

## S40 — Only the operator's own console can clear what needs attention

Delivers: An operator can hand a script a read-only token without that script being able to resolve a
parked operation or clear a failing credential. Someone with no credentials at all can no longer fill
the service's disk with client registrations, or its audit trail with revocations that revoked
nothing.
Touches: `src/surfaces/http-server.ts` (the two mutating attention routes), `src/surfaces/mcp-routes.ts`
(client registration, token revocation), `src/authorization/authorization.ts` (`registerClient`,
`revokeBearerToken`), `design/20-contract.md` (**A11**'s status note).
Depends on: none
Closes: #67, #275, #291
Acceptance:
  - S40.1 `POST /parked-operations/{operationId}/resolve` and
    `POST /failing-credentials/{credentialRef}/{declarationId}/clear` refuse a bearer credential. This
    holds for an operator-api token with every scope and for one whose only scope is `read`. Each
    refusal changes nothing: the parked entry stays parked and the failing mark stays set.
  - S40.2 Both routes accept an authenticated cookie session with a valid double-submit CSRF token, and
    refuse the same session without one. The CSRF check runs on every request to these routes, not only
    on some credential paths.
  - S40.3 `GET /health` and `GET /parked-operations` still accept both a bearer credential holding
    `read` and a cookie session, exactly as before.
  - S40.4 **A11**'s "specified, not yet held" note in `design/20-contract.md` is removed in the same
    change, along with the code comment in `http-server.ts` that defers the question to U4.
  - S40.5 `POST /oauth/register` refuses a registration once the stored client count reaches a
    deployment-fixed cap. The cap is declared beside the existing pending-authorization cap, and the
    refusal stores nothing. A test registers up to the cap and asserts the next one is refused.
  - S40.6 `POST /oauth/revoke` answers 200 for a known token, for an already-revoked token and for a
    token that never existed.
  - S40.7 Only a revocation that changed a stored row appends an audit record. That record's actor is
    `kind: 'mcp'` with the revoked token's own client id and grant id, never an operator subject. A test
    revokes a token that does not exist and asserts the audit chain length is unchanged.
Out of scope: TOTP re-enrolment enforcement (#276) and the approving operator on a grant (#292). Both
are decision-gated and wait for `/contract`. So is any change to which capabilities § *Scopes* makes
console-only.

## S41 — Terminal outcomes and parked work reach the operator

Delivers: An operator is told when a pull request hits a merge conflict, when a required check fails,
when a wait times out, and when the service parks an operation for them. Today each of these happens
silently, and the operator only finds it by going to look.
Touches: `src/host/host-operations.ts`, `src/dispatch/dispatch-pipeline.ts`,
`src/composition-root/compose.ts` (the terminal-state sink), `src/lifecycle/recovery.ts`,
`src/journal/`, `design/20-contract.md` (§ *Error semantics › Host adapter*, **R11**),
`design/10-design.md` (control-flow step 11, § *Failure modes*, § *Module boundaries*).
Depends on: none
Closes: #49, #266, #272
Acceptance:
  - S41.1 A composition-root-owned sink keyed on `operationId` carries a `TerminalState` from the host
    call that observed it to that operation's `Journal.settle`. `host-operations.ts` writes the sink on
    `merge-conflict`, `required-check-failed` and `wait-timeout`. The pipeline reads and deletes the
    entry immediately before `settle` and passes it in place of `null`.
  - S41.2 Dispatching a host call that ends in each of those three conditions leaves exactly one outbox
    row at `attention` naming that terminal kind. It is written in the same transaction as the settle.
  - S41.3 After every settle, whether successful, failed or terminal, the sink holds no entry for that
    `operationId` (**R11**). A host call that fails for any other reason writes nothing to the sink and
    enqueues no terminal notification.
  - S41.4 Every park path — recovery's park and the pipeline's timeout park — leaves exactly one outbox
    row of kind `operation-parked` at `attention` for the parked `operationId`. A park whose journal
    write fails leaves none.
  - S41.5 A mutating call that times out has its audit record appended before the journal park, as on
    every other park path. A test asserts the audit row exists for that `operationId` and was written
    before the park.
  - S41.6 In the same change, remove the four `design/` sites #49 names and **R11**'s "specified, not
    yet held" note. The § *Module boundaries* Scheduler row states the edge that actually exists
    afterwards.
Out of scope: making `Journal.classify` terminal-aware. It stays terminal-blind by decision (#49,
**R3**). Adding a field to `ToolResult` is `/design`'s. Recovery's other defects are S42's.

## S42 — Recovery never strands a clone, and never waits for a caller

Delivers: An operator whose service crashed mid-operation gets every interrupted operation either
finished or parked where they can resolve it. That happens without anyone having to touch the affected
repository first, and without a clone left flagged in a state nothing can clear.
Touches: `src/lifecycle/recovery.ts`, `src/composition-root/compose.ts` (the post-boot sweep),
`src/journal/journal.ts`, `design/20-contract.md` (§ *L1 — lifecycle*).
Depends on: S41 (the park notification)
Closes: #265, #267, #289
Acceptance:
  - S42.1 Recovery marks a clone `needs-attention` only after `journal.park` has succeeded. When the
    park write fails, the clone stays `recovery-pending`, no attention mark is written, and the failure
    is returned as `infrastructure`. A test injects the park failure and asserts all three.
  - S42.2 When recovery's `unsettled()` read fails, the clone stays `recovery-pending` and the call
    returns `infrastructure`. It is not marked `needs-attention`. A test injects the read failure and
    asserts both.
  - S42.3 Every clone recovery marks `needs-attention` has a parked journal entry that
    `resolveParkedOperation` accepts. A test resolves one and asserts the clone leaves
    `needs-attention`.
  - S42.4 A resume step that dispatches successfully is followed by a re-classification of the entry. The
    entry is settled only when that verdict is `completed`; any other verdict parks it. A test whose
    resume succeeds but leaves the operation incomplete asserts it is parked, not settled.
  - S42.5 Once boot reports ready, one background pass recovers every declaration left
    `recovery-pending`. It recovers them one at a time, under the same lock rules first use follows. It
    does not hold the process open (unref'd), and it runs once per boot.
  - S42.6 A test races the sweep against an ordinary first use of the same declaration and asserts first
    use wins: that declaration is recovered exactly once, by first use, and the sweep skips it.
  - S42.7 The "specified, not yet held" note on `20-contract.md` § *L1 — lifecycle* is removed in the
    same change.
Out of scope: making the journal a required pipeline dependency (#216, a decision). Changing what a
resume step is, or which operations have one.

## S43 — Boot keeps its evidence, and its steps in order

Delivers: An operator investigating an outage can trust that a lease takeover is on record even when
the boot that took over then failed. They can also trust that every held job is re-checked against
current authority on every boot, rather than some slipping through a race.
Touches: `src/lifecycle/boot.ts`, `src/lifecycle/lease.ts`, `src/scheduler/scheduler.ts`.
Depends on: none
Closes: #273, #274
Acceptance:
  - S43.1 Suppose a boot took over the lease and then failed at a step before its takeover was audited,
    including every pre-migration failure path. The next boot then audits a takeover whose previous
    holder is the instance the failed boot took over from. A test drives each such failure path and
    asserts the record.
  - S43.2 A boot that took over nothing, and fails, leaves no lease file behind. An orderly release's
    existing behaviour is unchanged.
  - S43.3 Boot step 7's revalidation starts only after step 6 has finished writing every job it returns
    to `pending`. A test holds step 6's journal read open and asserts that a job step 6 then returns to
    `pending` is revalidated in the same boot.
  - S43.4 The code comment claiming the two steps are independent is removed.
Out of scope: the lease self-test's blind spot on non-locking filesystems (#135, a decision). Making the
audit chain writable before migration.

## S44 — A clone on disk is exactly what it claims to be

Delivers: An operator can trust that a clone the service calls ready really is complete, was fetched
with the credential its repository declares, and is only released when no generation of that
repository still has work in it. A busy lock tells them to retry rather than reporting that something
is broken.
Touches: `src/clone/clone-store.ts`.
Depends on: none
Closes: #270, #282, #283, #290, #284 (item 2 only)
Acceptance:
  - S44.1 A credential that fails to resolve aborts a first clone and surfaces the credential error under
    its existing result kind. This covers no resolver configured, a reference that is not permitted, and
    a secret that is unavailable. No directory is left behind. Only an explicit `credentialRef: null`
    clones anonymously.
  - S44.2 Boot re-derivation and `ensure` both recognise a directory left by a crash mid-clone, and
    remove it rather than adopting it as `ready`. A test plants such a directory, restarts, and asserts
    the next `ensure` re-clones.
  - S44.3 A lock refusal inside `ensure` returns `conflict`, not `store-failed` or `infrastructure`.
  - S44.4 `isSafeToEvict` with `acrossAllGenerations: true` counts unsettled journal entries from every
    generation of the declaration. With `false`, it counts only the stored row's generation. A test
    with an unsettled entry on an earlier generation gets opposite answers for the two values.
  - S44.5 No path returns `needs-attention` for a clone with no row and no directory.
Out of scope: quarantining a corrupt tree instead of deleting it (#287, gated on `/design`), and
generation high-water marks (#288, gated on `/contract`).

## S45 — Composites keep what they did not merge

Delivers: An operator whose pull request just merged keeps any local commits that never made it into
the merge. A repository with an unreadable configuration is reported as a problem with that
repository, not with the service. A credential the git host rejects is remembered as failing on every
path.
Touches: `src/composites/composites.ts`, `src/git/git-operations.ts`, `src/git/primitives.ts` (new),
`src/exec/primitives.ts`, `src/host/host-operations.ts`.
Depends on: none
Closes: #61, #268, #271, #285
Acceptance:
  - S45.1 After a merge, the local branch is deleted only when its tip equals the merged pull request's
    head commit, and never with a force flag. Otherwise the branch is kept, and the result reports that
    no branch was deleted and why.
  - S45.2 A test adds a local commit past the merged head and asserts the branch and commit survive.
  - S45.3 Both composites return `precondition` with findings for an unparseable repository
    configuration. The findings match what the direct git tools return for the same file.
  - S45.4 An `auth-rejected` result from the host adapter calls `markFailing` for the credential, as the
    git path does. A test asserts the mark is set after a host rejection.
  - S45.5 `revParse`, `isAncestor` and `currentBranch` live in `src/git/primitives.ts`.
    `composites.ts` and `git-operations.ts` call the shared versions and hold no private copies. The
    existing normalisation holds: `null` on failure, and a boolean from the exit status.
Out of scope: any rebase or force-delete path, which is blocked by the brief. Changing
`reconcile_after_merge`'s public input.

## S46 — Every error names what actually happened

Delivers: An operator reading a failure sees the cause that actually occurred. That rules out a
constraint violation labelled a duplicate, a killed child process labelled a spawn failure, or a store
fault labelled a delivery failure. An orphan report either states what is still in flight or refuses,
and never quietly says "nothing".
Touches: `src/declarations/declarations.ts`, `src/exec/exec.ts`, `src/credentials/credentials.ts`,
`src/credentials/declaration-credential.ts`, `src/notifier/notifier.ts`, `src/shared/diagnostics.ts`,
`src/surfaces/mcp-routes.ts`, `src/shared/result-kind.ts`.
Depends on: none
Closes: #248, #269, #284 (items 1 and 3–7)
Acceptance:
  - S46.1 `declare` returns `already-exists` only when the id already exists. Any other constraint
    violation returns `store-failed`.
  - S46.2 A child process killed by a signal is not reported as `spawn-failed`.
  - S46.3 An unreadable mark store or allowlist manifest is not reported as `reference-unreadable`.
  - S46.4 A declaration credential outside the permitted hosts returns `host-not-permitted`, not an
    untyped authorization error.
  - S46.5 A notifier store failure is not reported as `delivery-failed`.
  - S46.6 `durationMs` is measured on a monotonic clock, never by subtracting two wall-clock readings.
  - S46.7 An MCP tool result sets `isError` true only for `upstream`, `timeout` and `infrastructure`.
    It uses the existing `isError(kind)` helper, and a test covers every `ResultKind`.
  - S46.8 `orphan` reads the declaration's unsettled journal entries before the state flip. A failed
    read fails the orphan with `store-failed` and leaves the declaration `active`. A successful read's
    operation ids appear in `retainedJournalEntries`.
  - S46.9 Tests cover the orphan read three ways: an unsettled entry (its id is reported), a clean
    journal (an empty list), and a failed read (a refusal, never an empty list). The code comment
    claiming the clone store accepts the same ambiguity is removed.
Out of scope: the `sendJson`/`readJsonBody` consolidation (#65, `/fix`). Adding error variants the
contract does not already declare. If an item above needs one, stop for `/contract`.

## S47 — Nothing waits forever, and a busy store is retried

Delivers: A slow or hung module tool, or a stalled outbound HTTP response, is cut off at the limit it
declared rather than tying up the service indefinitely. A moment of database contention is waited out
instead of failing the caller outright.
Touches: `src/dispatch/dispatch-pipeline.ts` (`buildContext`), `src/module-adapter/module-adapter.ts`,
`src/http/http-adapter.ts`, and the ten store connections outside the lease: `src/audit/audit.ts`,
`src/declarations/declarations.ts`, `src/credentials/credentials.ts`, `src/clone/clone-store.ts`,
`src/authorization/authorization.ts`, `src/journal/journal.ts`, `src/notifier/notifier.ts`,
`src/scheduler/scheduler.ts`, `src/store/structured-store.ts`,
`src/operator-identity/operator-identity.ts`.
Depends on: none
Closes: #279, #280, #281
Acceptance:
  - S47.1 A module tool call's context deadline is its start time plus its declared `timeoutSeconds`.
    The call is aborted and returns `timeout` once that elapses. A test with a handler that never
    settles asserts `timeout` within the declared bound.
  - S47.2 The HTTP adapter's timeout covers reading the response body. A test whose server sends headers
    and then stalls the body asserts `timeout`.
  - S47.3 Each of the ten store connections sets one shared, non-zero busy timeout. The lease's
    immediate-failure connection is unchanged.
  - S47.4 Lock contention is retried with bounded backoff. A test holding a write lock for less than the
    bound asserts that the second writer succeeds. Holding it past the bound returns `infrastructure`.
Out of scope: changing any declared `timeoutSeconds` value. A retry policy on anything other than store
contention.

## S48 — The console and the health view show what is real

Delivers: An operator sees only the console screens their access actually permits. The health view
shows the real volume usage and the notifications that are stuck because no delivery channel is
configured, instead of a zero and a silence.
Touches: `src/surfaces/declaration-routes.ts` (`serializeDeclaration`), `src/surfaces/http-server.ts`
(`HealthReport`), `src/composition-root/compose.ts`, `console/src/api.ts`,
`console/src/view-registry.ts`, `console/src/Landing.tsx`, `design/20-contract.md` (**A12**'s status
note).
Depends on: none
Closes: #144, #277, #278
Acceptance:
  - S48.1 `GET /declarations` and `GET /declarations/{declarationId}` return `effectiveGrant` beside the
    unchanged `capabilityGrant`. It is computed server-side by `Declarations.effectiveGrant`.
  - S48.2 `eligibleViews` and the landing screen filter on `effectiveGrant`. A test declares a grant
    containing a capability the ceiling excludes and asserts the matching view is not offered.
  - S48.3 **A12**'s "specified, not yet held" note is removed in the same change.
  - S48.4 The health report carries the clone store's real volume-usage figure. The hard-coded
    placeholder and its stale comment are gone. A test writes a known-size clone and asserts a non-zero
    figure.
  - S48.5 The health report carries a count of outbox rows held `pending` because no transport is
    configured, reported separately from failed rows. A test enqueues with no transport and asserts the
    count.
Out of scope: `GrantView.liveSessions` (#140, a decision). Any new console view.

## S49 — A watcher's auto-merge only merges the commit it pushed

Delivers: An operator can trust that a pull request the file watcher opened is only ever merged at the
exact commit the watcher pushed. If anyone moves the branch after that, the merge refuses instead of
carrying their change in under the watcher's name.
Touches: `design/20-contract.md` (the amendment), `src/watcher/watcher.ts`,
`src/watcher/pending-pull-requests.ts`, `src/watcher/types.ts`, `src/host/types.ts`,
`src/host/github-adapter.ts`.
Depends on: none. **Contract-gated** — see § *Contract gates*.
Closes: #77
Acceptance:
  - S49.1 **The contract amendment is committed first**, by `/contract`. It fixes the expected-head
    input on `pr_enable_auto_merge` and the head SHA carried by the watcher's persisted pending record.
    `/slice` does not start the rest of S49 until this is met.
  - S49.2 A pending watcher PR record includes the validated head SHA that `git_push` returned. A record
    whose SHA is missing or malformed fails closed and invokes no host operation.
  - S49.3 `pr_enable_auto_merge` passes the expected head to the GitHub CLI as its match-head-commit
    guard. A test asserts the flag and value on the constructed invocation.
  - S49.4 Every reconciliation poll supplies the persisted SHA rather than the SHA from the latest
    status read.
  - S49.5 A test moves the PR head after the push and asserts that neither auto-merge nor reconciliation
    treats the new head as the watcher's commit.
  - S49.6 The watcher gains no direct-merge or rebase path. Auto-merge through the host stays its only
    merge route.
Out of scope: the audit and notification of a failed auto-merge (S50). Any other caller of
`pr_enable_auto_merge`.

## S50 — Every watcher outcome is audited, and every failure is told

Delivers: An operator learns about every file the watcher failed to deliver and every pull request it
could not finish reconciling, with enough detail to act. That includes the failures that today only
reach a console log, or nothing at all. Removing a repository cannot discard a pull request the watcher
is still following.
Touches: `src/watcher/watcher.ts`, `src/watcher/types.ts`, `src/declarations/declarations.ts`
(`remove`).
Depends on: S49 (the SHA named in S50.4)
Closes: #81, #82, #84, #88
Acceptance:
  - S50.1 A terminal move that fails is audited and notified at `attention`, including a refusal on a
    tampered state directory. It never escapes the tick unrecorded.
  - S50.2 An exception escaping a watcher tick is audited and notified at `attention`, not only written
    to the console.
  - S50.3 A failed `pr_enable_auto_merge` after `pr_open` succeeded leaves the file in `processed/`. It
    is audited and notified at `attention` naming the open pull request, and never moved to `failed/`.
  - S50.4 Once a pull request reports merged, the pending record is removed after the first
    reconciliation attempt. A successful reconciliation audits the normal terminal outcome. A failed one
    audits and notifies at `attention`, naming the PR, the branch, the pushed SHA and the failure
    reason.
  - S50.5 Tests drive both merged outcomes from a real merged-status fixture, not from a corrupted
    pending list.
  - S50.6 `declaration.remove` returns `watcher-directory-not-empty` while the pending list holds at
    least one entry for the declaration, counting those entries. An absent or empty list does not
    block, and removal deletes nothing.
  - S50.7 Production watcher code contains no `as never` casts.
Out of scope: deciding the state-directory tamper refusal behaviour — skip or throw, and invariant D18
(`90-decisions.md` § *Open*, `/contract`). S50.1 audits whatever that behaviour is, without choosing it.

## S51 — A watched repository clones itself on first use

Delivers: An operator who sets up a file watcher on a repository that has not been cloned yet, or whose
clone was cleaned up, sees the first dropped file processed. Today it sits until something unrelated
creates the clone. A clone with uncommitted changes is reported as exactly that, rather than as
needing attention.
Touches: `src/watcher/watcher.ts`.
Depends on: S50
Closes: #286
Acceptance:
  - S51.1 A watcher tick against an `absent` or `evicted` clone materialises it the way any other first
    use does, then applies the clean-tree gate on that same tick. A test drops a file for a
    never-cloned declaration and asserts a pull request is opened on the first tick.
  - S51.2 A dirty clone is reported `clone-not-clean`, and only a clone genuinely in `needs-attention`
    is reported `clone-needs-attention`.
  - S51.3 A clone that fails to materialise is reported with its failure, not as
    `clone-needs-attention`, and the file stays in the inbox.
Out of scope: changing the tick protocol or the clean-tree gate itself.

## S52 — The watcher is proven against a real repository

Delivers: A maintainer can see the watcher's corrected behaviour demonstrated end to end, against a
real repository and remote. Today it is asserted against mocks that never stage, commit, lock or
rename anything, which cannot show parity with the blog's watcher that this one replaces.
Touches: `src/watcher/` tests and a test fixture (scratch clone, bare remote, constrained GitHub CLI
shim).
Depends on: S49, S50, S51
Closes: #87
Acceptance:
  - S52.1 Integration tests run the watcher against a scratch clone and a bare remote, with a
    constrained GitHub CLI shim or an equivalent host fixture.
  - S52.2 A test proves the order prepare, apply, stage, commit, push, open PR, and proves no outer
    mutation lock is held across it.
  - S52.3 Tests exercise real dirty trees, duplicate terminal names, interrupted claims, malicious links,
    and merged reconciliation success and failure.
  - S52.4 A platform prerequisite that cannot be met is detected and skipped with a recorded reason.
    Symlink creation on an unelevated Windows host is one such case.
  - S52.5 Every corrected outcome from S49 to S51 is demonstrated with audit and outbox evidence.
Out of scope: recreating the blog watcher's architecture. Adding new watcher behaviour.

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

Three rows carry a name this document changed after the issue was opened: #31 is titled "A dropped
file becomes a pull request…" and #92 "A consumer can declare a safe content-drop protocol", both
predating the 2026-08-11 rename to file-watcher terminology, and #34 "S20 — `SubZeroDev.Blog` runs
as a consumer, with parity measured", predating the rename recorded above. All three issues are
closed and none is edited — reported here rather than reconciled.
