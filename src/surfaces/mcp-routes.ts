import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  declarationId as validateDeclarationId,
  declarationIdFromResource,
  mcpResourceUri,
  type BearerToken,
  type ClientId,
  type DeclarationId,
  type McpResourceUri,
  type Subject,
} from '../shared/brands.ts';
import type { Session } from '../shared/session.ts';
import type { McpScope } from '../contract/capabilities.ts';
import type { Authorization } from '../authorization/authorization.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { DispatchPipeline } from '../dispatch/dispatch-pipeline.ts';
import { authorization as authorizationResult } from '../result/envelope.ts';
import { requireSession, csrfOk, type ConsoleAuthDependencies } from './console-auth-routes.ts';

const SUPPORTED_SCOPES: readonly McpScope[] = ['read', 'write', 'raw', 'schedule'];
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
/**
 * The one truly unbounded-memory risk in this file: `/oauth/register` and
 * `/oauth/authorize` (`GET`) are unauthenticated by transport (registration
 * and starting a login flow have no token yet), so without a cap a remote
 * caller could grow this process-local `Map` without bound. `oauth_client`
 * and `grant` rows are bounded by disk instead, since `registerClient` and
 * `issueMcpGrant` write durably rather than holding an in-memory `Map`.
 */
const MAX_PENDING_AUTHORIZATIONS = 500;

/**
 * Unlike `pendingAuthorizations`/`issuedCodes`, a `Session` carries no
 * `expiresAt` of its own — its liveness is checked lazily against the
 * underlying grant on every call (`resolveLiveSession`). Without a cap, a
 * client that reconnects and re-`initialize`s repeatedly (ordinary behaviour
 * after any network blip) grows this `Map` without bound. Evicting the
 * oldest entry on overflow keeps it bounded the same way the other two maps
 * are, without needing a TTL concept `Session` does not have.
 */
const MAX_SESSIONS = 1000;

interface PendingAuthorization {
  readonly clientId: ClientId;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly scopes: readonly McpScope[];
  readonly codeChallenge: string;
  readonly resource: McpResourceUri;
  readonly declarationId: DeclarationId;
  readonly expiresAt: number;
}

interface IssuedCode {
  readonly clientId: ClientId;
  readonly redirectUri: string;
  readonly scopes: readonly McpScope[];
  readonly codeChallenge: string;
  readonly resource: McpResourceUri;
  readonly declarationId: DeclarationId;
  readonly expiresAt: number;
}

/**
 * The three pieces of process-local state this surface owns. Constructed
 * once by the composition root and threaded through as part of
 * `McpRoutesDependencies` — not module-level `Map`s, so a test file
 * constructing more than one server never leaks state between them.
 */
export interface McpRoutesState {
  readonly sessions: Map<string, Session>;
  readonly pendingAuthorizations: Map<string, PendingAuthorization>;
  readonly issuedCodes: Map<string, IssuedCode>;
}

export function createMcpRoutesState(): McpRoutesState {
  return { sessions: new Map(), pendingAuthorizations: new Map(), issuedCodes: new Map() };
}

export interface McpRoutesDependencies extends ConsoleAuthDependencies {
  readonly authorization: Pick<Authorization, 'registerClient' | 'getClient' | 'issueMcpGrant' | 'establishMcpSession' | 'refresh' | 'recomputeSessionGrant' | 'grantIsLive' | 'revokeBearerToken'>;
  readonly declarations: Pick<Declarations, 'get'>;
  readonly dispatchPipeline: Pick<DispatchPipeline, 'dispatch' | 'visibleTools'>;
  readonly mcpState: McpRoutesState;
  /** This instance's public origin, e.g. `https://git.example.com` — no trailing slash. Needed for absolute metadata URLs and the `resource_metadata` challenge. */
  readonly origin: string;
}

