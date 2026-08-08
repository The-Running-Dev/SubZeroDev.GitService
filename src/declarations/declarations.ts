import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import {
  cloneUrl as validateCloneUrl,
  generation as validateGeneration,
  grantEpoch as validateGrantEpoch,
  type CloneUrl,
  type CredentialRef,
  type DeclarationId,
  type Generation,
  type GrantEpoch,
  type IsoUtcTimestamp,
  type PathPrefix,
  type RegistryToolName,
  type RemoteHost,
} from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import {
  capabilityScopeOf,
  hostSupportedCapabilities,
  type CapabilityName,
  type ContractCapabilitySet,
  type DeclarationGrant,
  type DeploymentCeiling,
  type EffectiveGrant,
  type SessionGrant,
} from '../contract/capabilities.ts';
import { storeError, type StoreError } from '../store/errors.ts';
import type { StoreTransaction } from '../store/structured-store.ts';
import type { EvictionBlocker, SafeToEvictVerdict } from '../clone/types.ts';
import { declarationError, type DeclarationError } from './errors.ts';
import type { ActorProfile, AmendInput, Declaration, DeclareInput, DeclarationFilter, OrphanReport } from './types.ts';

export interface Declarations {
  get(id: DeclarationId): Promise<Declaration | null>;
  getGeneration(id: DeclarationId, generation: Generation): Promise<Declaration | null>;
  list(filter: DeclarationFilter): Promise<readonly Declaration[]>;

  declare(input: DeclareInput, actor: ActorRef): Promise<Outcome<Declaration, DeclarationError>>;
  amend(id: DeclarationId, patch: AmendInput, actor: ActorRef): Promise<Outcome<Declaration, DeclarationError>>;
  orphan(id: DeclarationId, actor: ActorRef): Promise<Outcome<OrphanReport, DeclarationError>>;
  remove(id: DeclarationId, actor: ActorRef): Promise<Outcome<void, DeclarationError>>;

  effectiveGrant(
    contract: ContractCapabilitySet,
    ceiling: DeploymentCeiling,
    declaration: Declaration | null,
    session: SessionGrant,
  ): EffectiveGrant;

  effectiveWritablePrefixes(declaration: Declaration, profile: ActorProfile): readonly PathPrefix[];

  bumpGrantEpoch(id: DeclarationId, tx: StoreTransaction): GrantEpoch;
  remoteHostAllowlist(): readonly RemoteHost[];
}

/**
 * `cloneExists: false` is the only reading of "no conflict" — a clone that
 * was never materialised has nothing to repoint. `cloneExists: true` with
 * `remote: null` means a directory is present but its origin could not be
 * verified (an unreadable tree, a missing/unreadable `origin` remote), which
 * must refuse adoption rather than pass as "nothing to compare against":
 * conflating "unknown" with "no conflict" is what let an unverifiable
 * directory be adopted silently (review finding #3).
 */
export type ObservedRemoteCheck = { readonly cloneExists: false } | { readonly cloneExists: true; readonly remote: CloneUrl | null };

/**
 * The one piece of clone-directory knowledge `declare()` needs (adoption
 * safety, remote cross-check) and cannot compute itself — that is entirely
 * `CloneStore`'s domain, which the design's own module table lists as
 * depending on Declarations for the reverse lookup (`10-design.md` § module
 * table: Clone store's collaborators include "declarations"). The two
 * modules are mutually dependent for different reasons, so the composition
 * root wires this in *after* constructing both — see `server.ts`. Narrower
 * than injecting the whole `CloneStore`, so this module's own dependency
 * surface stays legible.
 */
export interface CloneAdoptionCheck {
  observedRemote(declarationId: DeclarationId): Promise<ObservedRemoteCheck>;
  isSafeToAdopt(declarationId: DeclarationId): Promise<SafeToEvictVerdict>;
}

export interface DeclarationsDependencies {
  readonly volumeRoot: string;
  readonly clock: { now(): IsoUtcTimestamp };
  readonly remoteHostAllowlist: readonly RemoteHost[];
  readonly ceiling: DeploymentCeiling;
  /** Defaults to "nothing is a drop target" — honest until a tool registry exists (S6+) to ask. */
  readonly isDropTarget?: (tool: string) => boolean;
  /** Set once by the composition root after `CloneStore` exists; see `CloneAdoptionCheck` above. */
  readonly cloneAdoptionCheck: () => CloneAdoptionCheck;
}

