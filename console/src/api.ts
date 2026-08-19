/**
 * A thin fetch wrapper over the console's own route table
 * (`20-contract.md` § L5 — surfaces). Every mutating call reads the
 * double-submit CSRF cookie and echoes it in `X-CSRF-Token`
 * (`console-auth-routes.ts`'s `csrfOk`); `credentials: 'same-origin'` is what
 * makes the session and CSRF cookies travel at all.
 */

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)szg_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: 'same-origin', headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken();
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const parsed = text.length > 0 ? JSON.parse(text) : {};
  return { ok: res.ok, status: res.status, body: parsed as T };
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body ?? {}, signal),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('PATCH', path, body ?? {}, signal),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>('DELETE', path, undefined, signal),
};

/**
 * The fetch/cancel-guard/error shape every view's initial-load `useEffect`
 * needs — shared so it has one home instead of being hand-copied per view
 * (`Landing.tsx`, `Grants.tsx`). `cancelledRef` is checked before either
 * handler runs, so a response that resolves after the caller has unmounted
 * triggers neither a `setState` nor a callback like `onSignedOut`.
 */
export async function loadResource<T>(
  path: string,
  cancelledRef: { readonly current: boolean },
  handlers: { readonly onSuccess: (body: T) => void; readonly onError: (status: number) => void },
): Promise<void> {
  const res = await api.get<T>(path);
  if (cancelledRef.current) return;
  if (!res.ok) {
    handlers.onError(res.status);
    return;
  }
  handlers.onSuccess(res.body);
}

export interface SessionEnvelope {
  readonly subject: string;
  readonly createdAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly totpReenrolRequired: boolean;
}

export interface TotpReenrolStart {
  readonly totpSecret: string;
}

export interface EnrolResult {
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
}

export interface DeclarationListRow {
  readonly declaration: {
    readonly id: string;
    readonly host: string;
    readonly cloneUrl: string;
    readonly pinned: boolean;
    readonly [key: string]: unknown;
  };
  readonly clone: {
    readonly state: string;
    readonly lastOperationAt: string | null;
    readonly [key: string]: unknown;
  } | null;
  readonly branch: string | null;
  readonly dirty: boolean;
}

export interface OAuthClientRecord {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly registeredAt: string;
  readonly revokedAt: string | null;
}

export interface GrantRecord {
  readonly grantId: string;
  readonly kind: 'mcp' | 'operator-api';
  readonly clientId: string | null;
  readonly subject: string;
  readonly resource: string | null;
  readonly declarationId: string | null;
  readonly generation: number | null;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface GrantView {
  readonly grant: GrantRecord;
  readonly client: OAuthClientRecord | null;
  readonly activeTokens: number;
  readonly liveSessions: number;
}

export interface OperatorSessionListing {
  readonly ref: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
}

export interface GrantsView {
  readonly grants: readonly GrantView[];
  readonly operatorSessions: readonly OperatorSessionListing[];
}

export interface AuditRecordDto {
  readonly sequence: number;
  readonly at: string;
  readonly operationId: string | null;
  readonly declarationId: string | null;
  readonly generation: number | null;
  readonly tool: string | null;
  readonly actorRef: { readonly kind: string; readonly subject: string };
  readonly context: string;
  readonly form: string;
  readonly previousHash: string | null;
  readonly hash: string;
  readonly [key: string]: unknown;
}

export interface RetainedAnchorDto {
  readonly segment: number;
  readonly terminalSequence: number;
  readonly terminalHash: string;
  readonly retainedAt: string;
}

export interface AuditChainBreakDto {
  readonly atSequence: number;
  readonly expectedHash: string;
  readonly foundHash: string | null;
}

export interface AuditChainStateDto {
  readonly verifiedThrough: number | null;
  readonly headHash: string | null;
  readonly mirroredHeadHash: string | null;
  readonly retainedAnchors: readonly RetainedAnchorDto[];
  readonly chainBreak: AuditChainBreakDto | null;
}

export interface AuditPageDto {
  readonly records: readonly AuditRecordDto[];
  readonly nextCursor: string | null;
  readonly chain: AuditChainStateDto;
}

export interface AuditFilter {
  readonly declarationId: string;
  readonly tool: string;
  readonly actorSubject: string;
  readonly form: string;
  readonly from: string;
  readonly to: string;
}

export function auditQueryPath(filter: AuditFilter, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filter.declarationId) params.set('declarationId', filter.declarationId);
  if (filter.tool) params.set('tool', filter.tool);
  if (filter.actorSubject) params.set('actorSubject', filter.actorSubject);
  if (filter.form) params.set('form', filter.form);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `/audit?${query}` : '/audit';
}