function pruneExpired<T extends { readonly expiresAt: number }>(items: Map<string, T>, now: number): void {
  for (const [key, value] of items) {
    if (value.expiresAt <= now) items.delete(key);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

/**
 * `20-contract.md` § L5 — surfaces: the first nine `AuthorizationError`
 * variants are transport-level `401` with this challenge, never a
 * `ToolResult`. One place builds the header, so the resource-metadata URL
 * it points at can never drift from `wellKnownPath` below.
 */
function unauthorized(res: ServerResponse, origin: string, declarationIdValue: string, summary: string): void {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp/${declarationIdValue}`;
  sendJson(res, 401, { error: 'invalid_token', error_description: summary }, { 'WWW-Authenticate': `Bearer realm="subzerodev-git", resource_metadata="${metadataUrl}"` });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 65_536): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > maxBytes) return null;
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

async function readFormBody(req: IncomingMessage, maxBytes = 16_384): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > maxBytes) return null;
    chunks.push(buf);
  }
  try {
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function randomOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function isValidVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] as string);
}

function bearerFrom(req: IncomingMessage): BearerToken | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length) as BearerToken;
}

/**
 * Resolves the caller's live, current `Session` from the `Mcp-Session-Id`
 * header — `20-contract.md` § control flow step 5: re-intersect the
 * declaration's `grantEpoch` against the one the session froze at, and
 * check the grant itself is still live. Both conditions close the session
 * (removed from `deps.mcpState.sessions`) rather than just refusing this
 * one call — a revoked or orphaned resource does not get re-checked next
 * time, it is gone.
 */
async function resolveLiveSession(
  deps: McpRoutesDependencies,
  req: IncomingMessage,
  res: ServerResponse,
  declarationIdValue: string,
): Promise<Session | null> {
  const header = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(header) ? header[0] : header;
  const session = sessionId ? deps.mcpState.sessions.get(sessionId) : undefined;
  if (!sessionId || !session) {
    unauthorized(res, deps.origin, declarationIdValue, 'no such MCP session — reconnect and re-initialize');
    return null;
  }
  if (session.actorRef.grantId && !(await deps.authorization.grantIsLive(session.actorRef.grantId))) {
    deps.mcpState.sessions.delete(sessionId);
    unauthorized(res, deps.origin, declarationIdValue, 'the grant behind this session was revoked');
    return null;
  }
  const declaration = session.repositoryBinding ? await deps.declarations.get(session.repositoryBinding) : null;
  if (!declaration || declaration.state === 'orphaned') {
    deps.mcpState.sessions.delete(sessionId);
    unauthorized(res, deps.origin, declarationIdValue, 'the declaration behind this session is gone or orphaned');
    return null;
  }
  if (session.frozenAtEpoch === declaration.grantEpoch) return session;

  const recomputed = deps.authorization.recomputeSessionGrant(session, declaration);
  if (!recomputed.ok) {
    deps.mcpState.sessions.delete(sessionId);
    unauthorized(res, deps.origin, declarationIdValue, recomputed.error.summary);
    return null;
  }
  deps.mcpState.sessions.set(sessionId, recomputed.value);
  return recomputed.value;
}

function toolResultStatus(kind: string): number {
  if (kind === 'success') return 200;
  if (kind === 'validation' || kind === 'precondition') return 400;
  if (kind === 'authorization') return 403;
  if (kind === 'conflict') return 409;
  if (kind === 'timeout') return 504;
  if (kind === 'upstream') return 502;
  return 500;
}

async function handleWellKnown(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const resourceMatch = /^\/\.well-known\/oauth-protected-resource\/mcp\/([^/]+)$/.exec(url.pathname);
  if (resourceMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const idResult = validateDeclarationId(decodeURIComponent(resourceMatch[1]!));
    if (!idResult.ok) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    sendJson(res, 200, {
      resource: `/mcp/${idResult.value}`,
      authorization_servers: [deps.origin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
    });
    return true;
  }

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    sendJson(res, 200, {
      issuer: deps.origin,
      authorization_endpoint: `${deps.origin}/oauth/authorize`,
      token_endpoint: `${deps.origin}/oauth/token`,
      registration_endpoint: `${deps.origin}/oauth/register`,
      revocation_endpoint: `${deps.origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: SUPPORTED_SCOPES,
    });
    return true;
  }

  return false;
}

