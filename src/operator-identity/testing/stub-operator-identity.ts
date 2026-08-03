import { err } from '../../shared/outcome.ts';
import { operatorIdentityError } from '../errors.ts';
import type { OperatorIdentity } from '../operator-identity.ts';

/**
 * A stub for tests that exercise a surface *around* operator identity —
 * `/healthz`, `/version`, `/health` — without exercising identity itself.
 * Every method reports "nothing provisioned, no session", which is honest
 * for a module nobody has called `enrol` on, rather than a mock standing in
 * for behaviour the test never triggers.
 */
export function createStubOperatorIdentity(): OperatorIdentity {
  return {
    async provisioningState() {
      return 'pending';
    },
    async enrol() {
      return err(operatorIdentityError({ code: 'not-provisioned' }, 'stub: enrol not exercised'));
    },
    async loginLocal() {
      return err(operatorIdentityError({ code: 'not-provisioned' }, 'stub: loginLocal not exercised'));
    },
    async loginWithRecoveryCode() {
      return err(operatorIdentityError({ code: 'not-provisioned' }, 'stub: loginWithRecoveryCode not exercised'));
    },
    async loginWithBreakGlass() {
      return err(operatorIdentityError({ code: 'not-provisioned' }, 'stub: loginWithBreakGlass not exercised'));
    },
    async beginOidc() {
      return err(operatorIdentityError({ code: 'oidc-unavailable', reason: 'discovery' }, 'stub: beginOidc not exercised'));
    },
    async completeOidc() {
      return err(operatorIdentityError({ code: 'oidc-unavailable', reason: 'discovery' }, 'stub: completeOidc not exercised'));
    },
    async touch() {
      return err(operatorIdentityError({ code: 'session-unknown' }, 'stub: no session ever exists'));
    },
    async logout() {
      return err(operatorIdentityError({ code: 'session-unknown' }, 'stub: no session ever exists'));
    },
    async revokeSession() {
      return err(operatorIdentityError({ code: 'session-unknown' }, 'stub: no session ever exists'));
    },
    async listSessions() {
      return [];
    },
    async runRetention() {
      return { module: 'operator-identity-stub', deletedRows: 0, freedBytes: 0, skipped: ['stub'] };
    },
  };
}
