import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import type { Subject } from '../shared/brands.ts';

/**
 * S31.2 — discovery and the authorization-code exchange are plain `fetch`
 * calls, hand-written in this repo's own code (a single request against a
 * known JSON shape is not worth a dependency); `jose` is scoped to the one
 * place hand-rolling would be a materially worse trade — JWKS-based,
 * multi-algorithm JWT signature verification. See `design/90-decisions.md`,
 * 2026-08-19, "S31's OIDC id-token verification uses `jose`".
 */

export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 5_000;

/** `null` on any failure — a closed port, a timeout, a malformed document — collapsed the same way `completeOidc`'s `discovery` reason does not distinguish them (`20-contract.md` § `OperatorIdentityError`). */
export async function discoverOidc(issuer: string): Promise<OidcDiscoveryDocument | null> {
  try {
    const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
    const url = new URL('.well-known/openid-configuration', base);
    const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      readonly issuer?: unknown;
      readonly authorization_endpoint?: unknown;
      readonly token_endpoint?: unknown;
      readonly jwks_uri?: unknown;
    };
    if (
      typeof body.issuer !== 'string' ||
      typeof body.authorization_endpoint !== 'string' ||
      typeof body.token_endpoint !== 'string' ||
      typeof body.jwks_uri !== 'string'
    ) {
      return null;
    }
    return {
      issuer: body.issuer,
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      jwksUri: body.jwks_uri,
    };
  } catch {
    return null;
  }
}

export interface ExchangeCodeParams {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
}

/** Returns the raw `id_token`, or `null` on any transport, status or shape failure. */
export async function exchangeCodeForIdToken(tokenEndpoint: string, params: ExchangeCodeParams): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set('client_secret', params.clientSecret);

  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { readonly id_token?: unknown };
    return typeof parsed.id_token === 'string' ? parsed.id_token : null;
  } catch {
    return null;
  }
}

export type OidcVerifyOutcome = { readonly ok: true; readonly subject: Subject } | { readonly ok: false; readonly reason: 'jwks' | 'signature' | 'validity-window' };

/**
 * `jose`'s `jwtVerify` checks signature, `iss`, `aud`, `exp`, `iat` and `nbf`
 * against the clock in one call — this only has to route which of those
 * failed into the contract's three narrower reasons (`discovery` is the
 * caller's, for a fetch that never got this far).
 */
export async function verifyIdToken(idToken: string, discovery: OidcDiscoveryDocument, clientId: string): Promise<OidcVerifyOutcome> {
  let jwks: ReturnType<typeof createRemoteJWKSet>;
  try {
    jwks = createRemoteJWKSet(new URL(discovery.jwksUri));
  } catch {
    return { ok: false, reason: 'jwks' };
  }

  try {
    const { payload } = await jwtVerify(idToken, jwks, { issuer: discovery.issuer, audience: clientId });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return { ok: false, reason: 'validity-window' };
    }
    return { ok: true, subject: payload.sub as Subject };
  } catch (cause) {
    if (cause instanceof joseErrors.JWTExpired || cause instanceof joseErrors.JWTClaimValidationFailed) {
      return { ok: false, reason: 'validity-window' };
    }
    if (cause instanceof joseErrors.JWKSNoMatchingKey || cause instanceof joseErrors.JWKSMultipleMatchingKeys || cause instanceof joseErrors.JWKSTimeout) {
      return { ok: false, reason: 'jwks' };
    }
    return { ok: false, reason: 'signature' };
  }
}
