import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { SessionId, Subject } from '../shared/brands.ts';
import { timingSafeStringEqual } from '../shared/timing-safe.ts';
import type { OperatorIdentity, OperatorSession } from '../operator-identity/operator-identity.ts';
import type { OperatorIdentityError } from '../operator-identity/errors.ts';

export interface ConsoleAuthDependencies {
  readonly identity: OperatorIdentity;
  readonly sessionAbsoluteSeconds: number;
}

const SESSION_COOKIE = 'szg_session';
const CSRF_COOKIE = 'szg_csrf';
const MAX_BODY_BYTES = 16_384;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string | string[]>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function errorStatus(error: OperatorIdentityError): number {
  return error.code === 'store-failed' ? 503 : 401;
}

function sendError(res: ServerResponse, error: OperatorIdentityError): void {
  sendJson(res, errorStatus(error), { error: error.code });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape in one cookie is not a reason to fail the
      // whole header — skip it, so a garbled unrelated cookie can't turn
      // into a 500 on every /auth/* route.
    }
  }
  return cookies;
}

/**
 * `HttpOnly`, `Secure`, `SameSite=Lax`, no `Domain` attribute — the last is
 * what "host-scoped, no subdomain sharing" means: a `Domain` attribute is
 * what *widens* a cookie to subdomains, so omitting it is the host-scoping
 * (`10-design.md` § Console session).
 */
function sessionSetCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** Deliberately not `HttpOnly`: the double-submit pattern requires client script to read and echo it. */
function csrfSetCookie(token: string, maxAgeSeconds: number): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sessionEnvelope(session: OperatorSession): unknown {
  return {
    subject: session.subject,
    createdAt: session.createdAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    totpReenrolRequired: session.totpReenrolRequired,
  };
}

function loginCookies(session: OperatorSession, sessionAbsoluteSeconds: number): string[] {
  return [sessionSetCookie(session.id, sessionAbsoluteSeconds), csrfSetCookie(randomBytes(32).toString('hex'), sessionAbsoluteSeconds)];
}

/**
 * Resolves the session cookie into a live `OperatorSession`, touching it (the
 * idle-timeout refresh every console route is expected to perform). `null`
 * with the response already sent to `401` on any failure — the pipeline
 * invariant E8 wants covered by every route this module owns, not just the
 * ones with acceptance tests naming it.
 */
export async function requireSession(deps: ConsoleAuthDependencies, req: IncomingMessage, res: ServerResponse): Promise<OperatorSession | null> {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) {
    sendJson(res, 401, { error: 'session-unknown' });
    return null;
  }
  const touched = await deps.identity.touch(raw as SessionId);
  if (!touched.ok) {
    sendError(res, touched.error);
    return null;
  }
  return touched.value;
}

/**
 * The session cookie's raw id, without touching the session — for routes
 * whose own identity call (`beginTotpReenrol`/`completeTotpReenrol`) already
 * validates liveness and extends the idle timeout on its own, so routing
 * through `requireSession` first would touch the same session twice per
 * request.
 */
function sessionIdFromCookie(req: IncomingMessage, res: ServerResponse): SessionId | null {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) {
    sendJson(res, 401, { error: 'session-unknown' });
    return null;
  }
  return raw as SessionId;
}

/**
 * The `Origin` half of invariant E7, on its own: the request's declared
 * origin must be this service's own host. Applied to every mutating
 * `/auth/*` route as blanket defense-in-depth, not because the contract
 * requires it there — E7 itself is scoped to "mutating **cookie** routes",
 * and enrol/login/recovery-code/break-glass authenticate by secret, not by
 * cookie, so none of them are exploitable by a forged cross-site request
 * (it can't supply a secret it doesn't have). Recorded on the PR #8 review
 * thread rather than left implicit: a uniform "Origin checked everywhere"
 * rule is simpler to state and audit than "checked except on these four".
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Invariant E7 in full: every mutating cookie route needs an `Origin` check
 * and a double-submit token. Checked after the session itself, so a request
 * with no valid session answers `401` (an auth problem) rather than `403`
 * (a CSRF problem) — the two are different failures and the design gives
 * both a named response.
 */
