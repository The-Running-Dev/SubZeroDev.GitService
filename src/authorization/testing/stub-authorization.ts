import { randomUUID } from 'node:crypto';
import { ok, err } from '../../shared/outcome.ts';
import type { SessionId, Subject } from '../../shared/brands.ts';
import type { Session } from '../../shared/session.ts';
import type { CapabilityName } from '../../contract/capabilities.ts';
import { storeError } from '../../store/errors.ts';
import { authorizationError } from '../errors.ts';
import type { Authorization } from '../authorization.ts';

/**
 * What a real token issued with all four operator scopes would carry, so a
 * surface test exercising a route's capability gate is not silently testing
 * an empty grant. Declaration-scoped only — the four instance-level
 * capabilities are console-only and no operator-api token has them.
 */
const ALL_OPERATOR_CAPABILITIES: readonly CapabilityName[] = [
  'repo.read',
  'host.pr.read',
  'host.checks.read',
  'git.local.write',
  'git.remote.write',
  'host.pr.write',
  'git.raw',
  'scheduler.manage',
];

/**
 * A stub for tests that exercise a surface *around* bearer authentication —
 * the health/version/parked-operations routes — without exercising the real
 * `Authorization` module's store-backed verification. Mirrors
 * `createStubDispatchPipeline` and `createStubDeclarations`'s reasoning: a
 * fixed, in-memory set of valid bearer values stands in for a real token
 * store, honest about being a stand-in rather than pretending to persist
 * anything.
 */
export function createStubAuthorization(
  validTokens: ReadonlyMap<string, Subject> = new Map(),
  grant: readonly CapabilityName[] = ALL_OPERATOR_CAPABILITIES,
): Authorization {
  const stub: Authorization = {
    async registerClient() {
      return err(authorizationError({ code: 'registration-invalid', findings: [] }, 'stub: registerClient not exercised'));
    },
    async issueMcpGrant() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: issueMcpGrant not exercised'));
    },
    async establishMcpSession() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: establishMcpSession not exercised'));
    },
    async verifyOperatorApiToken(bearer) {
      const subject = validTokens.get(bearer as unknown as string);
      if (subject === undefined) return err(authorizationError({ code: 'token-unknown' }, 'stub: no such token'));
      const session: Session = {
        id: randomUUID() as SessionId,
        kind: 'operator',
        actorRef: { kind: 'operator', subject, clientId: null, grantId: null },
        repositoryBinding: null,
        grant: new Set(grant) as unknown as Session['grant'],
        writablePathPrefixes: [],
        frozenAtEpoch: 0 as unknown as Session['frozenAtEpoch'],
      };
      return ok(session);
    },
    async issueOperatorApiToken() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: issueOperatorApiToken not exercised'));
    },
    async refresh() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: refresh not exercised'));
    },
    recomputeSessionGrant(session) {
      return ok(session);
    },
    async grantIsLive() {
      return false;
    },
    async listGrants() {
      return [];
    },
    async revokeClient() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: revokeClient not exercised'));
    },
    async revokeGrant() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: revokeGrant not exercised'));
    },
    async revokeToken() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: revokeToken not exercised'));
    },
    revokeGrantsForResource() {
      return [];
    },
    async revokeBearerToken() {
      return err(authorizationError({ code: 'token-unknown' }, 'stub: revokeBearerToken not exercised'));
    },
    async runRetention() {
      return { module: 'authorization', deletedRows: 0, freedBytes: 0, skipped: ['stub'] };
    },
  };
  return stub;
}

/**
 * Every member answers `store-failed` — the volume is unwritable, the file is
 * not a database, the disk is full. Its own kind of stub: the failure a
 * surface must report as `503` rather than fold into `401`/`404`, which is
 * otherwise unreachable from a test without corrupting a real volume.
 */
export function createStoreFailingAuthorization(): Authorization {
  const failure = () => authorizationError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, 'volume is unwritable') }, 'could not open the structured store');
  return {
    ...createStubAuthorization(),
    async verifyOperatorApiToken() {
      return err(failure());
    },
    async issueOperatorApiToken() {
      return err(failure());
    },
    async revokeClient() {
      return err(failure());
    },
    async revokeGrant() {
      return err(failure());
    },
    async revokeToken() {
      return err(failure());
    },
  };
}
