import type { DeclarationId, GrantEpoch, SessionId } from './brands.ts';
import type { ActorRef } from './actor.ts';
import type { SessionGrant } from '../contract/capabilities.ts';
import type { SessionKind } from '../declarations/types.ts';

export type { SessionKind } from '../declarations/types.ts';

/** `20-contract.md` § Actors, profiles and sessions › `Session`. */
export interface Session {
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly actorRef: ActorRef;
  readonly repositoryBinding: DeclarationId | null;
  readonly grant: SessionGrant;
  /**
   * No `writablePathPrefixes` member. The path allowlist is not carried on a
   * session: `DispatchPipeline.buildContext` derives it per call from
   * `PROFILE_BY_KIND[session.kind]` through
   * `Declarations.effectiveWritablePrefixes(declaration, profile)`, which is
   * what **A4** ("no layer adds a prefix") is written against. A session-borne
   * copy was declared here until the 2026-09-07 reconciliation and was read by
   * nothing; every construction site set `[]`, so the first path to consult it
   * would have silently narrowed the operator route to no writable paths at
   * all. Derivation from `kind` cannot drift that way — there is no value for a
   * surface to forget to set.
   */
  readonly frozenAtEpoch: GrantEpoch;
}
