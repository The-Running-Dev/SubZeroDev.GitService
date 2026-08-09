import { randomUUID } from 'node:crypto';
import { ok, err } from '../../shared/outcome.ts';
import type { SessionId, Subject } from '../../shared/brands.ts';
import type { Session } from '../../shared/session.ts';
import { authorizationError } from '../errors.ts';
import type { Authorization } from '../authorization.ts';

/**
 * A stub for tests that exercise a surface *around* bearer authentication —
 * the health/version/parked-operations routes — without exercising the real
 * `Authorization` module's store-backed verification. Mirrors
 * `createStubDispatchPipeline` and `createStubDeclarations`'s reasoning: a
 * fixed, in-memory set of valid bearer values stands in for a real token
 * store, honest about being a stand-in rather than pretending to persist
 * anything.
 */
export function createStubAuthorization(validTokens: ReadonlyMap<string, Subject> = new Map()): Authorization {
  const stub: Authorization = {
    async registerClient() {
      return err(authorizationError({ code: 'registration-invalid', findings: [] }, 'stub: registerClient not exercised'));
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
        grant: new Set() as unknown as Session['grant'],
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
    async runRetention() {
      return { module: 'authorization', deletedRows: 0, freedBytes: 0, skipped: ['stub'] };
    },
  };
  return stub;
}