interface DeclarationRow {
  readonly id: string;
  readonly generation: number;
  readonly clone_url: string;
  readonly host: string;
  readonly credential_ref: string;
  readonly capability_grant: string;
  readonly writable_path_prefixes: string;
  readonly pinned: number;
  readonly content_drop_tool: string | null;
  readonly content_drop_auto_merge: number | null;
  readonly git_user_name: string;
  readonly git_user_email: string;
  readonly state: string;
  readonly grant_epoch: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toDeclaration(row: DeclarationRow): Declaration {
  return {
    id: row.id as DeclarationId,
    generation: row.generation as Generation,
    cloneUrl: row.clone_url as CloneUrl,
    host: row.host as Declaration['host'],
    credentialRef: row.credential_ref as CredentialRef,
    capabilityGrant: new Set(JSON.parse(row.capability_grant) as CapabilityName[]) as unknown as DeclarationGrant,
    writablePathPrefixes: JSON.parse(row.writable_path_prefixes) as PathPrefix[],
    pinned: row.pinned === 1,
    contentDrop:
      row.content_drop_tool === null ? null : { tool: row.content_drop_tool as RegistryToolName, autoMerge: row.content_drop_auto_merge === 1 },
    identity: { gitUserName: row.git_user_name, gitUserEmail: row.git_user_email },
    state: row.state as Declaration['state'],
    grantEpoch: row.grant_epoch as GrantEpoch,
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  };
}

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): Outcome<T, StoreError> {
  mkdirSync(volumeRoot, { recursive: true });
  const dbPath = path.join(volumeRoot, 'store.sqlite');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    return err(storeError({ code: 'io-failed' }, 'could not open the structured store'));
  }
  try {
    return ok(fn(db));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const isConstraint = /CHECK constraint|UNIQUE constraint|FOREIGN KEY|NOT NULL constraint/i.test(message);
    return err(isConstraint ? storeError({ code: 'constraint-violated', constraint: message }, message) : storeError({ code: 'io-failed' }, message));
  } finally {
    db.close();
  }
}

/**
 * The row for `id` that "currently" refers to it. Adoption only ever bumps
 * `generation` upward and immediately marks the new row `active`
 * (`declare()` below), so the active row — when one exists — is always the
 * highest generation on file; when none is active, the highest-generation
 * orphaned row is the most recent era awaiting `declaration.remove`. Either
 * way, `ORDER BY generation DESC LIMIT 1` picks the right one without having
 * to special-case state.
 */
function latestRowFor(db: DatabaseSync, id: string): DeclarationRow | null {
  const rows = db.prepare('SELECT * FROM declaration WHERE id = ? ORDER BY generation DESC LIMIT 1').all(id) as unknown as DeclarationRow[];
  return rows[0] ?? null;
}