export function csrfOk(req: IncomingMessage): boolean {
  if (!originOk(req)) return false;

  const cookies = parseCookies(req.headers.cookie);
  const csrfCookie = cookies[CSRF_COOKIE];
  const headerValue = req.headers['x-csrf-token'];
  const presented = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!csrfCookie || !presented) return false;
  return timingSafeStringEqual(presented, csrfCookie);
}

/**
 * Returns `true` if the request matched a route under `/auth/` and the
 * response was handled (success or a named failure) — `false` only for a
 * path under `/auth/` that names no route, so the caller falls through to
 * its own 404.
 */
export async function handleConsoleAuthRoute(
  deps: ConsoleAuthDependencies,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/auth/enrol') {
    if (!originOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const result = await deps.identity.enrol({
      provisioningSecret: stringField(body, 'provisioningSecret'),
      subject: stringField(body, 'subject') as Subject,
      password: stringField(body, 'password'),
    });
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, result.value);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    if (!originOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const result = await deps.identity.loginLocal({
      subject: stringField(body, 'subject') as Subject,
      password: stringField(body, 'password'),
      totpCode: stringField(body, 'totpCode'),
    });
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, sessionEnvelope(result.value), {
      'Set-Cookie': loginCookies(result.value, deps.sessionAbsoluteSeconds),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/login/recovery-code') {
    if (!originOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const result = await deps.identity.loginWithRecoveryCode(
      stringField(body, 'subject') as Subject,
      stringField(body, 'password'),
      stringField(body, 'code'),
    );
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, sessionEnvelope(result.value), {
      'Set-Cookie': loginCookies(result.value, deps.sessionAbsoluteSeconds),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/login/break-glass') {
    if (!originOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const result = await deps.identity.loginWithBreakGlass(stringField(body, 'token'));
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, sessionEnvelope(result.value), {
      'Set-Cookie': loginCookies(result.value, deps.sessionAbsoluteSeconds),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/auth/login/oidc') {
    const result = await deps.identity.beginOidc();
    if (!result.ok) {
      // A full-page navigation, not a fetch (`Login.tsx`'s `sso-link`) — a
      // JSON error body here would strand the operator on a bare error page
      // with no way back. Redirect to the app instead, carrying the error
      // code as a query param it can surface.
      res.writeHead(302, { Location: `/?oidcError=${encodeURIComponent(result.error.code)}` });
      res.end();
      return true;
    }
    res.writeHead(302, { Location: result.value.authorizeUrl });
    res.end();
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/auth/login/oidc/callback') {
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const result = await deps.identity.completeOidc(code, state);
    if (!result.ok) {
      res.writeHead(302, { Location: `/?oidcError=${encodeURIComponent(result.error.code)}` });
      res.end();
      return true;
    }
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': loginCookies(result.value, deps.sessionAbsoluteSeconds),
    });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/totp-reenrol/begin') {
    const sessionId = sessionIdFromCookie(req, res);
    if (!sessionId) return true;
    if (!csrfOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const result = await deps.identity.beginTotpReenrol(sessionId);
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, result.value);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/totp-reenrol/complete') {
    const sessionId = sessionIdFromCookie(req, res);
    if (!sessionId) return true;
    if (!csrfOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const result = await deps.identity.completeTotpReenrol(sessionId, stringField(body, 'totpCode'));
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, { reenrolled: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/auth/session') {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    sendJson(res, 200, sessionEnvelope(session));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    if (!csrfOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const result = await deps.identity.logout(session.id);
    if (!result.ok) {
      sendError(res, result.error);
      return true;
    }
    sendJson(res, 200, { loggedOut: true }, { 'Set-Cookie': [clearCookie(SESSION_COOKIE), clearCookie(CSRF_COOKIE)] });
    return true;
  }

  return false;
}
