import type { ClientId, DeclarationId, Generation, GrantId, IsoUtcTimestamp, McpResourceUri, SaltedHash, Subject, TokenId } from '../shared/brands.ts';
import type { BearerToken, HttpsUrl } from '../shared/brands.ts';
import type { Scope } from '../contract/capabilities.ts';

/** `20-contract.md` § Authorization records. */
export type GrantKind = 'mcp' | 'operator-api';
export type TokenKind = 'access' | 'refresh';

export interface OAuthClient {
  readonly clientId: ClientId;
  readonly redirectUris: readonly HttpsUrl[];
  readonly registeredAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}

export interface Grant {
  readonly grantId: GrantId;
  readonly kind: GrantKind;
  readonly clientId: ClientId | null;
  readonly subject: Subject;
  readonly resource: McpResourceUri | null;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly scopes: readonly Scope[];
  readonly createdAt: IsoUtcTimestamp;
  readonly lastUsedAt: IsoUtcTimestamp | null;
  readonly revokedAt: IsoUtcTimestamp | null;
}

export interface Token {
  readonly jti: TokenId;
  readonly grantId: GrantId;
  readonly kind: TokenKind;
  readonly verifierHash: SaltedHash;
  readonly issuedAt: IsoUtcTimestamp;
  readonly expiresAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}

export interface IssuedToken {
  readonly jti: TokenId;
  readonly value: BearerToken;
  readonly expiresAt: IsoUtcTimestamp;
}

export interface GrantView {
  readonly grant: Grant;
  readonly client: OAuthClient | null;
  readonly activeTokens: number;
  readonly liveSessions: number;
}

export interface ClientRegistrationRequest {
  readonly redirectUris: readonly HttpsUrl[];
  readonly clientName: string;
}

export interface RefreshedTokens {
  readonly access: IssuedToken;
  readonly refresh: IssuedToken;
}