export function createDeclarations(deps: DeclarationsDependencies): Declarations {
  const { volumeRoot, clock } = deps;
  const isDropTarget = deps.isDropTarget ?? (() => false);

  function capabilitiesOutsideCeiling(grant: readonly CapabilityName[]): CapabilityName[] {
    return grant.filter((c) => !deps.ceiling.has(c));
  }

  function capabilitiesUnsupportedByHost(grant: readonly CapabilityName[], host: Declaration['host']): CapabilityName[] {
    const supported = hostSupportedCapabilities(host);
    return grant.filter((c) => !c.startsWith('content.') && !supported.has(c));
  }

  function hostAllowedFor(url: CloneUrl): Outcome<true, RemoteHost> {
    const validated = validateCloneUrl(url as unknown as string, deps.remoteHostAllowlist);
    if (validated.ok) return ok(true);
    // Re-derive the offending host for the error, since the validator only
    // reports pass/fail — the same parse the validator itself performs.
    const httpsMatch = /^https:\/\/([^/@\s]+)\//.exec(url as unknown as string);
    const scpMatch = /^[\w.-]+@([a-zA-Z0-9.-]+):/.exec(url as unknown as string);
    const host = (httpsMatch?.[1] ?? scpMatch?.[1] ?? 'unknown') as RemoteHost;
    return err(host);
  }

  async function get(id: DeclarationId): Promise<Declaration | null> {
    const result = withDb(volumeRoot, (db) => latestRowFor(db, id));
    return result.ok && result.value ? toDeclaration(result.value) : null;
  }

  async function getGeneration(id: DeclarationId, generationValue: Generation): Promise<Declaration | null> {
    const result = withDb(volumeRoot, (db) => {
      const rows = db.prepare('SELECT * FROM declaration WHERE id = ? AND generation = ?').all(id, generationValue) as unknown as DeclarationRow[];
      return rows[0] ?? null;
    });
    return result.ok && result.value ? toDeclaration(result.value) : null;
  }

  return {
    get,
    getGeneration,

    async list(filter: DeclarationFilter): Promise<readonly Declaration[]> {
      const result = withDb(volumeRoot, (db) => db.prepare('SELECT * FROM declaration ORDER BY id, generation DESC').all() as unknown as DeclarationRow[]);
      if (!result.ok) return [];
      // Highest generation per id wins — see `latestRowFor`'s comment for why
      // that is always the current era, active or orphaned.
      const latestPerId = new Map<string, DeclarationRow>();
      for (const row of result.value) {
        const existing = latestPerId.get(row.id);
        if (!existing || row.generation > existing.generation) latestPerId.set(row.id, row);
      }
      let declarations = [...latestPerId.values()].map(toDeclaration);
      if (filter.state !== null) declarations = declarations.filter((d) => d.state === filter.state);
      if (filter.hasContentDrop !== null) declarations = declarations.filter((d) => (d.contentDrop !== null) === filter.hasContentDrop);
      return declarations;
    },

    async declare(input: DeclareInput, _actor: ActorRef): Promise<Outcome<Declaration, DeclarationError>> {
      const outsideCeiling = capabilitiesOutsideCeiling(input.capabilityGrant);
      if (outsideCeiling.length > 0) {
        return err(declarationError({ code: 'capability-outside-ceiling', capabilities: outsideCeiling }, `${outsideCeiling.length} capabilit(y/ies) outside the deployment ceiling`));
      }
      const unsupported = capabilitiesUnsupportedByHost(input.capabilityGrant, input.host);
      if (unsupported.length > 0) {
        return err(declarationError({ code: 'capability-unsupported-by-host', capabilities: unsupported }, `${unsupported.length} capabilit(y/ies) unsupported by host '${input.host}'`));
      }
      const hostCheck = hostAllowedFor(input.cloneUrl);
      if (!hostCheck.ok) {
        return err(declarationError({ code: 'remote-host-not-allowed', host: hostCheck.error }, `host '${hostCheck.error}' is off the deployment remote-host allowlist`));
      }
      if (input.contentDrop !== null && !isDropTarget(input.contentDrop.tool)) {
        return err(declarationError({ code: 'drop-tool-not-annotated', tool: input.contentDrop.tool }, `tool '${input.contentDrop.tool}' is not annotated a drop target`));
      }

      const existing = await get(input.id);
      let nextGeneration: Generation;

      if (existing && existing.state === 'active') {
        return err(declarationError({ code: 'already-exists' }, `declaration '${input.id}' is already active`));
      }

      if (existing && existing.state === 'orphaned') {
        const check = deps.cloneAdoptionCheck();
        const remoteCheck = await check.observedRemote(input.id);
        if (remoteCheck.cloneExists) {
          if (remoteCheck.remote === null) {
            // A directory exists but its remote could not be verified — fail
            // closed rather than treat "unknown" as "no conflict" (review
            // finding #3). Not `remote-mismatch`: there is no second remote
            // value to report, only an inability to confirm the one on disk.
            return err(
              declarationError(
                { code: 'adoption-refused', blockers: [{ kind: 'corrupt-tree' }] },
                `the orphaned clone for '${input.id}' exists but its remote could not be verified`,
              ),
            );
          }
          if (remoteCheck.remote !== input.cloneUrl) {
            return err(
              declarationError(
                { code: 'remote-mismatch', declared: input.cloneUrl, observed: remoteCheck.remote },
                `orphaned clone remote '${remoteCheck.remote}' does not match declared '${input.cloneUrl}'`,
              ),
            );
          }
        }
        const verdict = await check.isSafeToAdopt(input.id);
        if (!verdict.safe) {
          return err(declarationError({ code: 'adoption-refused', blockers: verdict.blockers }, `the orphaned clone is not clean: ${verdict.blockers.map((b) => b.kind).join(', ')}`));
        }
        const bumped = validateGeneration(existing.generation + 1);
        if (!bumped.ok) throw new Error('unreachable: generation + 1 is always a valid Generation');
        nextGeneration = bumped.value;
      } else {
        const first = validateGeneration(1);
        if (!first.ok) throw new Error('unreachable: 1 is always a valid Generation');
        nextGeneration = first.value;
      }

      const now = clock.now();
      const epoch = validateGrantEpoch(0);
      if (!epoch.ok) throw new Error('unreachable: 0 is always a valid GrantEpoch');

      const written = withDb(volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO declaration
             (id, generation, clone_url, host, credential_ref, capability_grant, writable_path_prefixes,
              pinned, content_drop_tool, content_drop_auto_merge, git_user_name, git_user_email,
              state, grant_epoch, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(
          input.id,
          nextGeneration,
          input.cloneUrl,
          input.host,
          input.credentialRef,
          JSON.stringify(input.capabilityGrant),
          JSON.stringify(input.writablePathPrefixes),
          input.pinned ? 1 : 0,
          input.contentDrop?.tool ?? null,
          input.contentDrop ? (input.contentDrop.autoMerge ? 1 : 0) : null,
          input.identity.gitUserName,
          input.identity.gitUserEmail,
          epoch.value,
          now,
          now,
        );
        const row = latestRowFor(db, input.id);
        if (!row) throw new Error('unreachable: just inserted');
        return row;
      });
      if (!written.ok) {
        if (written.error.code === 'constraint-violated') {
          return err(declarationError({ code: 'already-exists' }, `declaration '${input.id}' is already active`));
        }
        return err(declarationError({ code: 'store-failed', cause: written.error }, written.error.summary));
      }

      return ok(toDeclaration(written.value));
    },

    async amend(id: DeclarationId, patch: AmendInput, _actor: ActorRef): Promise<Outcome<Declaration, DeclarationError>> {
      const existing = await get(id);
      if (!existing || existing.state !== 'active') {
        return err(declarationError({ code: 'not-found' }, `no active declaration '${id}'`));
      }

      const nextHost = existing.host; // host is immutable — AmendInput carries no field for it
      const nextCapabilityGrant = patch.capabilityGrant ?? [...existing.capabilityGrant];
      if (patch.capabilityGrant !== null) {
        const outsideCeiling = capabilitiesOutsideCeiling(nextCapabilityGrant);
        if (outsideCeiling.length > 0) {
          return err(declarationError({ code: 'capability-outside-ceiling', capabilities: outsideCeiling }, `${outsideCeiling.length} capabilit(y/ies) outside the deployment ceiling`));
        }
        const unsupported = capabilitiesUnsupportedByHost(nextCapabilityGrant, nextHost);
        if (unsupported.length > 0) {
          return err(declarationError({ code: 'capability-unsupported-by-host', capabilities: unsupported }, `${unsupported.length} capabilit(y/ies) unsupported by host '${nextHost}'`));
        }
      }

      const nextCloneUrl = patch.cloneUrl ?? existing.cloneUrl;
      if (patch.cloneUrl !== null) {
        const hostCheck = hostAllowedFor(nextCloneUrl);
        if (!hostCheck.ok) {
          return err(declarationError({ code: 'remote-host-not-allowed', host: hostCheck.error }, `host '${hostCheck.error}' is off the deployment remote-host allowlist`));
        }
      }

      const nextContentDrop = patch.contentDrop === undefined ? existing.contentDrop : patch.contentDrop;
      if (nextContentDrop !== null && patch.contentDrop !== undefined && !isDropTarget(nextContentDrop.tool)) {
        return err(declarationError({ code: 'drop-tool-not-annotated', tool: nextContentDrop.tool }, `tool '${nextContentDrop.tool}' is not annotated a drop target`));
      }

      const now = clock.now();
      const written = withDb(volumeRoot, (db) => {
        db.prepare(
          `UPDATE declaration SET
             clone_url = ?, credential_ref = ?, capability_grant = ?, writable_path_prefixes = ?,
             pinned = ?, content_drop_tool = ?, content_drop_auto_merge = ?,
             git_user_name = ?, git_user_email = ?, updated_at = ?
           WHERE id = ? AND generation = ?`,
        ).run(
          nextCloneUrl,
          patch.credentialRef ?? existing.credentialRef,
          JSON.stringify(nextCapabilityGrant),
          JSON.stringify(patch.writablePathPrefixes ?? existing.writablePathPrefixes),
          (patch.pinned ?? existing.pinned) ? 1 : 0,
          nextContentDrop?.tool ?? null,
          nextContentDrop ? (nextContentDrop.autoMerge ? 1 : 0) : null,
          patch.identity?.gitUserName ?? existing.identity.gitUserName,
          patch.identity?.gitUserEmail ?? existing.identity.gitUserEmail,
          now,
          id,
          existing.generation,
        );
        const row = latestRowFor(db, id);
        if (!row) throw new Error('unreachable: row existed a moment ago');
        return row;
      });
      if (!written.ok) return err(declarationError({ code: 'store-failed', cause: written.error }, written.error.summary));

      return ok(toDeclaration(written.value));
    },

    async orphan(id: DeclarationId, _actor: ActorRef): Promise<Outcome<OrphanReport, DeclarationError>> {
      const existing = await get(id);
      if (!existing || existing.state !== 'active') {
        return err(declarationError({ code: 'not-found' }, `no active declaration '${id}'`));
      }

      const now = clock.now();
      const written = withDb(volumeRoot, (db) => {
        db.prepare("UPDATE declaration SET state = 'orphaned', updated_at = ? WHERE id = ? AND generation = ?").run(now, id, existing.generation);
      });
      if (!written.ok) return err(declarationError({ code: 'store-failed', cause: written.error }, written.error.summary));

      // Grants, scheduled jobs and the content-drop watch are owned by
      // modules that do not exist yet (Authorization/S13, Scheduler/S16,
      // Watcher/S17) — `30-slices.md` § S5 "Out of scope": "the rest of the
      // orphaning cascade... each is added by the slice that creates them."
      // Empty here is the honest current answer, not a stub standing in for
      // one: nothing has been cancelled or revoked because nothing existed to.
      return ok({
        declarationId: id,
        generation: existing.generation,
        cancelledJobs: [],
        revokedGrants: [],
        retainedJournalEntries: [],
        cloneLeftOnDisk: true,
        dropWatchStopped: false,
      });
    },

    async remove(id: DeclarationId, _actor: ActorRef): Promise<Outcome<void, DeclarationError>> {
      const existing = await get(id);
      if (!existing) return err(declarationError({ code: 'not-found' }, `no declaration '${id}'`));
      if (existing.state !== 'orphaned') {
        return err(declarationError({ code: 'not-orphaned' }, `declaration '${id}' is still active`));
      }

      const cloneCheck = withDb(volumeRoot, (db) => {
        const rows = db.prepare('SELECT state FROM clone WHERE declaration_id = ?').all(id) as unknown as { state: string }[];
        return rows[0] ?? null;
      });
      if (!cloneCheck.ok) return err(declarationError({ code: 'store-failed', cause: cloneCheck.error }, cloneCheck.error.summary));
      const rowSaysPresent = cloneCheck.value !== null && cloneCheck.value.state !== 'absent' && cloneCheck.value.state !== 'evicted';
      // The row is a report, not a source of truth (the same rule
      // `CloneStore` itself follows): a clone directory can exist with no
      // row at all — `ensure()` died before its first write, or the row was
      // otherwise lost — and a DB-only check would let `declaration.remove`
      // through while an untracked clone is left on disk (review finding #4).
      const directoryPresent = existsSync(path.join(volumeRoot, 'clones', id));
      if (rowSaysPresent || directoryPresent) {
        return err(declarationError({ code: 'clone-still-present' }, `a clone for '${id}' still exists — run clone.remove first`));
      }

      const deleted = withDb(volumeRoot, (db) => {
        db.prepare('DELETE FROM declaration WHERE id = ? AND generation = ?').run(id, existing.generation);
      });
      if (!deleted.ok) return err(declarationError({ code: 'store-failed', cause: deleted.error }, deleted.error.summary));

      return ok(undefined);
    },

    effectiveGrant(
      contract: ContractCapabilitySet,
      ceiling: DeploymentCeiling,
      declaration: Declaration | null,
      session: SessionGrant,
    ): EffectiveGrant {
      const result = new Set<CapabilityName>();
      for (const capability of session as unknown as ReadonlySet<CapabilityName>) {
        if (!contract.has(capability)) continue;
        if (!ceiling.has(capability)) continue;
        if (capabilityScopeOf(capability) === 'declaration') {
          if (declaration === null) continue;
          if (!declaration.capabilityGrant.has(capability)) continue;
        }
        result.add(capability);
      }
      return result as unknown as EffectiveGrant;
    },

    /**
     * Excludes a declared prefix on *either* direction of overlap with a
     * stripped one — not just "declared starts with stripped" (a declared
     * `.github/workflows/release.yml` under stripped `.github/workflows/`),
     * but also "stripped starts with declared" (a declared `.github/`
     * reaching over stripped `.github/workflows/`). The latter previously
     * survived unfiltered: `.github/`.startsWith('.github/workflows/')` is
     * false, so it passed through and authorized exactly the unattended
     * write invariant A4 exists to stop. `PathPrefix` has no "prefix minus
     * an excluded sub-path" shape, so a broader declared prefix that
     * reaches into stripped territory is dropped whole (fail closed) rather
     * than partially carved — the same trade the design already makes by
     * stripping whole prefixes rather than narrowing them.
     */
    effectiveWritablePrefixes(declaration: Declaration, profile: ActorProfile): readonly PathPrefix[] {
      if (profile.strippedPathPrefixes.length === 0) return declaration.writablePathPrefixes;
      return declaration.writablePathPrefixes.filter(
        (prefix) =>
          !profile.strippedPathPrefixes.some(
            (stripped) => (prefix as unknown as string).startsWith(stripped as unknown as string) || (stripped as unknown as string).startsWith(prefix as unknown as string),
          ),
      );
    },

    /**
     * Cannot honour `tx`'s transactional participation: `StoreTransaction`
     * (`store/structured-store.ts`) is an opaque `{ id: string }` token, and
     * `StructuredStore.transaction`'s own callback never receives the real
     * `DatabaseSync` handle either — there is no seam through which this
     * synchronous call could join an externally-held transaction. Runs its
     * own short-lived write instead. Not exercised by this slice (S14 is
     * where the grant epoch reaches a live session); flagged for whoever
     * builds S14, not fixed here since `StructuredStore` is outside S5's
     * `Touches`.
     */
    bumpGrantEpoch(id: DeclarationId, _tx: StoreTransaction): GrantEpoch {
      let result: GrantEpoch = 0 as GrantEpoch;
      withDb(volumeRoot, (db) => {
        db.prepare("UPDATE declaration SET grant_epoch = grant_epoch + 1, updated_at = ? WHERE id = ? AND state = 'active'").run(clock.now(), id);
        const rows = db.prepare("SELECT grant_epoch FROM declaration WHERE id = ? AND state = 'active'").all(id) as unknown as { grant_epoch: number }[];
        const epoch = validateGrantEpoch(rows[0]?.grant_epoch ?? 0);
        result = epoch.ok ? epoch.value : (0 as GrantEpoch);
      });
      return result;
    },

    remoteHostAllowlist(): readonly RemoteHost[] {
      return deps.remoteHostAllowlist;
    },
  };
}

export type { EvictionBlocker };
