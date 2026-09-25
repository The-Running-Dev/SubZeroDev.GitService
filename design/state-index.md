# State Index

## Units

<!-- units:start -->
| Id | Kind | Anchor |
|---|---|---|
| _(no active unit records yet)_ | | |
<!-- units:end -->

## Bound by

<!-- bound-by:start -->
| Invariant | Bound by |
|---|---|
| _(no invariant records yet)_ | |
<!-- bound-by:end -->

## Consumers

<!-- consumers:start -->
| Contract | Consumers |
|---|---|
| _(no contract records yet)_ | |
<!-- consumers:end -->

## Decision affects

<!-- decision-affects:start -->
| Decision | In force for |
|---|---|
| _(no decision records yet)_ | |
<!-- decision-affects:end -->

## Question affects

<!-- question-affects:start -->
| Question | Blocks | Answered |
|---|---|---|
| _(no question records yet)_ | | |
<!-- question-affects:end -->

## Outstanding

<!-- outstanding:start -->
| Rank | Issue | Title | Criteria | Mirrored at |
|---|---|---|---|---|
| 25 | #41 | The kit lives at D:\Downloads\agent-kit, which is a staging path, not a home | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 27 | #54 | Naming — repository, image, MCP server and service names are unsettled | — | `c316c787456f6da803938f27de6341059aca1481` |
| 28 | #55 | S2's dual-lock-holder refusal has never been run against a real Docker bind mount | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 265 | #265 | A clone can get stuck "needs attention" with nothing able to clear it | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 266 | #266 | Parking an operation never notifies anyone | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 267 | #267 | A resumed operation is marked done without re-checking its outcome | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 268 | #268 | A rejected host credential is never marked failing | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 269 | #269 | MCP tool calls report every failure as an error, even ones that shouldn't be | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 270 | #270 | The eviction safety check ignores whether other generations of a declaration still need the clone | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 271 | #271 | An unreadable repository configuration reports the wrong kind of failure | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 272 | #272 | A timed-out mutating call is parked without leaving an audit record | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 273 | #273 | A lease takeover can vanish from the record if the next boot fails early | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 274 | #274 | Two boot steps can race, leaving a job unrevalidated | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 275 | #275 | Anyone can register unlimited OAuth clients against this service | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 276 | #276 | Using a TOTP recovery code doesn't actually force re-enrolment | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 277 | #277 | The operator health view always shows zero volume usage | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 278 | #278 | Notifications stuck behind a missing delivery transport don't show up anywhere | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 279 | #279 | A module tool's declared timeout is never actually enforced | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 280 | #280 | The HTTP adapter's timeout doesn't cover reading the response body | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 281 | #281 | Database access has no retry or timeout when the database is busy | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 282 | #282 | A clone interrupted mid-copy can later be treated as complete | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 283 | #283 | A lock being busy is reported as a store failure instead of a conflict | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 284 | #284 | Several error results are labelled for conditions that don't match what actually happened | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 285 | #285 | Merging a pull request can force-delete a local branch that still holds unmerged commits | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 286 | #286 | A file-watcher declaration can sit stuck with a misleading status until something else creates its clone | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 287 | #287 | Overriding the safety check on a corrupted clone destroys it instead of setting it aside | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 288 | #288 | A declaration's generation number can be reused after the declaration is removed and redeclared | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 289 | #289 | An interrupted operation on an idle declaration can go unnoticed indefinitely | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 290 | #290 | A repository can silently clone without its credential when that credential fails to resolve | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 291 | #291 | Revoking an OAuth token can grow the audit trail without real authorization, and misattributes it | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 292 | #292 | There's no record of which operator approved a given MCP access grant | — | `618b0bed2296f4757d465b372b79920ef8d38764` |
| 301 | #301 | Add a doc-citation checker to CI | — | `082d1df8f15bae3125e78e06155fe1c59fe3cafc` |
| 308 | #308 | S40 — Only the operator's own console can clear what needs attention | S40.1, S40.2, S40.3, S40.4, S40.5, S40.6, S40.7 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 309 | #309 | S41 — Terminal outcomes and parked work reach the operator | S41.1, S41.2, S41.3, S41.4, S41.5, S41.6 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 310 | #310 | S42 — Recovery never strands a clone, and never waits for a caller | S42.1, S42.2, S42.3, S42.4, S42.5, S42.6, S42.7 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 311 | #311 | S43 — Boot keeps its evidence, and its steps in order | S43.1, S43.2, S43.3, S43.4 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 312 | #312 | S44 — A clone on disk is exactly what it claims to be | S44.1, S44.2, S44.3, S44.4, S44.5 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 313 | #313 | S45 — Composites keep what they did not merge | S45.1, S45.2, S45.3, S45.4, S45.5 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 314 | #314 | S46 — Every error names what actually happened | S46.1, S46.2, S46.3, S46.4, S46.5, S46.6, S46.7, S46.8, S46.9 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 315 | #315 | S47 — Nothing waits forever, and a busy store is retried | S47.1, S47.2, S47.3, S47.4 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 316 | #316 | S48 — The console and the health view show what is real | S48.1, S48.2, S48.3, S48.4, S48.5 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 317 | #317 | S49 — A watcher's auto-merge only merges the commit it pushed | S49.1, S49.2, S49.3, S49.4, S49.5, S49.6 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 318 | #318 | S50 — Every watcher outcome is audited, and every failure is told | S50.1, S50.2, S50.3, S50.4, S50.5, S50.6, S50.7 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 319 | #319 | S51 — A watched repository clones itself on first use | S51.1, S51.2, S51.3 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| 320 | #320 | S52 — The watcher is proven against a real repository | S52.1, S52.2, S52.3, S52.4, S52.5 | `9c4bb73b69a9fcdcb51211853bbceb10aa741266` |
| milestone/4 | #49 | Terminal-state detection never reaches the notifier on the ordinary dispatch or recovery paths | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/6 | #61 | syncBase inlines rev-parse/is-ancestor plumbing that composites.ts keeps as private helpers | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/6 | #65 | `sendJson`/`readJsonBody` are independently reimplemented in six surface files | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/4 | #67 | The route-to-capability mapping for the HTTP bearer surface is half-built | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/3 | #77 | Carry the watcher push SHA through auto-merge and reconciliation | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/3 | #81 | Audit and notify every content-drop watcher failure | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/3 | #82 | Finalize a merged watcher PR even when reconciliation fails | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/3 | #84 | Make declaration orphaning and removal aware of content-drop state | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/3 | #87 | Build an evidence-grade test harness for the content-drop watcher | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/3 | #88 | Enforce watcher contract types at every persistence and dispatch boundary | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/6 | #113 | Test-DesignDrift.ps1 accepts non-slice titles that merely begin with an S-number | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/5 | #135 | Decide how the lease guard's blind spot on non-locking filesystems gets resolved | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/5 | #136 | Decide whether a stale MCP client tool catalogue needs a refresh mechanism | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/5 | #140 | Decide whether GrantView.liveSessions needs a real count or should be dropped | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/4 | #144 | eligibleViews filters on raw capabilityGrant, not the operator's effective grant | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/6 | #150 | Generate the registry entry tables in the contract instead of hand-maintaining them | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/6 | #180 | Update-WorkMirror.ps1 mangles em dashes into mojibake when it writes WorkRef titles | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/5 | #216 | Decide whether DispatchPipelineDependencies.journal should be required | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/6 | #246 | Design-state tooling reads this repo's contract for sections it has never had, and fails rather than standing down | — | `ccee7fce3f7187ebbc76b5af73f2d489a5f0364a` |
| milestone/4 | #248 | Orphaning reports no retained journal entries: `OrphanReport.retainedJournalEntries` is always empty | — | `c2caeaf7f7a78b11d70d48f861158c422a5e94c5` |
<!-- outstanding:end -->
