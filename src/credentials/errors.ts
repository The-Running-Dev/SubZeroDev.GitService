import type { CredentialRef, RemoteHost } from '../shared/brands.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CredentialFailureMark } from './types.ts';

/** `20-contract.md` § Error semantics › Credentials. */
export type CredentialError = ModuleErrorBase &
  (
    | { readonly code: 'reference-not-found'; readonly ref: CredentialRef }
    | { readonly code: 'reference-unreadable'; readonly ref: CredentialRef }
    | { readonly code: 'host-not-permitted'; readonly ref: CredentialRef; readonly host: RemoteHost }
    | { readonly code: 'marked-failing'; readonly mark: CredentialFailureMark }
  );

/**
 * The four `resultKind`s the contract's own table fixes: `precondition` for a
 * reference that names nothing, `infrastructure` for one that cannot be read,
 * `authorization` for a remote the reference is not allowed to reach, and
 * `upstream` for a mark left by an earlier rejection.
 *
 * No variant carries a secret value, and none can: the only reference-shaped
 * data any of them holds is the *name*, which is what the design means by "a
 * name, never a value".
 */
export function credentialError<T extends { readonly code: CredentialError['code'] }>(variant: T, summary: string): CredentialError {
  const resultKind =
    variant.code === 'reference-not-found'
      ? 'precondition'
      : variant.code === 'host-not-permitted'
        ? 'authorization'
        : variant.code === 'marked-failing'
          ? 'upstream'
          : 'infrastructure';
  return { resultKind, retryable: false, summary, ...variant } as unknown as CredentialError;
}
