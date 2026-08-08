import type { DeclarationId, GrantEpoch, PathPrefix, SessionId } from './brands.ts';
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
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly frozenAtEpoch: GrantEpoch;
}
