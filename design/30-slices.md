# Slices — SubZeroDev.Git

Derived from `10-design.md` and `20-contract.md`. Thirty vertical slices. Each one ends
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
- **A re-run appends under `## Outstanding` only.** It never resurrects a landed body, and never
  renumbers or reuses a retired id.
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
requirement is reframed onto a filesystem that genuinely does not lock and becomes `S30.1`.

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

**S28 runs first among what remains, because S2's proof was taken behind an injected seam.**
`LockAcquirer` exists precisely because a volume that does not exclude cannot be produced on demand
in a test, so the property definition-of-done item 9 rests on has been demonstrated against a fake
and never against the deployment the brief describes. Everything after it — the derived image, the
parity migration, the rollback — assumes a container that has never been built. S29 follows it
because invariant B1 has no enforcement at all today, and the seam it protects is the one
`MCP-NEXT.md` Phase 8 exists to eventually cut.

**S30 finishes what S28 could not, and it is a proof rather than a feature.** S28 shipped the image
and demonstrated mutual exclusion, so definition-of-done item 9 is met. What it could not
demonstrate is the *guard* behind item 9 — boot's refusal to serve on a filesystem that does not
honour exclusion — because the deployment target turned out to honour it. That refusal is therefore
still the one safety branch in this system reached only through an injected seam, which is the same
objection S28 was written to answer, one level down. It runs ahead of S18 because it needs the image
S28 built and nothing else, and because a guard nobody has seen fire is worth less the longer the
system leans on it.

## Contract gates

Items in `20-contract.md` § Unresolved block specific slices. Each is a contract amendment,
committed separately and before the handler work depending on it. **No slice may introduce a
signature absent from the contract** — where a slice needs tools, amending the contract is its
first acceptance criterion, not an implementation detail.

Two gates are still live:

| Gate | Blocks | Answered by |
|---|---|---|
| **U4** — the HTTP route table | S18 | S18 |
| **U7** — the console element type and build entry | S19 | S19 |

