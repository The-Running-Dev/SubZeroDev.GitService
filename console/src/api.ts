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
