import type { IsoUtcTimestamp, SessionId, Subject } from '../shared/brands.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { StoreError } from '../store/errors.ts';
import type { RetentionReport } from '../shared/retention.ts';
import type { Outcome } from '../shared/outcome.ts';

// ─── Public types (mirror of contract § L4 — operator identity) ─────────────

export type ProvisioningState = 'pending' | 'complete';

export interface EnrolmentRequest {
  readonly provisioningSecret: string;
  readonly subject: Subject;
  readonly password: string;
}

export interface EnrolmentResult {
  /** Base32-encoded TOTP secret, shown exactly once. */
  readonly totpSecret: string;
  /** Ten single-use codes, shown exactly once. */
  readonly recoveryCodes: readonly string[];
}

export interface LocalLoginRequest {
  readonly subject: Subject;
  readonly password: string;
  readonly totpCode: string;
}

export interface OperatorSession {
  readonly id: SessionId;
  readonly subject: Subject;
  readonly createdAt: IsoUtcTimestamp;
  readonly lastSeenAt: IsoUtcTimestamp;
  readonly idleExpiresAt: IsoUtcTimestamp;
  readonly absoluteExpiresAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}

export interface OidcRedirect {
  readonly authorizeUrl: string; // HttpsUrl — out of scope for S4
  readonly state: string;
}

export type OperatorIdentityError = ModuleErrorBase &
  (
    | { readonly code: 'not-provisioned' }
    | { readonly code: 'already-provisioned' }
    | { readonly code: 'provisioning-secret-invalid' }
    | { readonly code: 'credentials-invalid' }
    | { readonly code: 'totp-invalid' }
    | { readonly code: 'totp-key-unavailable' }
    | { readonly code: 'recovery-code-invalid' }
    | { readonly code: 'recovery-code-used' }
    | { readonly code: 'break-glass-invalid' }
    | {
        readonly code: 'oidc-unavailable';
        readonly reason: 'discovery' | 'jwks' | 'signature' | 'validity-window';
      }
    | { readonly code: 'subject-not-allowlisted'; readonly subject: Subject }
    | { readonly code: 'session-unknown' }
    | { readonly code: 'session-expired' }
    | { readonly code: 'session-revoked' }
    | { readonly code: 'store-failed'; readonly cause: StoreError }
  );

export interface OperatorIdentity {
  provisioningState(): Promise<ProvisioningState>;
  enrol(request: EnrolmentRequest): Promise<Outcome<EnrolmentResult, OperatorIdentityError>>;

  loginLocal(
    request: LocalLoginRequest,
  ): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  loginWithRecoveryCode(
    subject: Subject,
    password: string,
    code: string,
  ): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  loginWithBreakGlass(
    token: string,
  ): Promise<Outcome<OperatorSession, OperatorIdentityError>>;

  /** OIDC login — out of scope until S18. Always returns `oidc-unavailable`. */
  beginOidc(): Promise<Outcome<OidcRedirect, OperatorIdentityError>>;
  /** OIDC callback — out of scope until S18. Always returns `oidc-unavailable`. */
  completeOidc(
    code: string,
    state: string,
  ): Promise<Outcome<OperatorSession, OperatorIdentityError>>;

  touch(sessionId: SessionId): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  logout(sessionId: SessionId): Promise<Outcome<void, OperatorIdentityError>>;
  revokeSession(
    sessionId: SessionId,
    actorSubject: Subject,
  ): Promise<Outcome<void, OperatorIdentityError>>;
  listSessions(): Promise<readonly OperatorSession[]>;
  runRetention(): Promise<RetentionReport>;
}