The rest — U1, U2, U3, U5, U6, U8, U9 and U10 — were each resolved by the slice that needed them,
between 2026-08-03 and 2026-08-11. `20-contract.md` § Unresolved carries which slice closed which,
and on what date; it is not restated here.

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
| **S23** | A consumer can declare a safe file-watcher protocol | [#92](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/92) |
| **S24** | An unattended pull request is followed to its terminal state | [#93](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/93) |
| **S25** | Expired structured records release real disk space | [#94](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/94) |
| **S26** | Filesystem history ages out without losing the only copy | [#95](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/95) |
| **S27** | Disk pressure releases only disposable clones, or refuses clearly | [#96](https://github.com/The-Running-Dev/SubZeroDev.GitService/issues/96) |

Two rows carry a name this document changed after the issue was opened: #31 is titled "A dropped
file becomes a pull request…" and #92 "A consumer can declare a safe content-drop protocol", both
predating the 2026-08-11 rename to file-watcher terminology. Both issues are closed and neither is
edited — reported here rather than reconciled.

---

## Outstanding

## S28 — The service ships as a container, and a second one refuses the volume

Delivers: an operator can run the whole service from one container image against its own storage,
with secrets on a separate read-only mount and each watched inbox mounted from the host — and a
second container started against the same storage by mistake refuses to run rather than quietly
sharing the same repositories.

Touches: the image build definition, the deployment run configuration, deployment configuration
wiring at the composition root, Lifecycle (L1 — boot step 1's lock acquirer), Surfaces (L5 —
static console assets).

Depends on: S27 — it packages the service as every landed slice now leaves it.

Acceptance:
- S28.1 The image builds from a clean checkout and carries the `git` and `gh` executables `exec`
  invokes, each answering `--version` inside the container. A container started from it answers
  `/healthz` with `ready` true and a `commitSha` equal to the commit the image was built from,
  compared against the SHA the build recorded rather than against what the container reports about
  itself.
- S28.2 `src/contract/compiler.ts` is absent from the built image's filesystem, asserted by
  inspecting the image rather than the module graph. Invariant B8 is written about the runtime
  **image**, and the existing build check proves only that no runtime module imports the compiler.
- S28.3 The data volume, the credential mount and a watcher inbox are three separate mounts, and
  the credential mount is read-only: a write attempted into it from inside the container fails. A
  pre-migration store backup taken in the container contains neither a resolved secret nor the TOTP
  sealing key — invariant S5's separation, demonstrated on the real mount layout rather than on a
  temporary directory.
- S28.5 A second container started against the same named volume exits non-zero naming the first
  container's `instanceId`, `hostName` and `startedAt`. Definition-of-done item 9, at the level the
  brief states it.
- S28.6 Stopping and restarting the container preserves all four rows of the design's
  what-survives-a-restart table: a materialised clone, a declaration, an OAuth grant with a live
  refresh token, and an unsettled journal entry. Each is read back after the restart, and the
  journal entry is classified rather than lost.
- S28.7 Started against a container-managed named volume, boot's lease self-test passes — the real
  spawned-child test, on the real image, with no injected `LockAcquirer` — and the service serves.
  **Appended after S28.6 although it runs before it**, because it replaces the demonstrated half of
  the retired S28.4 and the id rules forbid renumbering; see § Criterion ids. The refusal half of
  S28.4 is not lost, it is S30.1.

Out of scope: publishing the image to a registry and provisioning the host that runs it — that is
the deployment S22 exercises; the derived consumer image (S19 and S20); off-volume backup, which
the design records as an accepted risk rather than a gap; and making boot's `lease-not-exclusive`
refusal fire against a real filesystem, which is S30.

---

## S29 — The layering is enforced by a check, and every gate runs unattended

Delivers: anyone changing this repository finds out immediately when a change breaks the boundary
that keeps the generic runtime separable from the git domain, and every check the repository
already has runs on every change rather than when someone remembers to run it.

Touches: the dependency-direction check script, the build script, the CI workflow definition.

Depends on: S28.

Acceptance:
- S29.1 A crafted import of an L2 module from L0, from L3, from L4 and from L5 each fails the check
  with a non-zero exit naming the importing file and the imported module. Four rejected fixtures
  against the accepted real graph, counts stated — invariant B1 has never rejected anything, and a
  validator that has never failed is not known to constrain anything.
- S29.2 The composition root is the only exempt path, and the exemption is a literal path rather
  than a directory: a fixture importing L2 from a file beside the root is rejected. Widening the
  exemption is therefore a one-line diff a reviewer sees.
- S29.3 The check runs inside `npm run build`, so it fails the same build that already fails on the
  compiler-import check and the migration check. Removing it from the build script makes the
  build script's own test fail.
- S29.4 A push and a pull request run typecheck, the full test suite, every `check:*` gate and
  S28's image build. A commit violating B1 fails the workflow rather than merging green,
  demonstrated once on a real branch.
- S29.5 The workflow pins Node to the `engines` range in `package.json`. A runtime outside that
  range fails the job rather than silently running every gate on a different one.

Out of scope: running the gates for the derived consumer image (S20); any deployment step in the
workflow. **This is this repository's own CI, not the service's execution mechanism** — the brief's
workflow-dispatcher non-goal is about how the service performs git operations and is untouched by
anything here.

---

## S30 — The lease guard refuses a filesystem that does not lock

Delivers: an operator who puts the service's storage somewhere that cannot actually keep two
instances apart — a network share, most obviously — is stopped at startup with a message naming the
problem, instead of getting a service that runs and quietly lets a second copy corrupt the same
repositories.

Touches: the deployment run configuration (a test-only mount overlay and its sidecar), Lifecycle
(L1 — boot step 1's self-test). **No production source change is expected**; if one turns out to be
needed, that is a defect and this slice stops on it.

Depends on: S28 — it needs the real image, and nothing else.

Acceptance:
- S30.1 The service container, started with its data volume on a real mount whose byte-range locking
  is genuinely absent — CIFS/SMB mounted `nobrl`, or NFS mounted `nolock`, served by a sidecar
  container — exits non-zero with `lease-not-exclusive`, naming the volume configuration. Against the
  real image, with no injected `LockAcquirer`. This is the first time invariant C7's refusal branch
  fires against a filesystem rather than a fake, and it carries the requirement retired from S28.4.
- S30.2 The same harness, same image and same command with only the data mount changed to a
  container-managed named volume, boots and serves. Without this the refusal in S30.1 is attributable
  to the harness rather than to the filesystem.
- S30.3 `lease-self-test-child.ts` is run directly inside the container against the S30.1 mount, as
  its own step rather than through boot, and exits `0` — `CHILD_ACQUIRED_EXIT_CODE`, meaning the
  filesystem granted a second process the same exclusive lock. Its exit code is stated. Boot maps
  every non-`3` exit to the same `lease-not-exclusive`, so a spawn failure and a permissive
  filesystem are indistinguishable in S30.1's result alone, and this is what tells them apart
  without instrumenting `childIsRefused`.
- S30.4 The mount configurations exercised are counted and each one's outcome stated: served,
  `lease-held`, or `lease-not-exclusive`. The set includes a bind-mounted Windows host path, recorded
  as **served** — the 2026-08-14 negative result, carried into the acceptance record rather than
  living only in the decision log, and the answer to issue #55.

Out of scope: changing `lease.ts`, `lease-self-test-child.ts` or the self-test protocol — if the
refusal does not fire on a mount whose locking is demonstrably absent, that is a defect in the
self-test and this slice stops and says so rather than adjusting the thing it is testing. Making a
non-locking mount a supported deployment configuration; it is exercised here only to prove it is
refused. Whether the design's named-volume requirement should soften to a recommendation given
S30.4's result — that is a `design/10-design.md` change and belongs to `/design`.

---

## S18 — The console is complete, and federated login works

Delivers: the repository dimension across every view, the three remaining operator views, and OIDC
against a real issuer.

Touches: Surfaces (L5), Operator identity (L4 — OIDC), Audit (L1 — query), Journal (L1 — parked).

Depends on: S29. **Gated on U4.**

Acceptance:
- S18.1 The route table is written into `20-contract.md` before any route is implemented.
- S18.2 Every view takes a repository, and the landing view lists declarations with clone state,
  current branch, dirty flag and last operation. Selecting one sets the dimension for every
  subsequent view.
- S18.3 The audit view filters by declaration, tool, actor and window, and shows chain state inline:
  verified through which sequence, which anchors cover aged-out segments, and where a break sits.
- S18.4 The health view surfaces failed outbox rows and failing credential references, and clearing
  a failing reference works from it.
- S18.5 The parked-operations view shows `preState`, the observed state and the diff, and drives the
  repair session from S8.
- S18.6 OIDC against a real issuer authenticates the operator; a returned subject off the allowlist
  is refused. **With the issuer unreachable, local password plus TOTP still works.**
- S18.7 Every view is driven end to end in a real browser against a real repository —
  definition-of-done item 19, which the prior art records as the only way two genuine bugs were
  found.
- S18.8 An operator whose `totp_reenrol_required` is set re-enrols TOTP from the console, the flag
  clears, and an `identity-event` record carrying `'totp-reenrolled'` is written. The signature is
  added to `20-contract.md` first, since none exists. S4 only ever sets the flag, so before this
  criterion the enum member is unreachable and the flag is write-only for the life of the
  credential — a recovery code burned once leaves the operator permanently marked and no route back.

Out of scope: consumer views (S19); restyling.

---

## S19 — A consumer can extend the console

Delivers: the base's console published as a versioned package, a derived build that consumes it, and
a console fingerprint verified at startup.

Touches: Surfaces (L5), Lifecycle (L1 — boot step 2), build tooling.

Depends on: S18 and S28. **Gated on U7.**

Acceptance:
- S19.1 The element type and build entry are fixed in `20-contract.md` before the package is
  published.
- S19.2 A derived image's build produces a bundle whose asset manifest hashes into a console
  fingerprint distinct from the contract fingerprint. Both are reported by the version endpoint.
- S19.3 A runtime-swapped bundle makes boot exit with `console-manifest-mismatch` — the same shape
  as a registry mismatch.
- S19.4 A registered view declares its capabilities and receives the selected declaration. It
  renders for a declaration whose grant contains them and is **absent** for one whose grant does
  not.
- S19.5 No registered view names a declaration it belongs to — asserted by the absence of any such
  field in `ConsoleViewRegistration`.

Out of scope: the blog consumer's own views (S20).

---

## S20 — `SubZeroDev.Blog` runs as a consumer, with parity measured

Delivers: definition-of-done items 3 and 17. The blog's sixteen authoring tools stay its own domain
code; the runtime, the contract and every repository-generic git operation come from here.

Touches: the derived image, the blog repository's own tools, parity fixtures.

Depends on: S19.

Acceptance:
- S20.1 The blog's authoring tools compile into the derived image's registry alongside the base's,
  under one fingerprint.
- S20.2 Tool metadata is compared against captured fixtures **per capability profile**, and the
  comparison reports zero differences. "No loss of capability" is measured, not asserted.
- S20.3 Every generic tool carries an operation-descriptive name and no `blog_` prefix, and the blog
  migrates to the new names in the same cutover — no aliases, no deprecation window.
- S20.4 The blog's content capabilities appear under the `content.*` prefix and are absent from
  every other declaration's grant.
- S20.5 The blog's authoring views render for the blog declaration and are absent for every other
  one.
- S20.6 The blog's file watcher names its own plan/apply authoring pair. The plan decides the
  repository path from the file's front matter, and the watcher chooses no path.

Out of scope: changing blog domain behaviour. This is a migration, and any behaviour change makes
the parity comparison meaningless.

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