async function handleRegister(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: 'invalid_client_metadata' });
    return;
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.some((uri) => typeof uri !== 'string')) {
    sendJson(res, 400, { error: 'invalid_redirect_uri' });
    return;
  }
  const clientName = typeof body.client_name === 'string' ? body.client_name : 'MCP client';
  const result = await deps.authorization.registerClient({ redirectUris: redirectUris as never, clientName });
  if (!result.ok) {
    sendJson(res, result.error.code === 'store-failed' ? 503 : 400, { error: 'invalid_client_metadata', summary: result.error.summary });
    return;
  }
  sendJson(res, 201, {
    client_id: result.value.clientId,
    client_name: clientName,
    redirect_uris: result.value.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

function authorizationForm(requestId: string, pending: PendingAuthorization, error?: string): string {
  return (
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Authorize MCP client</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{padding:.65rem 1rem;font:inherit}.warning{color:#9b1c1c}</style>` +
    `<main><h1>Authorize MCP client</h1>` +
    `<p>A client is requesting <strong>${escapeHtml(pending.scopes.join(', '))}</strong> access to <strong>${escapeHtml(pending.declarationId)}</strong>.</p>` +
    (error ? `<p class="warning">${escapeHtml(error)}</p>` : '') +
    `<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><input type="hidden" name="action" value="approve">` +
    `<button type="submit">Authorize</button></form>` +
    `<p>Only continue if you started this connection in a client you trust.</p></main></html>`
  );
}

async function handleAuthorize(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === 'GET') {
    const params = url.searchParams;
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    const responseType = params.get('response_type');
    const codeChallenge = params.get('code_challenge');
    const codeChallengeMethod = params.get('code_challenge_method');
    const resourceRaw = params.get('resource');
    const scopeParam = (params.get('scope') ?? 'read').split(' ').filter(Boolean);

    if (responseType !== 'code') {
      sendHtml(res, 400, '<!doctype html><title>Authorization error</title><p>Only response_type=code is supported.</p>');
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      sendHtml(res, 400, '<!doctype html><title>Authorization error</title><p>PKCE with code_challenge_method=S256 is required.</p>');
      return;
    }
    if (!clientId || !redirectUri) {
      sendHtml(res, 400, '<!doctype html><title>Authorization error</title><p>Missing client_id or redirect_uri.</p>');
      return;
    }
    if (!resourceRaw) {
      sendHtml(res, 400, '<!doctype html><title>Authorization error</title><p>A resource parameter naming /mcp/{declarationId} is required.</p>');
      return;
    }
    const resourceResult = mcpResourceUri(resourceRaw);
    if (!resourceResult.ok || scopeParam.some((s) => !SUPPORTED_SCOPES.includes(s as McpScope))) {
      sendHtml(res, 400, '<!doctype html><title>Authorization error</title><p>Invalid resource or scope.</p>');
      return;
    }

    pruneExpired(deps.mcpState.pendingAuthorizations, Date.now());
    if (deps.mcpState.pendingAuthorizations.size >= MAX_PENDING_AUTHORIZATIONS) {
      sendHtml(res, 503, '<!doctype html><title>Server busy</title><p>Too many pending authorization requests. Try again shortly.</p>');
      return;
    }

    const client = await deps.authorization.getClient(clientId as ClientId);
    if (!client || client.revokedAt !== null || !(client.redirectUris as readonly string[]).includes(redirectUri)) {
      sendHtml(res, 400, '<!doctype html><title>Authorization error</title><p>redirect_uri is not registered for this client.</p>');
      return;
    }

    const requestId = randomOpaqueToken();
    const pending: PendingAuthorization = {
      clientId: clientId as ClientId,
      redirectUri,
      state: params.get('state'),
      scopes: scopeParam as readonly McpScope[],
      codeChallenge,
      resource: resourceResult.value,
      declarationId: declarationIdFromResource(resourceResult.value),
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    };
    deps.mcpState.pendingAuthorizations.set(requestId, pending);
    sendHtml(res, 200, authorizationForm(requestId, pending));
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const operatorSession = await requireSession(deps, req, res);
  if (!operatorSession) return;
  if (!csrfOk(req)) {
    sendJson(res, 403, { error: 'csrf-check-failed' });
    return;
  }

  const form = await readFormBody(req);
  if (!form) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }
  const requestId = form.get('request_id') ?? '';
  const pending = deps.mcpState.pendingAuthorizations.get(requestId);
  if (!pending || pending.expiresAt <= Date.now()) {
    sendHtml(res, 400, '<!doctype html><title>Authorization expired</title><p>This authorization request expired. Return to your MCP client and try again.</p>');
    return;
  }
  deps.mcpState.pendingAuthorizations.delete(requestId);

  const code = randomOpaqueToken();
  deps.mcpState.issuedCodes.set(code, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    scopes: pending.scopes,
    codeChallenge: pending.codeChallenge,
    resource: pending.resource,
    declarationId: pending.declarationId,
    expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
  });

  const redirect = new URL(pending.redirectUri);
  redirect.searchParams.set('code', code);
  if (pending.state) redirect.searchParams.set('state', pending.state);
  res.writeHead(302, { Location: redirect.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

async function handleToken(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const form = await readFormBody(req);
  if (!form) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }
  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? '';
    const record = deps.mcpState.issuedCodes.get(code);
    deps.mcpState.issuedCodes.delete(code); // single-use, even when verification below fails
    const verifier = form.get('code_verifier') ?? '';
    const clientId = form.get('client_id');
    const redirectUri = form.get('redirect_uri');
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      !isValidVerifier(verifier) ||
      pkceChallenge(verifier) !== record.codeChallenge
    ) {
      sendJson(res, 400, { error: 'invalid_grant' });
      return;
    }
    const declaration = await deps.declarations.get(record.declarationId);
    if (!declaration) {
      sendJson(res, 400, { error: 'invalid_grant', summary: `declaration '${record.declarationId}' no longer exists` });
      return;
    }
    const issued = await deps.authorization.issueMcpGrant(
      {
        clientId: record.clientId,
        subject: record.clientId as unknown as Subject,
        resource: record.resource,
        declarationId: record.declarationId,
        generation: declaration.generation,
        scopes: record.scopes,
      },
      { kind: 'mcp', subject: record.clientId as unknown as Subject, clientId: record.clientId, grantId: null },
    );
    if (!issued.ok) {
      sendJson(res, issued.error.code === 'store-failed' ? 503 : 400, { error: 'invalid_grant', summary: issued.error.summary });
      return;
    }
    sendJson(res, 200, {
      access_token: issued.value.access.value,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.round((new Date(issued.value.access.expiresAt).getTime() - Date.now()) / 1000)),
      refresh_token: issued.value.refresh.value,
      scope: record.scopes.join(' '),
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = (form.get('refresh_token') ?? '') as BearerToken;
    const refreshed = await deps.authorization.refresh(refreshToken);
    if (!refreshed.ok) {
      sendJson(res, refreshed.error.code === 'store-failed' ? 503 : 400, { error: 'invalid_grant', summary: refreshed.error.summary });
      return;
    }
    sendJson(res, 200, {
      access_token: refreshed.value.access.value,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.round((new Date(refreshed.value.access.expiresAt).getTime() - Date.now()) / 1000)),
      refresh_token: refreshed.value.refresh.value,
    });
    return;
  }

  sendJson(res, 400, { error: 'unsupported_grant_type' });
}

async function handleRevoke(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const form = await readFormBody(req);
  const token = form?.get('token');
  if (!token) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }
  await deps.authorization.revokeBearerToken(token as BearerToken, { kind: 'operator', subject: 'oauth-revoke' as Subject, clientId: null, grantId: null });
  // RFC 7009: the endpoint answers 200 whether or not the token was known,
  // so a client cannot use it to probe for valid tokens.
  sendJson(res, 200, {});
}

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

