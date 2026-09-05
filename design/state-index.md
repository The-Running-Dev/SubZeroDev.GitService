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
| Question | Blocks |
|---|---|
| _(no question records yet)_ | |
<!-- question-affects:end -->

## Outstanding

<!-- outstanding:start -->
| Rank | Issue | Title | Criteria | Mirrored at |
|---|---|---|---|---|
| 24 | #38 | RepositoryConfig.baseBranch type drift between code and contract | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 25 | #41 | The kit lives at D:\Downloads\agent-kit, which is a staging path, not a home | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 26 | #42 | Journal's unsettled/allUnsettled/parked/findByScheduledJob return empty on a read failure, indistinguishable from nothing-found | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 27 | #54 | Naming — repository, image, MCP server and service names are unsettled | — | `c316c787456f6da803938f27de6341059aca1481` |
| 28 | #55 | S2's dual-lock-holder refusal has never been run against a real Docker bind mount | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 135 | #135 | Decide how the lease guard's blind spot on non-locking filesystems gets resolved | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 136 | #136 | Decide whether a stale MCP client tool catalogue needs a refresh mechanism | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 140 | #140 | Decide whether GrantView.liveSessions needs a real count or should be dropped | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 144 | #144 | eligibleViews filters on raw capabilityGrant, not the operator's effective grant | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 150 | #150 | Generate the registry entry tables in the contract instead of hand-maintaining them | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 180 | #180 | Update-WorkMirror.ps1 mangles em dashes into mojibake when it writes WorkRef titles | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| 190 | #190 | check-layer-direction.test.ts and watcher.test.ts fail on Windows — path-separator regex and symlink EPERM | — | `c316c787456f6da803938f27de6341059aca1481` |
| 208 | #208 | S27.1 dispatch-pipeline test intermittently exceeds its 1000ms wall-clock budget under load | — | `4d7d5f70bfa7ddb8bb58304736425b5389a05b46` |
| 216 | #216 | Decide whether DispatchPipelineDependencies.journal should be required | — | `4d7d5f70bfa7ddb8bb58304736425b5389a05b46` |
| 230 | #230 | Eviction interlock hardcodes 'main' as the base branch, so any other base branch reports corrupt-tree forever | — | `722176f96730fd93da7dbae2e43d33c5b42817a0` |
| 231 | #231 | 10-design.md's module table omits the credentials edge the clone store acquired in #223 | — | `722176f96730fd93da7dbae2e43d33c5b42817a0` |
| 232 | #232 | Boot never reports which journal entries it parked — revalidation's entries half is a hardcoded empty list | — | `722176f96730fd93da7dbae2e43d33c5b42817a0` |
| milestone/1 | #45 | Credential mount carries no username, so hosts that require a real one cannot authenticate | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #49 | Terminal-state detection never reaches the notifier on the ordinary dispatch or recovery paths | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/2 | #61 | syncBase inlines rev-parse/is-ancestor plumbing that composites.ts keeps as private helpers | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/2 | #65 | `sendJson`/`readJsonBody` are independently reimplemented in six surface files | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #66 | `Declarations.orphan` does not revoke grants, bump the epoch, or cancel held jobs | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #67 | The route-to-capability mapping for the HTTP bearer surface is half-built | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #73 | Implement the S17 generic content-drop watcher | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #74 | Implement S17 storage maintenance and safe eviction | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #76 | Content drops need a fixed two-phase target protocol | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #77 | Carry the watcher push SHA through auto-merge and reconciliation | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #78 | Require a live clean-tree check before watcher claims or reconciliation | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #79 | Drain an active watcher tick before releasing lifecycle ownership | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #80 | Retain terminal drops under unique original-name-preserving paths | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #81 | Audit and notify every content-drop watcher failure | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #82 | Finalize a merged watcher PR even when reconciliation fails | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #83 | Isolate untrusted drop files from protected watcher state | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #84 | Make declaration orphaning and removal aware of content-drop state | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #85 | Start the watcher healthy and idle when no declaration currently has content drops | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #86 | Wire and validate the configurable watcher polling interval | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #87 | Build an evidence-grade test harness for the content-drop watcher | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #88 | Enforce watcher contract types at every persistence and dispatch boundary | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #104 | A failed journal read at boot returns without closing the store or releasing the lease | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
| milestone/1 | #113 | Test-DesignDrift.ps1 accepts non-slice titles that merely begin with an S-number | — | `02ab6bc823cf0145a515fdda9f48a24161dcc432` |
<!-- outstanding:end -->
