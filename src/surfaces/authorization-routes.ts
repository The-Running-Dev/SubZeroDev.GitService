import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientId, GrantId, Subject, TokenId } from '../shared/brands.ts';
import type { Authorization } from '../authorization/authorization.ts';
import type { GrantKind } from '../authorization/types.ts';
import type { OperatorScope } from '../contract/capabilities.ts';
import type { OperatorIdentity } from '../operator-identity/operator-identity.ts';
import { csrfOk, requireSession, type ConsoleAuthDependencies } from './console-auth-routes.ts';

export interface AuthorizationRoutesDependencies extends ConsoleAuthDependencies {
  readonly authorization: Authorization;
  readonly identity: OperatorIdentity;
}

const KNOWN_SCOPES: readonly OperatorScope[] = ['read', 'write', 'raw', 'schedule'];

function requireCsrf(req: IncomingMessage, res: ServerResponse): boolean {
  if (csrfOk(req)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'csrf-check-failed' }));
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > 65_536) return null;
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

function parseScopes(body: Record<string, unknown>): readonly OperatorScope[] | null {
  const raw = body.scopes;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const scopes: OperatorScope[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !KNOWN_SCOPES.includes(value as OperatorScope)) return null;
    scopes.push(value as OperatorScope);
  }
  return scopes;
}

/**
 * `20-contract.md` § U4: the full HTTP route table is not fixed, so — the
 * same precedent `tool-routes.ts`'s own doc comment follows — this is a
 * small, self-contained namespace under `/grants`, free for U4 to fold or
 * rename later. Every route here is a cookie route: issuing or revoking a
 * credential is exactly the kind of action the design reserves for the
 * console (`10-design.md`, "Revocation is reachable only from the console,
 * under `auth.manage`").
 */
export async function handleAuthorizationRoute(deps: AuthorizationRoutesDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/grants') {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    const kindParam = url.searchParams.get('kind');
    const kind: GrantKind | null = kindParam === 'mcp' || kindParam === 'operator-api' ? kindParam : null;
    const [grants, operatorSessions] = await Promise.all([deps.authorization.listGrants(kind), deps.identity.listSessions()]);
    sendJson(res, 200, { grants, operatorSessions });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/grants/tokens') {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    if (!requireCsrf(req, res)) return true;
    const body = await readJsonBody(req);
    const scopes = body ? parseScopes(body) : null;
    if (!scopes) {
      sendJson(res, 400, { error: 'bad-request', summary: `scopes must be a non-empty array drawn from ${KNOWN_SCOPES.join(', ')}` });
      return true;
    }
    const issued = await deps.authorization.issueOperatorApiToken(session.subject as Subject, scopes, {
      kind: 'operator',
      subject: session.subject as Subject,
      clientId: null,
      grantId: null,
    });
    if (!issued.ok) {
      sendJson(res, issued.error.code === 'store-failed' ? 503 : 400, { error: issued.error.code, summary: issued.error.summary });
      return true;
    }
    sendJson(res, 200, issued.value);
    return true;
  }

  const revokeGrantMatch = /^\/grants\/([^/]+)\/revoke$/.exec(url.pathname);
  if (req.method === 'POST' && revokeGrantMatch) {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    if (!requireCsrf(req, res)) return true;
    const revoked = await deps.authorization.revokeGrant(decodeURIComponent(revokeGrantMatch[1]!) as GrantId, {
      kind: 'operator',
      subject: session.subject as Subject,
      clientId: null,
      grantId: null,
    });
    sendJson(res, revoked.ok ? 200 : 404, revoked.ok ? { revoked: true } : { error: revoked.error.code, summary: revoked.error.summary });
    return true;
  }

  const revokeTokenMatch = /^\/tokens\/([^/]+)\/revoke$/.exec(url.pathname);
  if (req.method === 'POST' && revokeTokenMatch) {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    if (!requireCsrf(req, res)) return true;
    const revoked = await deps.authorization.revokeToken(decodeURIComponent(revokeTokenMatch[1]!) as TokenId, {
      kind: 'operator',
      subject: session.subject as Subject,
      clientId: null,
      grantId: null,
    });
    sendJson(res, revoked.ok ? 200 : 404, revoked.ok ? { revoked: true } : { error: revoked.error.code, summary: revoked.error.summary });
    return true;
  }

  const revokeClientMatch = /^\/clients\/([^/]+)\/revoke$/.exec(url.pathname);
  if (req.method === 'POST' && revokeClientMatch) {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    if (!requireCsrf(req, res)) return true;
    const revoked = await deps.authorization.revokeClient(decodeURIComponent(revokeClientMatch[1]!) as ClientId, {
      kind: 'operator',
      subject: session.subject as Subject,
      clientId: null,
      grantId: null,
    });
    sendJson(res, revoked.ok ? 200 : 404, revoked.ok ? { revoked: true } : { error: revoked.error.code, summary: revoked.error.summary });
    return true;
  }

  const revokeOperatorSessionMatch = /^\/operator-sessions\/([^/]+)\/revoke$/.exec(url.pathname);
  if (req.method === 'POST' && revokeOperatorSessionMatch) {
    const session = await requireSession(deps, req, res);
    if (!session) return true;
    if (!requireCsrf(req, res)) return true;
    const revoked = await deps.identity.revokeSession(decodeURIComponent(revokeOperatorSessionMatch[1]!) as never, {
      kind: 'operator',
      subject: session.subject as Subject,
      clientId: null,
      grantId: null,
    });
    sendJson(res, revoked.ok ? 200 : 404, revoked.ok ? { revoked: true } : { error: revoked.error.code, summary: revoked.error.summary });
    return true;
  }

  return false;
}