async function handleMcpTransport(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse, declarationIdRaw: string): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const idResult = validateDeclarationId(declarationIdRaw);
  if (!idResult.ok) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const declarationIdValue = idResult.value;
  const resource = `/mcp/${declarationIdValue}` as McpResourceUri;

  const body = await readJsonBody(req);
  if (!body || typeof body.method !== 'string') {
    sendJson(res, 400, jsonRpcError(body?.id, JSONRPC_PARSE_ERROR, 'invalid JSON-RPC request'));
    return;
  }
  const rpcId = body.id;
  const method = body.method;

  if (method === 'initialize') {
    const bearer = bearerFrom(req);
    if (!bearer) {
      unauthorized(res, deps.origin, declarationIdValue, 'no bearer token presented');
      return;
    }
    const established = await deps.authorization.establishMcpSession(bearer, resource);
    if (!established.ok) {
      unauthorized(res, deps.origin, declarationIdValue, established.error.summary);
      return;
    }
    if (deps.mcpState.sessions.size >= MAX_SESSIONS) {
      const oldest = deps.mcpState.sessions.keys().next().value;
      if (oldest !== undefined) deps.mcpState.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    deps.mcpState.sessions.set(sessionId, established.value);
    sendJson(
      res,
      200,
      jsonRpcResult(rpcId, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'subzerodev-git', version: '1' },
      }),
      { 'Mcp-Session-Id': sessionId },
    );
    return;
  }

  const session = await resolveLiveSession(deps, req, res, declarationIdValue);
  if (!session) return; // response already sent

  // S14.2: a session established for one repository must not reach another
  // just because the same `Mcp-Session-Id` is replayed against a different
  // path — this is a per-call authorization refusal (a `ToolResult`, same
  // shape `dispatch()` itself returns for a missing capability), not a
  // transport-level `401`: the credential and the session are both good,
  // they are just being pointed at a resource neither was established for.
  if (session.repositoryBinding !== declarationIdValue) {
    const result = authorizationResult(`this session is bound to '${session.repositoryBinding}', not '${declarationIdValue}'`, []);
    sendJson(res, 403, jsonRpcResult(rpcId, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true }));
    return;
  }

  if (method === 'tools/list') {
    const declaration = await deps.declarations.get(declarationIdValue);
    const tools = deps.dispatchPipeline.visibleTools(session, declaration);
    sendJson(
      res,
      200,
      jsonRpcResult(rpcId, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }),
    );
    return;
  }

  if (method === 'tools/call') {
    const params = body.params as Record<string, unknown> | undefined;
    const toolName = params?.name;
    if (typeof toolName !== 'string') {
      sendJson(res, 400, jsonRpcError(rpcId, JSONRPC_INVALID_PARAMS, 'params.name is required'));
      return;
    }
    const controller = new AbortController();
    const result = await deps.dispatchPipeline.dispatch({
      toolName: toolName as never,
      input: (params?.arguments ?? {}) as never,
      session,
      declarationId: declarationIdValue,
      scheduledJobId: null,
      context: 'normal',
      signal: controller.signal,
    });
    sendJson(
      res,
      toolResultStatus(result.kind),
      jsonRpcResult(rpcId, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !result.ok,
      }),
    );
    return;
  }

  sendJson(res, 404, jsonRpcError(rpcId, JSONRPC_METHOD_NOT_FOUND, `unknown method '${method}'`));
}

/**
 * `20-contract.md` § L5 — surfaces (resolves U5). Returns `true` once a
 * route under this file's namespace has been handled — success or a named
 * failure — `false` only when the path matches nothing here, so the caller
 * falls through to its own 404.
 */
export async function handleMcpRoute(deps: McpRoutesDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (await handleWellKnown(deps, req, res, url)) return true;

  if (url.pathname === '/oauth/register') {
    await handleRegister(deps, req, res);
    return true;
  }
  if (url.pathname === '/oauth/authorize') {
    await handleAuthorize(deps, req, res, url);
    return true;
  }
  if (url.pathname === '/oauth/token') {
    await handleToken(deps, req, res);
    return true;
  }
  if (url.pathname === '/oauth/revoke') {
    await handleRevoke(deps, req, res);
    return true;
  }

  const mcpMatch = /^\/mcp\/([^/]+)$/.exec(url.pathname);
  if (mcpMatch) {
    await handleMcpTransport(deps, req, res, decodeURIComponent(mcpMatch[1]!));
    return true;
  }

  return false;
}
