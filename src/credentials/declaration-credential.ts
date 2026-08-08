import { cloneUrlHost, type CredentialRef } from '../shared/brands.ts';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { CredentialBinding, MutableEnv } from '../exec/exec.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CredentialResolver } from './credentials.ts';

export interface PreparedCredential {
  readonly credential: CredentialBinding | null;
  readonly ref: CredentialRef | null;
}

export interface DeclarationCredentialDependencies {
  readonly declarations?: Pick<Declarations, 'get'>;
  readonly credentials?: Pick<CredentialResolver, 'allowedHosts' | 'resolveInto'>;
  /**
   * The same `MutableEnv` `Exec` was built with. `resolveInto` writes the
   * secret here and `Exec` reads it back by variable name; nothing in between
   * ever holds the value.
   */
  readonly credentialEnv?: MutableEnv;
}

function moduleError(resultKind: ModuleErrorBase['resultKind'], summary: string): ModuleErrorBase {
  return { resultKind, retryable: false, summary };
}

/**
 * Everything an operation needs before it may touch a network, in the order
 * the design fixes:
 *
 * 1. the declaration, because the credential reference and the clone URL are
 *    its fields and not the call context's;
 * 2. the reference's **own** allowed-host constraint against that clone URL's
 *    host — the second guard, independent of the deployment's remote-host
 *    allowlist, so neither alone carries the property;
 * 3. resolution, at the moment of use, into the shared `MutableEnv`.
 *
 * A declaration with no `credentialRef` reaches a public remote with no
 * credential at all, which is a legitimate configuration (a public mirror, or
 * a local path in a test) and not a refusal.
 *
 * Shared by the remote git operations (S9) and the host adapter (S10). It
 * lives here rather than in either because both need it and a rule with two
 * homes is a promise they will diverge.
 */
export async function prepareDeclarationCredential(
  deps: DeclarationCredentialDependencies,
  ctx: CallContext,
): Promise<Outcome<PreparedCredential, ModuleErrorBase>> {
  if (!deps.declarations || !deps.credentials || !deps.credentialEnv) {
    return err(moduleError('infrastructure', 'this instance has no credential resolver configured, and will not reach a remote without one'));
  }
  if (ctx.declarationId === null) {
    return err(moduleError('infrastructure', 'no declaration in context for a remote operation'));
  }
  const declaration = await deps.declarations.get(ctx.declarationId);
  if (declaration === null) {
    return err(moduleError('precondition', `declaration '${ctx.declarationId}' no longer exists`));
  }
  const ref = declaration.credentialRef;
  if (ref === null) return ok({ credential: null, ref: null });

  const host = cloneUrlHost(declaration.cloneUrl as string);
  if (host !== null) {
    const allowed = await deps.credentials.allowedHosts(ref);
    if (!allowed.ok) return err(allowed.error);
    if (!allowed.value.some((permitted) => (permitted as string).toLowerCase() === host)) {
      return err(moduleError('authorization', `credential reference '${ref}' is not permitted to reach '${host}'`));
    }
  }

  const resolved = await deps.credentials.resolveInto(ref, ctx.declarationId, deps.credentialEnv);
  if (!resolved.ok) return err(resolved.error);
  return ok({ credential: resolved.value, ref });
}
