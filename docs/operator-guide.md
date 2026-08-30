# Operator guide

Definition-of-done item 20. This is the reference an operator runs the service against: how to
configure a deployment, onboard a repository, provision the first operator, recover from a bad
store or a bad image, revoke access, and what happens if the volume is lost.

## Configuration

Every value below is an environment variable read once at boot (`src/composition-root/compose.ts`).
An unset variable takes its documented default; a malformed one is fatal at boot with a message
naming which variable and why — a deployment never runs on a silently-invented value.

| Variable | Default | What it controls |
|---|---|---|
| `PORT` | `8080` | The HTTP listener port. |
| `PUBLIC_ORIGIN` | `http://localhost:<PORT>` | The origin MCP clients and the operator console see — used in OAuth metadata URLs and the `resource_metadata` challenge. Set this to the real external origin in any deployment behind a reverse proxy. |
| `VOLUME_ROOT` | `<repo>/volume` | Where the structured store, audit log, backups, clones and the file-watcher inboxes live. Point this at the container-managed named volume (`docker-compose.yml`) in any real deployment. |
| `CREDENTIAL_MOUNT_ROOT` | `<repo>/credentials` | A **read-only** mount whose file names are credential reference names (`^[a-z0-9][a-z0-9._-]{0,63}$`), read at point of use. Also where the TOTP sealing key (`_totp-sealing-key`) lives. Rotation is a file write the next operation observes — no restart needed. |
| `GIT_COMMIT_SHA` | build-time `--build-arg` | The commit the image was built from. Reported on `/healthz` and `/version`; boot refuses to start if this cannot be resolved from either the build arg or `git rev-parse HEAD`, because an unlabelled runtime can never be verified (S22.1's own companion check depends on this). |
| `REMOTE_HOST_ALLOWLIST` | empty (nothing may be declared) | Comma-separated remote git hosts a declaration's `cloneUrl` may name (e.g. `github.com`). |
| `DEPLOYMENT_CEILING` | empty (no capability granted to anything) | Comma-separated capability names this deployment will ever grant, regardless of what a declaration or a grant asks for. The hard ceiling over every session. |
| `REMOTE_OPERATIONS_PERMITTED` | `false` | Whether push, PR and other remote-mutating operations run at all. Off by default; a deployment that only wants local git and the console explicitly opts in. |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SUBJECT_ALLOWLIST` | unset (federated login disabled) | Federated console login (S31). `OIDC_ISSUER_URL` must be `https://` except against a loopback host. Local password + TOTP always works regardless of these — federated login is additive, never the only path in. |
| `NOTIFIER_WEBHOOK_URL` | unset (no transport; outbox rows accumulate `pending`) | Where terminal-state and attention notifications are POSTed. Must be `https://`. |
| `NOTIFIER_INTERVAL_SECONDS` | `30` | How often the outbox is drained. |
| `SCHEDULER_TICK_INTERVAL_SECONDS` | `15` | How often scheduled jobs are checked. |
| `MAINTENANCE_INTERVAL_SECONDS` | `86400` (24h) | How often the retention/eviction maintenance pass runs. |
| `WATCHER_ENABLED` | `false` | Whether the file-watcher subsystem starts at all. |
| `WATCHER_POLL_INTERVAL_SECONDS` | `15` | How often each watched inbox is polled, when enabled. |
| `ADMISSION_MUTATION_QUEUE_DEPTH` | `32` | Depth of the global mutation-lock queue before a caller is refused `conflict` outright. |
| `ADMISSION_CONCURRENT_WAITS_PER_SESSION` | `4` | How many `wait_*` calls one session may have outstanding at once. |
| `ADMISSION_CONCURRENT_LOCK_FREE_OPERATIONS` | `16` | Concurrency ceiling for operations that need no mutation lock. |
| `DISK_WATERMARK_MAINTENANCE_PERCENT` / `DISK_WATERMARK_REFUSE_PERCENT` | `85` / `95` | Volume-usage thresholds: cross the first and a maintenance pass is requested; cross the second and operations needing space are refused outright. |
| `MCP_ACCESS_TOKEN_TTL_SECONDS`, `MCP_REFRESH_TOKEN_TTL_SECONDS`, `OPERATOR_API_TOKEN_TTL_SECONDS` | contract defaults | Token lifetimes. Each is bounded above by ~100 years — the point past which the expiry timestamp itself stops being representable — not a policy recommendation. |

The console session's own idle timeout and absolute lifetime are not environment-configurable
today; they are fixed defaults (`SESSION_ABSOLUTE_SECONDS_DEFAULT`,
`src/operator-identity/operator-identity.ts`).

## First provisioning

Nothing creates the first operator automatically. Before enrolment:

1. Write a secret string to `<VOLUME_ROOT>/provisioning.secret` from a process with host/volume
   access — this is the same trust root as break-glass recovery below, deliberately: volume access
   is already the ultimate authority in this design.
2. `POST /auth/enrol` with that secret, a subject and a password. The response carries the TOTP
   secret and ten recovery codes **exactly once** — record them now, they are never shown again.
   The provisioning file is burned (deleted) on a successful enrolment, closing the window.
3. Readiness (`/healthz`) reports `ready: true` even while provisioning is pending — a failed
   readiness would withhold traffic from the one route (enrolment) that resolves the condition.
   Every other console route answers `401` until an operator exists.

## Onboarding a repository

Declaring a repository is console-only (or the equivalent authenticated API call), deliberately —
this is not a GitOps-watched-directory feature. No restart, no rebuild:

1. Authenticate as an operator (console session, or an operator API token with `declaration.manage`).
2. `POST /declarations` (or the console's "declare a repository" form) with the clone URL, the
   remote host (must be on `REMOTE_HOST_ALLOWLIST`), the credential reference to resolve from
   `CREDENTIAL_MOUNT_ROOT`, the capability grant (bounded above by `DEPLOYMENT_CEILING`), and any
   writable path prefixes.
3. The clone happens on first use, not at declare time — the declaration exists and appears in
   `tools/list` for any session whose grant intersects its capabilities immediately, while the
   instance keeps serving every other repository unaffected.
4. **File-watcher declarations only:** add a bind mount at
   `<data volume>/watcher-inboxes/<declarationId>` in the deployment's compose file (one per
   watched declaration) before or after declaring it — `docker-compose.yml` in the repository root
   has a commented template line for this.
5. A `generic`-host declaration performs local git and push only; its `host.*` tools (PR, checks,
   auto-merge) are absent from that declaration's `tools/list` rather than present-but-failing —
   there is no GitHub-specific step needed to onboard a repository outside GitHub.

## Backup and recovery

Two store copies exist, for two different failures, both **on the same volume**:

- **Pre-migration copy.** Taken automatically before every boot's `migrate()` call — not only the
  first time a schema changes, but on every boot, so it always represents "the store as it stood
  immediately before this running instance took over." Three retained by default
  (`preMigrationBackupsRetained`). This is the rollback target for a bad image — see *Rollback*,
  below.
- **Daily snapshot.** A separate maintenance-pass backup, seven retained by default, distinct from
  the pre-migration copy because it answers a different failure: recovering from a *corrupt* store
  without reverting every declaration, grant, token and journal entry written since the last image
  upgrade. Boot refuses to start on a corrupt store, naming the newest daily snapshot **and its
  age**, alongside the pre-migration copy.

Both copies live under `<VOLUME_ROOT>/backups/`, named `pre-migration-<timestamp>.sqlite` and
`snapshot-<timestamp>.sqlite` respectively.

## Rollback

Item 18 in the definition of done: rollback is tested, not assumed. The rollback target is the
**pre-migration store copy**, not a return to any prior standalone deployment — this service's own
structured store carries everything (declarations, grants, tokens, the notifier outbox) that a
prior deployment did not need to.

**Procedure**, for a deploy discovered to be bad after it has already migrated the store:

1. Stop the bad container. The volume (named, container-managed — never a bind mount) is untouched.
2. Identify the pre-migration copy taken immediately before the bad deploy's boot —
   `<VOLUME_ROOT>/backups/pre-migration-<timestamp>.sqlite`, the newest one older than the bad
   deploy's own start time.
3. Copy that file over `<VOLUME_ROOT>/store.sqlite`.
4. Start the previous (known-good) image against the same volume. It boots against the restored
   store, re-applies any migrations that copy predates, and reports readiness.

**Demonstrated for real, once**, 2026-08-30, against `subzerodev-git:latest` built from commit
`319076f` (`docker build --build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD) ...`), a real named Docker
volume, and a real bind-mounted credential directory carrying a TOTP sealing key:

1. Booted the image against a fresh volume. A `pre-migration-*.sqlite` backup was written
   automatically (0 bytes — a genuinely empty pre-schema store, since this was the volume's first
   boot).
2. Enrolled a real operator through `/auth/enrol` → `/auth/login` (real TOTP code, computed from
   the returned secret) — real state written to `store.sqlite` (grew to 212,992 bytes).
3. Recreated the container against the same volume. A **second** pre-migration backup appeared,
   confirming the copy is taken on every boot, not only the first — each one representing the store
   immediately before that boot's own migration step.
4. Stopped the container, copied the **first** (empty) pre-migration backup over `store.sqlite` —
   simulating a rollback all the way past the enrolment.
5. Started the same image again. It booted clean (`migrations applied 2`, re-applying migration
   0001 against the now-empty file) and `/healthz` reported `{"ready":true,...}`.
6. Confirmed the rollback was genuine, not cosmetic: the previously-enrolled operator's credentials
   were rejected with `not-provisioned`, exactly as a truly pre-enrolment store would answer.

This proves the pre-migration copy is a real, restorable rollback target end to end — a running
container backed by a real Docker volume genuinely reverts to it and continues serving.

## Revocation

"Revoke everything and re-authenticate" is one screen during an incident (the console's grants
view), backed by four authenticated routes:

| Route | Revokes |
|---|---|
| `POST /grants/:id/revoke` | One MCP grant. |
| `POST /tokens/:id/revoke` | One issued token (access or refresh). |
| `POST /clients/:id/revoke` | An OAuth client and every grant/token issued to it. |
| `POST /operator-sessions/:ref/revoke` | One console session, invalidated server-side rather than only clearing the cookie. |

`GET /grants` lists every MCP grant, operator API token and operator session, which is what makes
"revoke everything" a single screen rather than a hunt across several views.

**Recovery from lockout** has two independent paths, deliberately not depending on each other or on
the identity provider:

- **Recovery codes** — the ten single-use codes shown once at enrolment. Work while the identity
  provider is down; using one forces TOTP re-enrolment.
- **Break-glass** — a short-lived single-use token an operator with host access writes into the
  volume, consumed at next login and audited. The path for a lost TOTP device *and* lost recovery
  codes.

## Deployment verification

`scripts/verify-deployment.ts` is the definition-of-done item 15 companion check — an executable
script shipped alongside the service, never a registry tool. Run it after any deploy:

```
node scripts/verify-deployment.ts --base-url https://git.example.com --declaration <id> \
  --expected-commit <sha> --token <bearer>
```

It polls `/healthz` until the commit SHA stabilises, then runs a real
`initialize → tools/list → tools/call` MCP session, classifying the outcome as one of
`verified`, `stale-runtime` (the fleet is consistently serving an old commit),
`mixed-runtime` (successive polls disagree — a rolling deploy that has not converged),
`verification-credential` (the check's own bearer token was rejected), or
`unexpected-profile-or-catalog` (the expected tool is missing from the catalogue, or fails when
called — the deployed profile does not match what was expected).

## Volume loss — an accepted risk

No off-volume backup ships. Both store copies above live on the same volume as everything else, so
neither protects against losing the volume itself. This was a deliberate decision
(`design/90-decisions.md`, 2026-08-03), not an oversight — an online-backup operation would make the
service responsible for its own durability, which is scope neither the brief nor the design
allocated. What losing the volume costs:

| Lost | Recovery |
|---|---|
| Working clones | Re-cloned from their remotes. Unpushed work in a clone is gone — the one genuinely unrecoverable case. |
| Declarations | Re-declared by hand. They are small and operator-authored, but there is no export today. |
| OAuth clients, grants, tokens | Gone. Every MCP client re-authorises, which is a visible outage for unattended agents rather than a silent one. |
| Audit log | Gone, and the hash chain cannot help — a chain proves a surviving trail was not edited, not that a destroyed one existed. |
| Journal | Gone. Any operation in flight at the moment of loss is unclassifiable. |

The mitigations that are actually load-bearing here are external to this service: whatever the host
does with the volume (snapshotting it is the recommended option, and is **not** taken by this
design — nothing here may assume it happened), and the fact that clones are replicas of remotes
rather than originals. If the audit trail ever needs to survive the instance, that is the same
requirement a deferred external audit sink would satisfy — see `design/30-slices.md` § S22
*Out of scope*.
